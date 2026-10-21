"""Local browser-demo session backed by the standalone Python rules.

Run as a newline-delimited JSON worker with ``python3 -m logistics_rules.demo_session``.
The process owns one disposable, in-memory fixture. It does not authenticate users,
call suppliers, write a database, or expose a production module interface.
"""

from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta, timezone
import json
import sys

from .repository import InMemoryRepository
from .selection import Quote
from .workflow import LineRequest, RuleViolation, Workflow


NOW = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
DEADLINE = date(2026, 11, 1)
DEMAND = 15
BUDGET = 2000
ITEM = {"id": "item", "name": "Industrial filter", "sku": "FLT-001"}
SUPPLIER_OPTIONS = (
    {"id": "X", "name": "Supplier X", "capacity_quantity": 7, "quantity_priced": 7,
     "unit_price_cents": 100, "expected_date": DEADLINE},
    {"id": "Y", "name": "Supplier Y", "capacity_quantity": 4, "quantity_priced": 4,
     "unit_price_cents": 120, "expected_date": DEADLINE},
)
ORDER_ID = "customer-order"
LINE_ID = f"{ORDER_ID}:1"
APPROVAL_ID = "demo-owner-approval"
OWNER_ID = "companyAOwner"


def _json_value(value):
    if is_dataclass(value):
        return _json_value(asdict(value))
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    return value


class DemoSession:
    """Fixed Company A/B fixtures; callers choose actions, never company/owner IDs."""

    def __init__(self):
        self._reset()

    def _reset(self):
        self.repository = InMemoryRepository()
        self.repository.seed_company(
            "A", currency="USD", item_ids=(ITEM["id"],), customer_ids=("customer",),
            supplier_ids=tuple(supplier["id"] for supplier in SUPPLIER_OPTIONS),
            owner_ids=(OWNER_ID,), stock={ITEM["id"]: 6},
        )
        self.repository.seed_company(
            "B", currency="USD", item_ids=("B-item",), customer_ids=("B-customer",),
            supplier_ids=("B-supplier",), owner_ids=("B-owner",), stock={"B-item": 0},
        )
        self.rules = Workflow(self.repository, clock=lambda: NOW)
        self.rules.create_order(
            "A", "other-order", "customer", (LineRequest(ITEM["id"], 2, DEADLINE),),
            key="seed-other-order",
        )
        self.rules.reserve("A", "other-order", key="seed-other-reservation")
        self.recommendation = None
        self.events = []
        self.receipt_keys = {}
        self.fulfillment_key = None

    def snapshot(self):
        state = self.repository.read("A", lambda company: company)
        order = state.orders.get(ORDER_ID)
        lines = []
        if order:
            for line_id in order.line_ids:
                line = _json_value(state.lines[line_id])
                line["shortage"] = _json_value(self.rules.shortage("A", line_id))
                lines.append(line)
        quotes = []
        for quote in state.quotes.values():
            value = _json_value(quote)
            value["estimated"] = quote.estimated
            quotes.append(value)
        return {
            "mode": "in_memory",
            "supplier_data": "synthetic",
            "company": {"id": "A", "name": "Company A", "currency": "USD", "owner_id": OWNER_ID},
            "clock": NOW.isoformat(),
            "deadline": DEADLINE.isoformat(),
            "budget_cents": BUDGET,
            "scenario": {"quantity": DEMAND},
            "item": _json_value(ITEM),
            "suppliers": _json_value(SUPPLIER_OPTIONS),
            "stock": _json_value(self.rules.stock("A", ITEM["id"])),
            "other_order": {"id": "other-order", "reserved_quantity": state.lines["other-order:1"].reserved_quantity},
            "order": _json_value(order),
            "lines": lines,
            "quotes": quotes,
            "recommendation": _json_value(self.recommendation),
            "purchases": [_json_value(po) for po in state.purchase_orders.values()],
            "events": list(self.events),
        }

    def _event(self, action, label, detail, ok=True):
        self.events.append({
            "sequence": len(self.events) + 1, "action": action,
            "label": label, "detail": detail, "ok": ok,
        })

    def _create_order(self, key):
        self.rules.create_order(
            "A", ORDER_ID, "customer",
            (LineRequest(ITEM["id"], DEMAND, DEADLINE, maximum_budget_cents=BUDGET),), key=key,
        )
        return "Customer order created", f"{DEMAND} filters, due {DEADLINE.isoformat()}. Purchase budget: ${BUDGET / 100:.2f} USD."

    def _reserve(self, key):
        self.rules.reserve("A", ORDER_ID, key=key)
        shortage = self.rules.shortage("A", LINE_ID)
        return "Available stock reserved", f"{shortage.reserved} reserved for this order; {shortage.quantity_to_purchase} units still need purchasing."

    def _compare(self, _key):
        line = self.rules.get_line("A", LINE_ID)
        if line.original_shortage is None:
            raise RuleViolation("Reserve available stock before comparing suppliers")
        for option in SUPPLIER_OPTIONS:
            supplier = option["id"]
            quote = Quote(
                id=f"quote-{supplier}", business_id="A", line_id=LINE_ID,
                supplier_id=supplier, capacity_quantity=option["capacity_quantity"],
                quantity_priced=option["quantity_priced"], price_cents=option["unit_price_cents"],
                pricing_kind="unit", currency="USD", source="synthetic",
                generated_at=NOW, expires_at=NOW + timedelta(days=7), expected_date=option["expected_date"],
            )
            self.rules.add_quote("A", quote, key=f"demo-quote-{supplier}")
        self.recommendation = self.rules.recommend("A", LINE_ID)
        return "Supplier comparison ready", "Synthetic estimates only. A recommendation creates no purchase orders."

    def _approve(self, key):
        if self.recommendation is None or not self.recommendation.feasible or not self.recommendation.allocations:
            raise RuleViolation("Compare suppliers and select a feasible plan before approval")
        selections = tuple((value.quote_id, value.quantity) for value in self.recommendation.allocations)
        purchases = self.rules.approve(
            "A", LINE_ID, selections=selections, owner_id=OWNER_ID,
            approval_id=APPROVAL_ID, key=key,
        )
        quantity = sum(po.quantity for po in purchases)
        return "Purchases explicitly approved", f"Demo owner {OWNER_ID} approved {quantity} units. Approval did not change on-hand stock."

    def _receive(self, supplier, key):
        index = {"X": 1, "Y": 2}[supplier]
        po_id = f"{APPROVAL_ID}:{index}"
        purchase = self.rules.receive("A", po_id, key=key)
        self.receipt_keys.setdefault(po_id, key)
        return f"Supplier {supplier} received", f"Received all {purchase.quantity} units and reserved them for the customer order."

    def _fulfill(self, key):
        self.rules.fulfill("A", ORDER_ID, key=key)
        if self.fulfillment_key is None:
            self.fulfillment_key = key
        return "Customer order fulfilled", f"All {DEMAND} units shipped. The other order's 2 reserved units remain in stock."

    def _balances(self):
        state = self.snapshot()
        return {key: state[key] for key in ("stock", "order", "lines", "purchases", "other_order")}

    def _replay(self, _key):
        order = self.rules.get_order("A", ORDER_ID)
        if order.status != "fulfilled" or len(self.receipt_keys) != 2 or self.fulfillment_key is None:
            raise RuleViolation("Receive both purchases and fulfill the order before checking replays")
        before = self._balances()
        for po_id, key in self.receipt_keys.items():
            self.rules.receive("A", po_id, key=key)
            self._expect_rejection(lambda po_id=po_id: self.rules.receive("A", po_id, key=f"replay-new-{po_id}"))
        self.rules.fulfill("A", ORDER_ID, key=self.fulfillment_key)
        self._expect_rejection(lambda: self.rules.fulfill("A", ORDER_ID, key="replay-new-fulfillment"))
        if before != self._balances():
            raise RuleViolation("Replay verification changed business state")
        return "Replay checks passed", "Same keys returned original results. New keys for completed receipts and fulfillment were rejected. Stock stayed unchanged."

    @staticmethod
    def _expect_rejection(command):
        try:
            command()
        except RuleViolation as error:
            return str(error)
        raise RuleViolation("Demo verification expected the company-scoped rule to reject this action")

    def _check_isolation(self, _key):
        self.rules.get_order("A", ORDER_ID)
        before = self._balances()
        checks = [
            lambda: self.rules.get_order("B", ORDER_ID),
            lambda: self.rules.get_line("B", LINE_ID),
            lambda: self.rules.fulfill("B", ORDER_ID, key="B-fulfill"),
        ]
        if self.receipt_keys or self.repository.read("A", lambda state: bool(state.purchase_orders)):
            checks.append(lambda: self.rules.receive("B", f"{APPROVAL_ID}:1", key="B-receive"))
        for check in checks:
            self._expect_rejection(check)
        if before != self._balances():
            raise RuleViolation("Isolation verification changed business state")
        return "Company isolation checks passed", f"{len(checks)} Company B access attempts rejected by the in-memory company-scoped rules. This fixture does not test production authentication."

    def run(self, request):
        action = request.get("action") if isinstance(request, dict) else None
        try:
            if not isinstance(request, dict) or set(request) - {"action", "key"}:
                raise RuleViolation("Send only a demo action and an optional operation key")
            if not isinstance(action, str):
                raise RuleViolation("A demo action is required")
            key = request.get("key", f"demo-{action}")
            if not isinstance(key, str) or not key.strip() or len(key) > 128:
                raise RuleViolation("Operation key must contain 1 through 128 characters")
            if action == "snapshot":
                return {"ok": True, "snapshot": self.snapshot()}
            if action == "reset":
                self._reset()
                label, detail = "Demo reset", "In-memory fixtures restored: 6 on hand, 2 reserved for another order."
            else:
                commands = {
                    "create_order": self._create_order,
                    "reserve": self._reserve,
                    "compare": self._compare,
                    "approve": self._approve,
                    "receive_x": lambda key: self._receive("X", key),
                    "receive_y": lambda key: self._receive("Y", key),
                    "fulfill": self._fulfill,
                    "replay": self._replay,
                    "check_isolation": self._check_isolation,
                }
                command = commands.get(action)
                if command is None:
                    raise RuleViolation("Unknown demo action")
                label, detail = command(key)
            self._event(action, label, detail)
            return {"ok": True, "snapshot": self.snapshot()}
        except RuleViolation as error:
            self._event(action if isinstance(action, str) else "invalid", "Action rejected", str(error), ok=False)
            return {"ok": False, "error": str(error), "snapshot": self.snapshot()}


def main():
    session = DemoSession()
    for line in sys.stdin:
        try:
            request = json.loads(line) if len(line) <= 8192 else None
        except (json.JSONDecodeError, RecursionError):
            request = None
        result = session.run(request)
        print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
