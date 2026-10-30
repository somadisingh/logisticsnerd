"""Supplier cash accounts against real PostgreSQL: charges, payments, balances."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from threading import Barrier
from unittest import mock

import psycopg

from logistics_persistence import cash, core, purchasing as p, stock
from logistics_persistence.errors import Conflict, IdempotencyConflict, LogisticsError, ValidationError
from tests_postgres.common import PostgresCase


class CashTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.item = self.bind("item", "chair")
        self.location = self.bind("location", "warehouse")
        self.supplier = self.bind("supplier", "supplier-A", {"name": "Supplier A"})
        self.actor = self.bind("actor", "owner", {"can_approve_purchases": True})

    def purchase(self, quantity, price, *, pricing_kind="unit", supplier=None, currency="USD"):
        supplier = supplier or self.supplier
        key = self.key("demand")
        demand = core.register_demand(self.conn, external_key=key, order_ref="order-1", item_id=self.item,
            quantity=quantity, currency=currency, required_by=date.today() + timedelta(days=15),
            budget_minor=None, idempotency_key=key)["id"]
        quote = p.create_quote(self.conn, supplier_id=supplier, item_id=self.item, quantity_priced=quantity,
            capacity_quantity=quantity, price_minor=price, pricing_kind=pricing_kind, currency=currency,
            expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            expected_date=date.today() + timedelta(days=2), idempotency_key=self.key("quote"))
        po = p.create_purchase_order(self.conn, supplier_id=supplier, currency=currency, idempotency_key=self.key("po"))
        line = p.add_purchase_line(self.conn, purchase_order_id=po["id"], quote_version_id=quote["id"],
                                   quantity=quantity, idempotency_key=self.key("line"))
        allocation = p.allocate_purchase_line(self.conn, po_line_id=line["id"], demand_line_id=demand,
                                             quantity=quantity, idempotency_key=self.key("allocation"))
        p.approve_purchase_order(self.conn, purchase_order_id=po["id"], actor_id=self.actor,
                                 idempotency_key=self.key("approve"))
        return line, allocation

    def delivery_line(self, line, allocation, quantity):
        return dict(po_line_id=line["id"], item_id=self.item, location_id=self.location, quantity=quantity,
                    allocations=[dict(purchase_allocation_id=allocation["id"],
                                      demand_line_id=allocation["demand_line_id"], quantity=quantity)])

    def receive(self, line, allocation, quantity, *, key=None, ref=None):
        return stock.receive_delivery(self.conn, delivery_ref=ref or self.key("delivery"),
            lines=[self.delivery_line(line, allocation, quantity)],
            received_on=date.today(), idempotency_key=key or self.key("receive"))

    def charges(self, po_line_id=None):
        return [r["amount_minor"] for r in self.conn.execute(
            """SELECT amount_minor FROM logistics.money_ledger WHERE entry_type='supplier_charge'
               AND (%s::bigint IS NULL OR po_line_id=%s) ORDER BY id""", (po_line_id, po_line_id)).fetchall()]

    def ledger_count(self):
        return self.conn.execute("SELECT count(*) AS n FROM logistics.money_ledger").fetchone()["n"]

    def test_full_receipt_charges_the_frozen_line_total(self):
        line, allocation = self.purchase(4, 125)
        receipt = self.receive(line, allocation, 4)
        self.assertEqual(self.charges(line["id"]), [500])
        [charge] = receipt["supplier_charges"]
        self.assertEqual((charge["supplier_id"], charge["po_line_id"], charge["amount_minor"], charge["currency"]),
                         (self.supplier, line["id"], 500, "USD"))
        self.assertEqual(charge["receipt_line_id"], receipt["lines"][0]["receipt_line_id"])
        row = self.conn.execute("SELECT * FROM logistics.money_ledger WHERE id=%s", (charge["ledger_entry_id"],)).fetchone()
        self.assertEqual((row["request_key"], row["occurred_on"]), (
            self.conn.execute("SELECT request_key FROM logistics.receipts WHERE id=%s", (receipt["receipt_id"],)).fetchone()["request_key"],
            date.today()))

    def test_partial_receipts_add_up_exactly_to_an_uneven_line_total(self):
        line, allocation = self.purchase(3, 1000, pricing_kind="total")
        self.receive(line, allocation, 1)
        self.assertEqual(self.charges(line["id"]), [333])
        self.receive(line, allocation, 2)
        self.assertEqual(self.charges(line["id"]), [333, 667])
        self.assertEqual(sum(self.charges(line["id"])), 1000)

    def test_three_single_unit_receipts_round_cumulatively(self):
        line, allocation = self.purchase(3, 1000, pricing_kind="total")
        for _ in range(3):
            self.receive(line, allocation, 1)
        self.assertEqual(self.charges(line["id"]), [333, 333, 334])

    def test_one_charge_per_po_line_when_a_delivery_splits_a_line(self):
        line, allocation = self.purchase(3, 1000, pricing_kind="total")
        first = self.delivery_line(line, allocation, 1)
        second = self.delivery_line(line, allocation, 2)
        receipt = stock.receive_delivery(self.conn, delivery_ref="split", lines=[first, second],
                                         received_on=date.today(), idempotency_key="split")
        self.assertEqual(self.charges(line["id"]), [1000])
        self.assertEqual(receipt["supplier_charges"][0]["receipt_line_id"], receipt["lines"][1]["receipt_line_id"])

    def test_receive_retry_replays_without_a_second_charge_and_changed_content_fails(self):
        line, allocation = self.purchase(4, 125)
        first = self.receive(line, allocation, 2, key="receive-once", ref="delivery-once")
        self.assertEqual(self.receive(line, allocation, 2, key="receive-once", ref="delivery-once"), first)
        self.assertEqual(self.charges(), [250])
        with self.assertRaises(IdempotencyConflict):
            self.receive(line, allocation, 1, key="receive-once", ref="delivery-once")
        self.assertEqual(self.charges(), [250])

    def test_payment_retry_replays_without_duplicate_and_changed_content_fails(self):
        line, allocation = self.purchase(4, 125)
        self.receive(line, allocation, 4)
        first = cash.record_supplier_payment(self.conn, self.supplier, 200, date.today(), "pay-1")
        self.assertEqual(cash.record_supplier_payment(self.conn, self.supplier, 200, date.today(), "pay-1"), first)
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM logistics.supplier_payments").fetchone()["n"], 1)
        self.assertEqual(self.ledger_count(), 2)
        with self.assertRaises(IdempotencyConflict):
            cash.record_supplier_payment(self.conn, self.supplier, 201, date.today(), "pay-1")
        self.assertEqual(self.ledger_count(), 2)

    def test_failed_receipt_validation_leaves_no_money_rows(self):
        line, allocation = self.purchase(4, 125)
        with self.assertRaises(LogisticsError):
            self.receive(line, allocation, 5, key="too-many")
        self.assertEqual(self.ledger_count(), 0)
        self.assertIsNone(self.conn.execute("SELECT 1 FROM logistics.command_requests WHERE idempotency_key='too-many'").fetchone())

    def test_database_refuses_a_purchase_receipt_without_its_charge(self):
        line, allocation = self.purchase(4, 125)
        with mock.patch.object(stock, "record_receipt_charges", return_value=[]):
            with self.assertRaises(ValidationError):
                self.receive(line, allocation, 4, key="no-charge")
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM logistics.receipt_lines").fetchone()["n"], 0)
        self.assertIsNone(self.conn.execute("SELECT 1 FROM logistics.command_requests WHERE idempotency_key='no-charge'").fetchone())

    def test_currency_mismatch_rolls_back_stock_and_money(self):
        line, allocation = self.purchase(4, 125)
        self.conn.execute("INSERT INTO logistics.business_setup(business_name,currency) VALUES('Demo','EUR')")
        with self.assertRaisesRegex(ValidationError, "business currency EUR"):
            self.receive(line, allocation, 4, key="wrong-currency")
        self.assertEqual(self.ledger_count(), 0)
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM logistics.receipt_lines").fetchone()["n"], 0)
        self.assertEqual(stock.on_hand(self.conn, self.item, self.location), 0)

    def test_without_setup_the_ledger_keeps_one_currency(self):
        line, allocation = self.purchase(4, 125)
        self.receive(line, allocation, 4)
        eur_line, eur_allocation = self.purchase(2, 50, currency="EUR")
        with self.assertRaisesRegex(ValidationError, "business currency USD"):
            self.receive(eur_line, eur_allocation, 2)
        self.assertEqual(self.charges(), [500])
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.conn.execute("INSERT INTO logistics.business_setup(business_name,currency) VALUES('Demo','EUR')")
        self.conn.execute("INSERT INTO logistics.business_setup(business_name,currency) VALUES('Demo','USD')")
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.conn.execute("UPDATE logistics.business_setup SET currency='EUR'")

    def test_overpayment_is_rejected_and_exact_payment_settles(self):
        line, allocation = self.purchase(4, 125)
        with self.assertRaisesRegex(ValidationError, "exceeds the 0 owed"):
            cash.record_supplier_payment(self.conn, self.supplier, 1, date.today(), self.key("pay"))
        self.receive(line, allocation, 4)
        with self.assertRaisesRegex(ValidationError, "exceeds the 500 owed"):
            cash.record_supplier_payment(self.conn, self.supplier, 501, date.today(), self.key("pay"))
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM logistics.supplier_payments").fetchone()["n"], 0)
        paid = cash.record_supplier_payment(self.conn, self.supplier, 500, date.today(), self.key("pay"))
        self.assertEqual(paid["owed_after_minor"], 0)
        with self.assertRaises(ValidationError):
            cash.record_supplier_payment(self.conn, self.supplier, 1, date.today(), self.key("pay"))

    def test_concurrent_payments_cannot_overpay_together(self):
        line, allocation = self.purchase(4, 125)
        self.receive(line, allocation, 4)
        barrier = Barrier(2)

        def pay(n):
            with self.newconn() as conn:
                barrier.wait()
                try:
                    return cash.record_supplier_payment(conn, self.supplier, 300, date.today(), f"race-{n}")
                except ValidationError:
                    return None

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(pay, range(2)))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(cash.supplier_balances(self.conn)[0]["owed_minor"], 200)

    def test_ledger_and_payment_rows_cannot_be_updated_or_deleted(self):
        line, allocation = self.purchase(4, 125)
        self.receive(line, allocation, 4)
        cash.record_supplier_payment(self.conn, self.supplier, 100, date.today(), "pay")
        for sql in ("UPDATE logistics.money_ledger SET amount_minor=1",
                    "DELETE FROM logistics.money_ledger",
                    "UPDATE logistics.supplier_payments SET amount_minor=1",
                    "DELETE FROM logistics.supplier_payments"):
            with self.subTest(sql=sql), self.assertRaises(psycopg.errors.CheckViolation):
                self.conn.execute(sql)
        self.assertEqual(self.ledger_count(), 2)

    def test_direct_sql_charge_must_follow_the_line_total(self):
        line, allocation = self.purchase(4, 125)
        receipt = self.receive(line, allocation, 2)
        args = (self.supplier, line["id"], receipt["lines"][0]["receipt_line_id"],
                self.conn.execute("SELECT request_key FROM logistics.receipts WHERE id=%s", (receipt["receipt_id"],)).fetchone()["request_key"])
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.conn.execute("""INSERT INTO logistics.money_ledger
                (entry_type,supplier_id,amount_minor,currency,occurred_on,po_line_id,receipt_line_id,request_key)
                VALUES('supplier_charge',%s,999,'USD',CURRENT_DATE,%s,%s,%s)""", args)

    def test_balances_after_payment_follow_supplier_revisions(self):
        line, allocation = self.purchase(4, 125)
        other = self.bind("supplier", "supplier-B", {"name": "Supplier B"})
        other_line, other_allocation = self.purchase(2, 300, supplier=other)
        self.receive(line, allocation, 4)
        self.receive(other_line, other_allocation, 1)
        # A supplier edit creates a new revision; its account continues.
        revised = core.bind_reference(self.conn, "supplier", "supplier-A", {"name": "Supplier A Ltd"}, self.key("bind"))["id"]
        cash.record_supplier_payment(self.conn, revised, 120, "2026-10-30", self.key("pay"))
        self.assertEqual(cash.supplier_balances(self.conn), [
            dict(supplier_id=revised, supplier_key="supplier-A", name="Supplier A Ltd", currency="USD",
                 charged_minor=500, paid_minor=120, owed_minor=380),
            dict(supplier_id=other, supplier_key="supplier-B", name="Supplier B", currency="USD",
                 charged_minor=300, paid_minor=0, owed_minor=300)])
        self.assertEqual(cash.cash_balance(self.conn), dict(currency="USD", opening_minor=0, opened_on=None,
                                                            paid_out_minor=120, balance_minor=-120))

    def test_opening_cash_minus_payments_is_the_cash_balance(self):
        self.conn.execute("INSERT INTO logistics.business_setup(business_name,currency) VALUES('Demo','USD')")
        opening = cash.record_opening_cash(self.conn, 10000, "2026-10-01", "opening")
        self.assertEqual((opening["amount_minor"], opening["currency"], opening["as_of"]), (10000, "USD", "2026-10-01"))
        line, allocation = self.purchase(4, 125)
        self.receive(line, allocation, 4)
        cash.record_supplier_payment(self.conn, self.supplier, 300, date.today(), self.key("pay"))
        self.assertEqual(cash.cash_balance(self.conn), dict(currency="USD", opening_minor=10000, opened_on="2026-10-01",
                                                            paid_out_minor=300, balance_minor=9700))
        # Opening cash is not a supplier account.
        self.assertEqual([row["supplier_key"] for row in cash.supplier_balances(self.conn)], ["supplier-A"])

    def test_opening_cash_is_recorded_once_and_replays_its_key(self):
        self.conn.execute("INSERT INTO logistics.business_setup(business_name,currency) VALUES('Demo','EUR')")
        first = cash.record_opening_cash(self.conn, 5000, date(2026, 10, 1), "opening")
        self.assertEqual(first["currency"], "EUR")
        self.assertEqual(cash.record_opening_cash(self.conn, 5000, "2026-10-01", "opening"), first)
        with self.assertRaises(IdempotencyConflict):
            cash.record_opening_cash(self.conn, 6000, "2026-10-01", "opening")
        with self.assertRaisesRegex(Conflict, "already been recorded"):
            cash.record_opening_cash(self.conn, 6000, "2026-10-01", "opening-again")
        with self.assertRaises(psycopg.errors.UniqueViolation):
            self.conn.execute("""INSERT INTO logistics.money_ledger(entry_type,amount_minor,currency,occurred_on,request_key)
                VALUES('opening_cash',1,'EUR','2026-10-01','opening')""")
        self.assertEqual(cash.cash_balance(self.conn)["opening_minor"], 5000)
        for sql in ("UPDATE logistics.money_ledger SET amount_minor=1", "DELETE FROM logistics.money_ledger"):
            with self.subTest(sql=sql), self.assertRaises(psycopg.errors.CheckViolation):
                self.conn.execute(sql)

    def test_opening_cash_follows_the_currency_rule(self):
        with self.assertRaisesRegex(ValidationError, "business currency"):
            cash.record_opening_cash(self.conn, 5000, "2026-10-01", "no-currency")
        self.assertEqual(self.ledger_count(), 0)
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.conn.execute("""INSERT INTO logistics.money_ledger(entry_type,amount_minor,currency,occurred_on,request_key)
                VALUES('opening_cash',1,'USD','2026-10-01','direct')""")
        # Before setup, the currency of earlier money is the business currency.
        line, allocation = self.purchase(4, 125)
        self.receive(line, allocation, 4)
        self.assertEqual(cash.record_opening_cash(self.conn, 0, "2026-10-01", "opening")["currency"], "USD")
        for bad in (-1, True, 1.5):
            with self.subTest(amount=bad), self.assertRaises(ValidationError):
                cash.record_opening_cash(self.conn, bad, "2026-10-01", self.key("opening"))
