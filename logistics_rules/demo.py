"""Run with ``python3 -m logistics_rules.demo`` from the repository root.

Everything here is deterministic and in memory. Supplier quotes are synthetic;
this is not a persistent or integrated OperationsNerd workflow.
"""

from datetime import date, datetime, timedelta, timezone

from .repository import InMemoryRepository
from .selection import Quote
from .workflow import LineRequest, RuleViolation, Workflow


def main():
    now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
    deadline = date(2026, 11, 1)
    repo = InMemoryRepository()
    repo.seed_company("A", currency="USD", item_ids=("item",),
                      customer_ids=("customer",), supplier_ids=("X", "Y"),
                      owner_ids=("owner",), stock={"item": 6})
    repo.seed_company("B", currency="USD", item_ids=("B-item",),
                      customer_ids=("B-customer",), supplier_ids=("B-supplier",),
                      owner_ids=("B-owner",), stock={"B-item": 0})
    rules = Workflow(repo, clock=lambda: now)

    def stock(label):
        value = rules.stock("A", "item")
        print(f"{label}: on_hand={value.on_hand}, reserved={value.reserved}, "
              f"available={value.available}")

    def rejected(label, operation):
        try:
            operation()
        except RuleViolation as error:
            print(f"{label}: rejected ({error})")
        else:
            raise AssertionError(f"{label} unexpectedly succeeded")

    print("LogisticsNerd standalone demo | in-memory repository | synthetic supplier data")
    print("Currency USD; one stock location; no network, model, database, backend, or UI calls")
    rules.create_order("A", "other-order", "customer",
                       (LineRequest("item", 2, deadline),), key="create-other")
    rules.reserve("A", "other-order", key="reserve-other")
    stock("Other order reserves 2")
    rules.create_order(
        "A", "customer-order", "customer",
        (LineRequest("item", 15, deadline, maximum_budget_cents=2000),),
        key="create-customer",
    )
    rules.reserve("A", "customer-order", key="reserve-customer")
    shortage = rules.shortage("A", "customer-order:1")
    print(f"Customer demand={shortage.demand}; reserved={shortage.reserved}; "
          f"original shortage={shortage.original_shortage}; "
          f"remaining quantity_to_purchase={shortage.quantity_to_purchase}")
    assert (shortage.demand, shortage.reserved, shortage.quantity_to_purchase) == (15, 4, 11)

    for quote_id, supplier_id, capacity, unit_price in (
        ("quote-X", "X", 7, 100), ("quote-Y", "Y", 4, 120),
    ):
        quote = Quote(
            id=quote_id, business_id="A", line_id="customer-order:1",
            supplier_id=supplier_id, capacity_quantity=capacity,
            quantity_priced=capacity, price_cents=unit_price, pricing_kind="unit",
            currency="USD", source="synthetic", generated_at=now,
            expires_at=now + timedelta(days=7), expected_date=deadline,
        )
        rules.add_quote("A", quote, key=f"add-{quote_id}")
        print(f"Synthetic supplier {supplier_id}: capacity={capacity}, "
              f"quantity_priced={capacity}, unit_price_cents={unit_price}, "
              f"delivery={deadline}")
    recommendation = rules.recommend("A", "customer-order:1")
    print(f"Recommendation (no purchase created): {recommendation}")
    assert rules.shortage("A", "customer-order:1").approved_inbound == 0
    purchases = rules.approve(
        "A", "customer-order:1", selections=(("quote-X", 7), ("quote-Y", 4)),
        owner_id="owner", approval_id="explicit-owner-approval", key="approve-purchases",
    )
    print(f"Explicit owner approval: quantities={[po.quantity for po in purchases]}, "
          f"combined_cost_cents={sum(po.total_cents for po in purchases)}, "
          "line_purchase_budget_cents=2000")
    stock("After approval (stock unchanged)")
    assert rules.stock("A", "item").on_hand == 6

    first, second = purchases
    first_result = rules.receive("A", first.id, key="receive-X")
    stock("After receiving X's 7")
    assert rules.get_po("A", second.id).received_at is None
    rejected("Fulfillment after first receipt", lambda: rules.fulfill(
        "A", "customer-order", key="fulfill-too-early"))
    rules.receive("A", second.id, key="receive-Y")
    stock("After receiving Y's 4")
    assert rules.get_order("A", "customer-order").status == "ready"
    fulfilled = rules.fulfill("A", "customer-order", key="fulfill-customer")
    stock("After fulfilling all 15")
    final = rules.stock("A", "item")
    assert (final.on_hand, final.reserved, final.available) == (2, 2, 0)
    assert rules.shortage("A", "other-order:1").reserved == 2

    assert rules.receive("A", first.id, key="receive-X") == first_result
    assert rules.fulfill("A", "customer-order", key="fulfill-customer") == fulfilled
    print("Same-key receipt and fulfillment replays: original results returned")
    rejected("Receipt repeated with a different key", lambda: rules.receive(
        "A", first.id, key="repeat-receipt-new-key"))
    rejected("Fulfillment repeated with a different key", lambda: rules.fulfill(
        "A", "customer-order", key="repeat-fulfillment-new-key"))
    rejected("Company B reads Company A's order", lambda: rules.get_order(
        "B", "customer-order"))
    rejected("Company B receives Company A's purchase", lambda: rules.receive(
        "B", first.id, key="B-receive"))
    rejected("Company B fulfills Company A's order", lambda: rules.fulfill(
        "B", "customer-order", key="B-fulfill"))
    assert rules.stock("A", "item") == final
    stock("After all repeated and cross-company operations")
    print("Demo assertions passed. Database persistence and application integration remain unimplemented.")


if __name__ == "__main__":
    main()
