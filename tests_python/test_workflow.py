"""Deterministic standalone rules tests; no database, network, or model calls.

The threaded checks exercise only the in-memory adapter's process-local lock.
They do not establish transaction or concurrency guarantees for a database.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
import unittest

from logistics_rules.repository import InMemoryRepository
from logistics_rules.selection import Quote
from logistics_rules.workflow import LineRequest, RuleViolation, Workflow


NOW = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
DEADLINE = date(2026, 11, 1)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.repo = InMemoryRepository()
        self.repo.seed_company(
            "A", currency="USD", item_ids=("item", "other-item"),
            customer_ids=("customer",), supplier_ids=("X", "Y", "Z"),
            owner_ids=("owner",), stock={"item": 6, "other-item": 3},
        )
        self.repo.seed_company(
            "B", currency="USD", item_ids=("B-item",),
            customer_ids=("B-customer",), supplier_ids=("B-supplier",),
            owner_ids=("B-owner",), stock={"B-item": 100},
        )
        self.rules = Workflow(self.repo, clock=lambda: self.now)

    def order(self, quantity=15, *, order_id="order", budget=2000, lines=None):
        return self.rules.create_order(
            "A", order_id, "customer",
            lines or (LineRequest("item", quantity, DEADLINE,
                                  maximum_budget_cents=budget, priority="normal"),),
            key=f"create-{order_id}",
        )

    def quote(self, quote_id="qx", *, supplier="X", capacity=7, priced=None,
              price=100, currency="USD", source="synthetic", line_id="order:1",
              expires_at=None, expected_date=DEADLINE, pricing_kind="unit",
              business_id="A"):
        return Quote(
            id=quote_id, business_id=business_id, line_id=line_id,
            supplier_id=supplier, capacity_quantity=capacity,
            quantity_priced=capacity if priced is None else priced,
            price_cents=price, pricing_kind=pricing_kind, currency=currency,
            source=source, generated_at=NOW,
            expires_at=expires_at or NOW + timedelta(days=7),
            expected_date=expected_date,
        )

    def store_quote(self, quote=None, **kwargs):
        quote = quote or self.quote(**kwargs)
        self.rules.add_quote("A", quote, key=f"quote-{quote.id}")
        return quote

    def shortage_scenario(self):
        self.order(2, order_id="other-order")
        self.rules.reserve("A", "other-order", key="reserve-other")
        order = self.order()
        self.rules.reserve("A", "order", key="reserve-order")
        return order

    def split_approval(self):
        self.shortage_scenario()
        self.store_quote()
        self.store_quote(quote_id="qy", supplier="Y", capacity=4, price=120)
        return self.rules.approve(
            "A", "order:1", selections=(("qx", 7), ("qy", 4)),
            owner_id="owner", approval_id="approval", key="approve",
        )

    def received_order(self):
        purchases = self.split_approval()
        for index, purchase in enumerate(purchases):
            self.rules.receive("A", purchase.id, key=f"receive-{index}")
        return purchases

    def test_identical_duplicate_items_merge_quantity_and_keep_one_budget(self):
        order = self.order(lines=(
            LineRequest("item", 5, DEADLINE, maximum_budget_cents=2000,
                        priority="normal"),
            LineRequest("item", 10, DEADLINE, maximum_budget_cents=2000,
                        priority="normal"),
        ))
        self.assertEqual(len(order.line_ids), 1)
        line = self.rules.get_line("A", order.line_ids[0])
        self.assertEqual(line.quantity, 15)
        self.assertEqual(line.maximum_budget_cents, 2000)

    def test_duplicate_items_with_incompatible_constraints_are_rejected(self):
        incompatible = (
            LineRequest("item", 1, DEADLINE + timedelta(days=1),
                        maximum_budget_cents=2000, priority="normal"),
            LineRequest("item", 1, DEADLINE, maximum_budget_cents=1999,
                        priority="normal"),
            LineRequest("item", 1, DEADLINE, maximum_budget_cents=2000,
                        priority="urgent"),
        )
        for index, other in enumerate(incompatible):
            with self.subTest(constraint=index), self.assertRaises(RuleViolation):
                self.order(order_id=f"bad-{index}", lines=(
                    LineRequest("item", 1, DEADLINE, maximum_budget_cents=2000,
                                priority="normal"), other,
                ))

    def test_multi_line_order_reserves_each_item_and_waits_for_every_line(self):
        order = self.order(lines=(
            LineRequest("item", 8, DEADLINE, maximum_budget_cents=2000),
            LineRequest("other-item", 2, DEADLINE, maximum_budget_cents=2000),
        ))
        self.rules.reserve("A", order.id, key="reserve")
        self.assertEqual(len(order.line_ids), 2)
        self.assertEqual(self.rules.shortage("A", order.line_ids[0]).quantity_to_purchase, 2)
        self.assertEqual(self.rules.shortage("A", order.line_ids[1]).quantity_to_purchase, 0)
        self.assertEqual(self.rules.stock("A", "item").reserved, 6)
        self.assertEqual(self.rules.stock("A", "other-item").reserved, 2)
        with self.assertRaises(RuleViolation):
            self.rules.fulfill("A", order.id, key="too-early")
        self.assertIsNone(self.rules.get_order("A", order.id).fulfilled_at)

    def test_requested_demo_initial_shortage_accounts_for_other_reservation(self):
        self.shortage_scenario()
        shortage = self.rules.shortage("A", "order:1")
        self.assertEqual((shortage.demand, shortage.reserved,
                          shortage.original_shortage, shortage.physical_shortage,
                          shortage.approved_inbound, shortage.quantity_to_purchase),
                         (15, 4, 11, 11, 0, 11))
        self.assertEqual(self.rules.stock("A", "item").on_hand, 6)
        self.assertEqual(self.rules.stock("A", "item").available, 0)

    def test_competing_reservations_never_allocate_the_same_stock(self):
        self.order(5, order_id="one")
        self.order(5, order_id="two")
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(self.rules.reserve, "A", order_id,
                                       key=f"reserve-{order_id}")
                       for order_id in ("one", "two")]
            for future in futures:
                future.result()
        reserved = [self.rules.shortage("A", f"{order_id}:1").reserved
                    for order_id in ("one", "two")]
        self.assertEqual(sorted(reserved), [1, 5])
        self.assertEqual(self.rules.stock("A", "item").reserved, 6)
        self.assertEqual(self.rules.stock("A", "item").available, 0)

    def test_repeated_shortage_queries_and_reservations_do_not_change_demand(self):
        self.shortage_scenario()
        original = self.rules.shortage("A", "order:1")
        for index in range(5):
            self.assertEqual(self.rules.shortage("A", "order:1"), original)
            self.rules.reserve("A", "order", key=f"reserve-again-{index}")
            self.assertEqual(self.rules.shortage("A", "order:1"), original)

    def test_inbound_is_assigned_once_and_remaining_purchase_is_not_original_shortage(self):
        self.shortage_scenario()
        self.store_quote()
        purchase, = self.rules.approve(
            "A", "order:1", selections=(("qx", 7),), owner_id="owner",
            approval_id="first", key="first-approval",
        )
        for index in range(3):
            self.rules.reserve("A", "order", key=f"reserve-inbound-{index}")
            shortage = self.rules.shortage("A", "order:1")
            self.assertEqual((shortage.original_shortage, shortage.approved_inbound,
                              shortage.quantity_to_purchase), (11, 7, 4))
        self.rules.receive("A", purchase.id, key="receive")
        shortage = self.rules.shortage("A", "order:1")
        self.assertEqual((shortage.reserved, shortage.physical_shortage,
                          shortage.approved_inbound, shortage.quantity_to_purchase),
                         (11, 4, 0, 4))

    def test_recommendation_does_not_create_a_purchase_or_change_stock(self):
        self.shortage_scenario()
        self.store_quote()
        self.store_quote(quote_id="qy", supplier="Y", capacity=4, price=120)
        stock = self.rules.stock("A", "item")
        recommendation = self.rules.recommend("A", "order:1")
        self.assertIsNotNone(recommendation)
        self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 0)
        self.assertEqual(self.rules.stock("A", "item"), stock)
        with self.assertRaises(RuleViolation):
            self.rules.get_po("A", "approval:1")

    def test_split_sourcing_approves_shortage_no_single_supplier_can_cover(self):
        purchases = self.split_approval()
        self.assertEqual([purchase.quantity for purchase in purchases], [7, 4])
        self.assertEqual(sum(purchase.total_cents for purchase in purchases), 1180)
        self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 11)
        self.assertEqual(self.rules.shortage("A", "order:1").quantity_to_purchase, 0)

    def test_approval_records_owner_and_frozen_terms_and_changes_no_stock(self):
        purchases = self.split_approval()
        self.assertEqual(self.rules.stock("A", "item").on_hand, 6)
        self.assertEqual(self.rules.stock("A", "item").reserved, 6)
        for purchase in purchases:
            self.assertEqual(purchase.approver_id, "owner")
            self.assertEqual(purchase.approved_at, NOW)
            self.assertEqual(purchase.currency, "USD")
            self.assertEqual(purchase.status, "approved")
            self.assertIsNone(purchase.received_at)
            self.assertEqual(purchase.quote_snapshot.source, "synthetic")

    def test_approval_requires_an_authorized_owner(self):
        self.shortage_scenario()
        self.store_quote()
        for owner in ("", "unknown", "B-owner"):
            with self.subTest(owner=owner), self.assertRaises(RuleViolation):
                self.rules.approve(
                    "A", "order:1", selections=(("qx", 7),), owner_id=owner,
                    approval_id=f"bad-{owner}", key=f"bad-{owner}",
                )
        self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 0)

    def test_approval_revalidates_remaining_shortage_and_supplier_capacity(self):
        self.shortage_scenario()
        self.store_quote()
        self.store_quote(quote_id="qy", supplier="Y", capacity=5, price=120)
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qx", 8),), owner_id="owner",
                approval_id="over-capacity", key="over-capacity",
            )
        self.rules.approve(
            "A", "order:1", selections=(("qx", 7),), owner_id="owner",
            approval_id="first", key="first",
        )
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qy", 5),), owner_id="owner",
                approval_id="over-demand", key="over-demand",
            )
        self.assertEqual(self.rules.shortage("A", "order:1").quantity_to_purchase, 4)

    def test_quote_expiry_is_rechecked_when_approval_happens(self):
        self.shortage_scenario()
        self.store_quote(expires_at=NOW + timedelta(minutes=1))
        self.now = NOW + timedelta(minutes=2)
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qx", 7),), owner_id="owner",
                approval_id="expired", key="expired",
            )
        self.assertEqual(self.rules.stock("A", "item").on_hand, 6)

    def test_late_delivery_and_over_budget_prices_are_rejected(self):
        for name, changes in (
            ("late", {"expected_date": DEADLINE + timedelta(days=1)}),
            ("expensive", {"price": 1000}),
        ):
            with self.subTest(name=name):
                self.setUp()
                self.shortage_scenario()
                self.store_quote(**changes)
                with self.assertRaises(RuleViolation):
                    self.rules.approve(
                        "A", "order:1", selections=(("qx", 7),),
                        owner_id="owner", approval_id=name, key=name,
                    )
                self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 0)

    def test_line_budget_caps_combined_purchases_including_earlier_approvals(self):
        self.order(2, order_id="other-order")
        self.rules.reserve("A", "other-order", key="other-reserve")
        self.order(budget=1000)
        self.rules.reserve("A", "order", key="reserve")
        self.store_quote()
        self.store_quote(quote_id="qy", supplier="Y", capacity=4, price=120)
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qx", 7), ("qy", 4)),
                owner_id="owner", approval_id="combined", key="combined",
            )
        self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 0)
        self.rules.approve(
            "A", "order:1", selections=(("qx", 7),), owner_id="owner",
            approval_id="first", key="first",
        )
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qy", 4),), owner_id="owner",
                approval_id="second", key="second",
            )

    def test_mixed_currency_quotes_cannot_be_purchased(self):
        self.shortage_scenario()
        quote = self.quote(currency="EUR")
        try:
            self.rules.add_quote("A", quote, key="euro-quote")
        except RuleViolation:
            pass  # Rejecting the foreign quote on entry is also a valid boundary.
        else:
            with self.assertRaises(RuleViolation):
                self.rules.approve(
                    "A", "order:1", selections=(("qx", 7),), owner_id="owner",
                    approval_id="euro", key="euro",
                )
        self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 0)

    def test_supplier_capacity_quantity_priced_and_quantity_purchased_are_distinct(self):
        self.shortage_scenario()
        quote = self.store_quote(capacity=10, priced=7)
        purchase, = self.rules.approve(
            "A", "order:1", selections=(("qx", 5),), owner_id="owner",
            approval_id="quantity-example", key="quantity-example",
        )
        self.assertEqual((quote.capacity_quantity, quote.quantity_priced,
                          purchase.quantity), (10, 7, 5))
        self.assertEqual(purchase.total_cents, 500)

    def test_total_price_cannot_be_silently_prorated_to_another_quantity(self):
        self.shortage_scenario()
        self.store_quote(priced=7, price=700, pricing_kind="total")
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qx", 5),), owner_id="owner",
                approval_id="prorated", key="prorated",
            )

    def test_ai_generated_quote_remains_labeled_an_estimate_in_approved_terms(self):
        self.shortage_scenario()
        quote = self.store_quote(source="ai_estimate")
        self.assertTrue(quote.estimated)
        purchase, = self.rules.approve(
            "A", "order:1", selections=(("qx", 7),), owner_id="owner",
            approval_id="estimate", key="estimate",
        )
        self.assertEqual(purchase.quote_snapshot.source, "ai_estimate")
        self.assertTrue(purchase.quote_snapshot.estimated)

    def test_approved_terms_survive_quote_expiry_and_quote_overwrite_is_rejected(self):
        purchases = self.split_approval()
        original = purchases[0]
        self.now = NOW + timedelta(days=30)
        changed = replace(original.quote_snapshot, price_cents=99999)
        with self.assertRaises(RuleViolation):
            self.rules.add_quote("A", changed, key="replace-quote")
        received = self.rules.receive("A", original.id, key="receive-expired")
        self.assertEqual((received.quantity, received.total_cents,
                          received.currency, received.quote_snapshot),
                         (original.quantity, original.total_cents,
                          original.currency, original.quote_snapshot))

    def test_receiving_one_supplier_does_not_complete_other_purchase_or_order(self):
        first, second = self.split_approval()
        self.rules.receive("A", first.id, key="receive-first")
        self.assertEqual(self.rules.stock("A", "item").on_hand, 13)
        self.assertEqual(self.rules.shortage("A", "order:1").reserved, 11)
        self.assertEqual(self.rules.get_po("A", second.id).status, "approved")
        self.assertIsNone(self.rules.get_po("A", second.id).received_at)
        self.assertNotEqual(self.rules.get_order("A", "order").status, "ready")
        self.assertIsNone(self.rules.get_order("A", "order").fulfilled_at)
        with self.assertRaises(RuleViolation):
            self.rules.fulfill("A", "order", key="early")

    def test_full_receipt_then_fulfillment_preserves_other_order_reservations(self):
        self.received_order()
        self.assertEqual(self.rules.get_order("A", "order").status, "ready")
        self.assertEqual(self.rules.stock("A", "item").on_hand, 17)
        self.assertEqual(self.rules.stock("A", "item").reserved, 17)
        order = self.rules.fulfill("A", "order", key="fulfill")
        self.assertEqual(order.status, "fulfilled")
        self.assertEqual(order.fulfilled_at, NOW)
        stock = self.rules.stock("A", "item")
        self.assertEqual((stock.on_hand, stock.reserved, stock.available), (2, 2, 0))
        self.assertEqual(self.rules.shortage("A", "other-order:1").reserved, 2)

    def test_identical_operation_keys_return_original_results(self):
        first, second = self.split_approval()
        approval = self.rules.approve(
            "A", "order:1", selections=(("qx", 7), ("qy", 4)),
            owner_id="owner", approval_id="approval", key="approve",
        )
        self.assertEqual(approval, (first, second))
        result = self.rules.receive("A", first.id, key="receive-first")
        self.assertEqual(self.rules.receive("A", first.id, key="receive-first"), result)
        self.rules.receive("A", second.id, key="receive-second")
        fulfilled = self.rules.fulfill("A", "order", key="fulfill")
        self.assertEqual(self.rules.fulfill("A", "order", key="fulfill"), fulfilled)
        self.assertEqual(self.rules.stock("A", "item").on_hand, 2)

    def test_reused_operation_key_with_another_payload_fails(self):
        self.order(2, order_id="one")
        self.order(2, order_id="two")
        self.rules.reserve("A", "one", key="same-key")
        with self.assertRaises(RuleViolation):
            self.rules.reserve("A", "two", key="same-key")
        self.assertEqual(self.rules.shortage("A", "two:1").reserved, 0)

    def test_same_business_events_with_different_keys_are_rejected_without_mutation(self):
        first, second = self.split_approval()
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qx", 7), ("qy", 4)),
                owner_id="owner", approval_id="approval", key="different-approval-key",
            )
        self.rules.receive("A", first.id, key="receive-first")
        stock = self.rules.stock("A", "item")
        with self.assertRaises(RuleViolation):
            self.rules.receive("A", first.id, key="different-receipt-key")
        self.assertEqual(self.rules.stock("A", "item"), stock)
        self.rules.receive("A", second.id, key="receive-second")
        self.rules.fulfill("A", "order", key="fulfill")
        stock = self.rules.stock("A", "item")
        with self.assertRaises(RuleViolation):
            self.rules.fulfill("A", "order", key="different-fulfillment-key")
        self.assertEqual(self.rules.stock("A", "item"), stock)

    def test_competing_approvals_cannot_purchase_more_than_remaining_shortage(self):
        self.shortage_scenario()
        self.store_quote(capacity=11)
        self.store_quote(quote_id="qy", supplier="Y", capacity=11, price=100)

        def approve(quote_id):
            try:
                return self.rules.approve(
                    "A", "order:1", selections=((quote_id, 11),),
                    owner_id="owner", approval_id=quote_id, key=f"approve-{quote_id}",
                )
            except RuleViolation:
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(approve, ("qx", "qy")))
        self.assertEqual(sum(outcome is not None for outcome in outcomes), 1)
        self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 11)
        self.assertEqual(self.rules.stock("A", "item").on_hand, 6)

    def test_competing_receipts_of_one_purchase_apply_only_once(self):
        first, _ = self.split_approval()

        def receive(key):
            try:
                return self.rules.receive("A", first.id, key=key)
            except RuleViolation:
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(receive, ("one", "two")))
        self.assertEqual(sum(outcome is not None for outcome in outcomes), 1)
        self.assertEqual(self.rules.stock("A", "item").on_hand, 13)

    def test_partial_receipts_and_shipments_are_explicitly_rejected(self):
        first, second = self.split_approval()
        with self.assertRaises(RuleViolation):
            self.rules.receive("A", first.id, quantity=3, key="partial-receipt")
        self.assertEqual(self.rules.stock("A", "item").on_hand, 6)
        # Failed operations have no successful stored result, so the key can retry.
        self.rules.receive("A", first.id, key="partial-receipt")
        self.rules.receive("A", second.id, key="second-receipt")
        with self.assertRaises(RuleViolation):
            self.rules.fulfill("A", "order", quantity=10, key="partial-shipment")
        self.assertEqual(self.rules.stock("A", "item").on_hand, 17)
        self.rules.fulfill("A", "order", key="partial-shipment")
        self.assertEqual(self.rules.stock("A", "item").on_hand, 2)

    def test_unsupported_lifecycle_actions_and_reserving_completed_orders_fail(self):
        self.received_order()
        for action in ("cancel", "return", "transfer", "partial_receive", "partial_ship"):
            with self.subTest(action=action), self.assertRaises(RuleViolation):
                self.rules.transition("A", "order", action=action, key=f"bad-{action}")
        self.rules.fulfill("A", "order", key="fulfill")
        with self.assertRaises(RuleViolation):
            self.rules.reserve("A", "order", key="reserve-after-completion")

    def test_cross_company_reads_and_actions_are_rejected(self):
        first, _ = self.split_approval()
        operations = (
            lambda: self.rules.get_order("B", "order"),
            lambda: self.rules.get_line("B", "order:1"),
            lambda: self.rules.get_po("B", first.id),
            lambda: self.rules.stock("B", "item"),
            lambda: self.rules.shortage("B", "order:1"),
            lambda: self.rules.reserve("B", "order", key="B-reserve"),
            lambda: self.rules.recommend("B", "order:1"),
            lambda: self.rules.approve("B", "order:1", selections=(("qx", 7),),
                                       owner_id="B-owner", approval_id="B-approval",
                                       key="B-approval"),
            lambda: self.rules.receive("B", first.id, key="B-receive"),
            lambda: self.rules.fulfill("B", "order", key="B-fulfill"),
        )
        for index, operation in enumerate(operations):
            with self.subTest(operation=index), self.assertRaises(RuleViolation):
                operation()
        self.assertEqual(self.rules.stock("A", "item").on_hand, 6)

    def test_cross_company_customer_item_supplier_quote_and_line_links_fail(self):
        with self.assertRaises(RuleViolation):
            self.rules.create_order(
                "A", "bad-customer", "B-customer",
                (LineRequest("item", 1, DEADLINE),), key="bad-customer",
            )
        with self.assertRaises(RuleViolation):
            self.order(order_id="bad-item", lines=(LineRequest("B-item", 1, DEADLINE),))
        self.shortage_scenario()
        invalid_quotes = (
            self.quote(quote_id="wrong-company", business_id="B"),
            self.quote(quote_id="wrong-supplier", supplier="B-supplier"),
            self.quote(quote_id="wrong-line", line_id="missing-line"),
        )
        for quote in invalid_quotes:
            with self.subTest(quote=quote.id), self.assertRaises(RuleViolation):
                self.rules.add_quote("A", quote, key=quote.id)

    def test_quote_for_another_order_line_cannot_be_selected(self):
        self.shortage_scenario()
        self.order(10, order_id="another")
        self.store_quote(line_id="another:1")
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qx", 7),), owner_id="owner",
                approval_id="wrong-line", key="wrong-line",
            )

    def test_nonpositive_quantities_are_rejected(self):
        for quantity in (0, -1):
            with self.subTest(quantity=quantity), self.assertRaises((RuleViolation, ValueError)):
                self.order(quantity, order_id=f"bad-{quantity}")
        self.shortage_scenario()
        self.store_quote()
        for quantity in (0, -1):
            with self.subTest(purchase=quantity), self.assertRaises(RuleViolation):
                self.rules.approve(
                    "A", "order:1", selections=(("qx", quantity),), owner_id="owner",
                    approval_id=f"bad-purchase-{quantity}", key=f"bad-purchase-{quantity}",
                )

    def test_create_replay_distinguishes_integer_quantity_from_bool_and_float(self):
        original = self.rules.create_order(
            "A", "typed-order", "customer", (LineRequest("item", 1, DEADLINE),),
            key="typed-create",
        )
        for changed_quantity in (True, 1.0):
            with self.subTest(type=type(changed_quantity).__name__), self.assertRaises(RuleViolation):
                self.rules.create_order(
                    "A", "typed-order", "customer",
                    (LineRequest("item", changed_quantity, DEADLINE),),
                    key="typed-create",
                )
        self.assertEqual(self.rules.get_order("A", "typed-order"), original)
        self.assertEqual(self.rules.get_line("A", "typed-order:1").quantity, 1)

    def test_approval_and_receipt_replay_distinguish_integer_bool_and_float(self):
        self.order(7)
        self.rules.reserve("A", "order", key="reserve")
        self.store_quote(capacity=1)
        original_approval = self.rules.approve(
            "A", "order:1", selections=(("qx", 1),), owner_id="owner",
            approval_id="typed-approval", key="typed-approve",
        )
        for changed_quantity in (True, 1.0):
            with self.subTest(command="approve", type=type(changed_quantity).__name__), self.assertRaises(RuleViolation):
                self.rules.approve(
                    "A", "order:1", selections=(("qx", changed_quantity),),
                    owner_id="owner", approval_id="typed-approval", key="typed-approve",
                )
        purchase, = original_approval
        original_receipt = self.rules.receive("A", purchase.id, quantity=1, key="typed-receive")
        for changed_quantity in (True, 1.0):
            with self.subTest(command="receive", type=type(changed_quantity).__name__), self.assertRaises(RuleViolation):
                self.rules.receive("A", purchase.id, quantity=changed_quantity, key="typed-receive")
        self.assertEqual(self.rules.get_po("A", purchase.id), original_receipt)
        self.assertEqual(self.rules.stock("A", "item").on_hand, 7)

    def test_multi_item_fulfillment_after_receipts_preserves_other_reservation(self):
        self.order(2, order_id="other-order")
        self.rules.reserve("A", "other-order", key="reserve-other")
        order = self.order(lines=(
            LineRequest("item", 6, DEADLINE, maximum_budget_cents=1000),
            LineRequest("other-item", 5, DEADLINE, maximum_budget_cents=1000),
        ))
        self.rules.reserve("A", order.id, key="reserve")
        self.assertEqual([self.rules.shortage("A", line_id).quantity_to_purchase
                          for line_id in order.line_ids], [2, 2])
        self.store_quote(quote_id="item-quote", capacity=2, line_id=order.line_ids[0])
        self.store_quote(quote_id="other-item-quote", supplier="Y", capacity=2,
                         line_id=order.line_ids[1])
        purchases = []
        for index, (line_id, quote_id) in enumerate(zip(order.line_ids, ("item-quote", "other-item-quote"))):
            purchase, = self.rules.approve(
                "A", line_id, selections=((quote_id, 2),), owner_id="owner",
                approval_id=f"multi-approval-{index}", key=f"multi-approve-{index}",
            )
            purchases.append(purchase)
        self.rules.receive("A", purchases[0].id, key="receive-first-item")
        with self.assertRaises(RuleViolation):
            self.rules.fulfill("A", order.id, key="multi-too-early")
        self.rules.receive("A", purchases[1].id, key="receive-second-item")
        self.assertEqual(self.rules.get_order("A", order.id).status, "ready")
        completed = self.rules.fulfill("A", order.id, key="multi-fulfill")
        self.assertEqual(completed.status, "fulfilled")
        first_stock = self.rules.stock("A", "item")
        other_stock = self.rules.stock("A", "other-item")
        self.assertEqual((first_stock.on_hand, first_stock.reserved, first_stock.available), (2, 2, 0))
        self.assertEqual((other_stock.on_hand, other_stock.reserved, other_stock.available), (0, 0, 0))
        self.assertEqual(self.rules.shortage("A", "other-order:1").reserved, 2)
        self.assertTrue(all(self.rules.get_line("A", line_id).reserved_quantity == 0
                            for line_id in order.line_ids))

    def test_competing_fulfillments_deduct_stock_once(self):
        self.received_order()

        def fulfill(key):
            try:
                return self.rules.fulfill("A", "order", key=key)
            except RuleViolation:
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(fulfill, ("first-fulfillment", "second-fulfillment")))
        self.assertEqual(sum(outcome is not None for outcome in outcomes), 1)
        stock = self.rules.stock("A", "item")
        self.assertEqual((stock.on_hand, stock.reserved, stock.available), (2, 2, 0))
        self.assertEqual(self.rules.get_order("A", "order").status, "fulfilled")

    def test_receipt_late_failure_rolls_back_stock_reservation_lifecycle_and_key(self):
        first, _ = self.split_approval()
        before = (
            self.rules.stock("A", "item"), self.rules.get_line("A", "order:1"),
            self.rules.get_order("A", "order"), self.rules.get_po("A", first.id),
        )

        def failed_clock():
            raise RuntimeError("Injected clock failure after receipt candidate stock update")

        self.rules.clock = failed_clock
        with self.assertRaisesRegex(RuntimeError, "Injected clock failure"):
            self.rules.receive("A", first.id, key="retry-receipt")
        after = (
            self.rules.stock("A", "item"), self.rules.get_line("A", "order:1"),
            self.rules.get_order("A", "order"), self.rules.get_po("A", first.id),
        )
        self.assertEqual(after, before)
        self.assertFalse(self.repo.read("A", lambda state: "retry-receipt" in state.operations))
        self.rules.clock = lambda: self.now
        received = self.rules.receive("A", first.id, key="retry-receipt")
        self.assertEqual(received.status, "received")
        self.assertEqual(self.rules.stock("A", "item").on_hand, 13)

    def test_fulfillment_late_failure_rolls_back_all_items_lifecycle_and_key(self):
        order = self.order(lines=(LineRequest("item", 2, DEADLINE),
                                  LineRequest("other-item", 2, DEADLINE)))
        self.rules.reserve("A", order.id, key="reserve")

        def snapshot():
            return (
                self.rules.stock("A", "item"), self.rules.stock("A", "other-item"),
                *(self.rules.get_line("A", line_id) for line_id in order.line_ids),
                self.rules.get_order("A", order.id),
            )

        before = snapshot()

        def failed_clock():
            raise RuntimeError("Injected clock failure after all candidate stock deductions")

        self.rules.clock = failed_clock
        with self.assertRaisesRegex(RuntimeError, "Injected clock failure"):
            self.rules.fulfill("A", order.id, key="retry-fulfillment")
        self.assertEqual(snapshot(), before)
        self.assertFalse(self.repo.read("A", lambda state: "retry-fulfillment" in state.operations))
        self.rules.clock = lambda: self.now
        completed = self.rules.fulfill("A", order.id, key="retry-fulfillment")
        self.assertEqual(completed.status, "fulfilled")
        self.assertEqual(self.rules.stock("A", "item").on_hand, 4)
        self.assertEqual(self.rules.stock("A", "other-item").on_hand, 1)

    def test_approval_revalidates_delivery_date_after_time_advances_before_expiry(self):
        self.shortage_scenario()
        self.store_quote(capacity=11, expected_date=date(2026, 10, 22),
                         expires_at=NOW + timedelta(days=7))
        self.assertTrue(self.rules.recommend("A", "order:1").feasible)
        self.now = NOW + timedelta(days=2)
        with self.assertRaises(RuleViolation):
            self.rules.approve(
                "A", "order:1", selections=(("qx", 11),), owner_id="owner",
                approval_id="stale-delivery", key="stale-delivery",
            )
        self.assertEqual(self.rules.shortage("A", "order:1").approved_inbound, 0)
        self.assertEqual(self.rules.stock("A", "item").on_hand, 6)


if __name__ == "__main__":
    unittest.main()
