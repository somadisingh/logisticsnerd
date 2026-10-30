"""Minimal supplier cash accounts: one currency, append-only money events.

Supplier charges are written by stock.receive_delivery inside its own command
transaction; payments and the one-time opening cash use the shared request
registry. Balances are derived
from money_ledger, never stored. Database triggers repeat every amount,
currency and overpayment rule for direct SQL writes.
"""
from __future__ import annotations

from datetime import date, datetime

from .db import run_command
from .errors import Conflict, ValidationError

MONEY_LOCK_NAMESPACE = 1768842364


def _positive(name, value):
    if type(value) is not int or value <= 0:
        raise ValidationError(f"{name} must be a positive integer")
    return value


def _date(name, value):
    if isinstance(value, datetime):
        raise ValidationError(f"{name} must be an ISO date")
    if isinstance(value, date):
        return value.isoformat()
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValidationError(f"{name} must be an ISO date") from None
    return value


def _lock_money(conn):
    # Taken last in every money write; matches the ledger and business-currency triggers.
    conn.execute("SELECT pg_advisory_xact_lock(%s,0)", (MONEY_LOCK_NAMESPACE,))


def _currency(conn):
    """Business setup currency; before setup, the currency money was first recorded in."""
    return conn.execute("SELECT logistics.money_currency() AS currency").fetchone()["currency"]


def _owed(conn, supplier_key):
    row = conn.execute("""SELECT COALESCE(sum(CASE WHEN m.entry_type='supplier_charge' THEN m.amount_minor
        ELSE -m.amount_minor END),0)::bigint AS owed FROM logistics.money_ledger m
        JOIN logistics.core_bindings b ON b.id=m.supplier_id
        WHERE b.kind='supplier' AND b.external_key=%s""", (supplier_key,)).fetchone()
    return row["owed"]


def record_receipt_charges(c, receipt_id, idempotency_key):
    """Stock-private helper: charge suppliers for one receipt inside its transaction.

    One charge per received PO line, linked to that line's last receipt line in
    this delivery. charge = floor(total * cumulative_received / quantity) -
    already_charged, so partial receipts add up exactly to the frozen line total.
    """
    _lock_money(c)
    expected = _currency(c)
    charges = []
    rows = c.execute("""SELECT r.po_line_id,max(r.id) AS receipt_line_id,max(rc.received_on) AS received_on
        FROM logistics.receipt_lines r JOIN logistics.receipts rc ON rc.id=r.receipt_id
        WHERE r.receipt_id=%s AND r.po_line_id IS NOT NULL
        GROUP BY r.po_line_id ORDER BY r.po_line_id""", (receipt_id,)).fetchall()
    for row in rows:
        line = c.execute("""SELECT l.approved_terms,p.supplier_id,p.currency FROM logistics.purchase_order_lines l
            JOIN logistics.purchase_orders p ON p.id=l.purchase_order_id WHERE l.id=%s""", (row["po_line_id"],)).fetchone()
        if expected is not None and line["currency"] != expected:
            raise ValidationError(f"Purchase order currency {line['currency']} does not match the business currency {expected}")
        expected = line["currency"]
        terms = line["approved_terms"] or {}
        total, quantity = terms.get("total_minor"), terms.get("quantity")
        if type(total) is not int or type(quantity) is not int or quantity <= 0:
            raise ValidationError("Purchase line has no frozen approved total")
        received = c.execute("""SELECT COALESCE(sum(quantity),0)::bigint AS quantity FROM logistics.receipt_lines
            WHERE po_line_id=%s AND id<=%s""", (row["po_line_id"], row["receipt_line_id"])).fetchone()["quantity"]
        charged = c.execute("SELECT COALESCE(sum(amount_minor),0)::bigint AS amount FROM logistics.money_ledger WHERE po_line_id=%s",
                            (row["po_line_id"],)).fetchone()["amount"]
        amount = total * received // quantity - charged
        entry = c.execute("""INSERT INTO logistics.money_ledger
            (entry_type,supplier_id,amount_minor,currency,occurred_on,po_line_id,receipt_line_id,request_key)
            VALUES('supplier_charge',%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (line["supplier_id"], amount, line["currency"], row["received_on"], row["po_line_id"],
             row["receipt_line_id"], idempotency_key)).fetchone()
        charges.append(dict(ledger_entry_id=entry["id"], supplier_id=line["supplier_id"], po_line_id=row["po_line_id"],
                            receipt_line_id=row["receipt_line_id"], amount_minor=amount, currency=line["currency"]))
    return charges


def record_supplier_payment(conn, supplier_id, amount_minor, paid_on, idempotency_key):
    """Record money paid to a supplier. Paying more than is owed is rejected."""
    _positive("supplier_id", supplier_id)
    _positive("amount_minor", amount_minor)
    paid_on = _date("paid_on", paid_on)
    payload = dict(supplier_id=supplier_id, amount_minor=amount_minor, paid_on=paid_on)

    def work(c):
        supplier = c.execute("SELECT * FROM logistics.core_bindings WHERE id=%s", (supplier_id,)).fetchone()
        if supplier is None or supplier["kind"] != "supplier":
            raise ValidationError("supplier_id must refer to a supplier")
        _lock_money(c)
        owed = _owed(c, supplier["external_key"])
        if amount_minor > owed:
            raise ValidationError(f"Payment of {amount_minor} exceeds the {owed} owed to this supplier")
        currency = _currency(c)
        payment = c.execute("""INSERT INTO logistics.supplier_payments(supplier_id,amount_minor,currency,paid_on,request_key)
            VALUES(%s,%s,%s,%s,%s) RETURNING id""", (supplier_id, amount_minor, currency, paid_on, idempotency_key)).fetchone()
        entry = c.execute("""INSERT INTO logistics.money_ledger
            (entry_type,supplier_id,amount_minor,currency,occurred_on,payment_id,request_key)
            VALUES('supplier_payment',%s,%s,%s,%s,%s,%s) RETURNING id""",
            (supplier_id, amount_minor, currency, paid_on, payment["id"], idempotency_key)).fetchone()
        return dict(payment_id=payment["id"], ledger_entry_id=entry["id"], supplier_id=supplier_id,
                    amount_minor=amount_minor, currency=currency, paid_on=paid_on, owed_after_minor=owed - amount_minor)

    return run_command(conn, "cash.record_supplier_payment", idempotency_key, payload, work)


def supplier_balances(conn):
    """Per-supplier charged, paid and owed amounts. Supplier revisions share one account."""
    rows = conn.execute("""SELECT b.external_key,m.currency,
        COALESCE(sum(m.amount_minor) FILTER (WHERE m.entry_type='supplier_charge'),0)::bigint AS charged_minor,
        COALESCE(sum(m.amount_minor) FILTER (WHERE m.entry_type='supplier_payment'),0)::bigint AS paid_minor
        FROM logistics.money_ledger m JOIN logistics.core_bindings b ON b.id=m.supplier_id
        GROUP BY b.external_key,m.currency ORDER BY b.external_key""").fetchall()
    result = []
    for row in rows:
        current = conn.execute("""SELECT id,snapshot FROM logistics.core_bindings WHERE kind='supplier' AND external_key=%s
            ORDER BY (valid_to IS NULL) DESC,valid_from DESC LIMIT 1""", (row["external_key"],)).fetchone()
        result.append(dict(supplier_id=current["id"], supplier_key=row["external_key"],
                           name=current["snapshot"].get("name"), currency=row["currency"],
                           charged_minor=row["charged_minor"], paid_minor=row["paid_minor"],
                           owed_minor=row["charged_minor"] - row["paid_minor"]))
    return result


def record_opening_cash(conn, amount_minor, as_of, idempotency_key):
    """Record the business's opening cash once, in the business currency."""
    if type(amount_minor) is not int or amount_minor < 0:
        raise ValidationError("amount_minor must be a nonnegative integer")
    as_of = _date("as_of", as_of)

    def work(c):
        _lock_money(c)
        if c.execute("SELECT 1 FROM logistics.money_ledger WHERE entry_type='opening_cash'").fetchone():
            raise Conflict("Opening cash has already been recorded")
        currency = _currency(c)
        if currency is None:
            raise ValidationError("Set the business currency in Business setup before recording opening cash")
        entry = c.execute("""INSERT INTO logistics.money_ledger(entry_type,amount_minor,currency,occurred_on,request_key)
            VALUES('opening_cash',%s,%s,%s,%s) RETURNING id""", (amount_minor, currency, as_of, idempotency_key)).fetchone()
        return dict(ledger_entry_id=entry["id"], amount_minor=amount_minor, currency=currency, as_of=as_of)

    return run_command(conn, "cash.record_opening_cash", idempotency_key,
                       dict(amount_minor=amount_minor, as_of=as_of), work)


def cash_balance(conn):
    """Opening cash minus supplier payments. Customer receipts are not recorded yet."""
    row = conn.execute("""SELECT
        COALESCE(sum(amount_minor) FILTER (WHERE entry_type='opening_cash'),0)::bigint AS opening,
        min(occurred_on) FILTER (WHERE entry_type='opening_cash') AS opened_on,
        COALESCE(sum(amount_minor) FILTER (WHERE entry_type='supplier_payment'),0)::bigint AS paid
        FROM logistics.money_ledger""").fetchone()
    return dict(currency=_currency(conn), opening_minor=row["opening"],
                opened_on=row["opened_on"].isoformat() if row["opened_on"] else None,
                paid_out_minor=row["paid"], balance_minor=row["opening"] - row["paid"])
