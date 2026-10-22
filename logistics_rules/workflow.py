"""Business rules for one stock location, integer units and one company currency.

IDs/context here are explicit fixture values. A future core adapter must derive
company and approver from authentication; this module is not authentication.
"""
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone
from typing import Callable

from .repository import CompanyState, Repository, RuleViolation
from .selection import Quote, select_quotes


@dataclass(frozen=True)
class LineRequest:
    item_id: str
    quantity: int
    required_by: date
    maximum_budget_cents: int | None = None
    priority: str = "normal"


@dataclass(frozen=True)
class OrderLine:
    id: str
    business_id: str
    order_id: str
    item_id: str
    quantity: int
    required_by: date
    maximum_budget_cents: int | None
    priority: str
    reserved_quantity: int = 0
    original_shortage: int | None = None


@dataclass(frozen=True)
class Order:
    id: str
    business_id: str
    customer_id: str
    line_ids: tuple[str, ...]
    status: str
    created_at: datetime
    fulfilled_at: datetime | None = None


@dataclass(frozen=True)
class PurchaseOrder:
    id: str
    business_id: str
    line_id: str
    quote_id: str
    supplier_id: str
    quantity: int
    total_cents: int
    currency: str
    approver_id: str
    approved_at: datetime
    quote_snapshot: Quote
    status: str = "approved"
    received_at: datetime | None = None


@dataclass(frozen=True)
class Shortage:
    demand: int
    reserved: int
    original_shortage: int | None
    physical_shortage: int
    approved_inbound: int
    quantity_to_purchase: int


@dataclass(frozen=True)
class Stock:
    on_hand: int
    reserved: int
    available: int


def _identifier(value: str, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise RuleViolation(f"{label} must be a nonempty identifier")


def _positive(value: int, label: str) -> None:
    if type(value) is not int or value <= 0:
        raise RuleViolation(f"{label} must be positive whole units")


def _record(records: dict, record_id: str, label: str):
    try:
        return records[record_id]
    except KeyError:
        raise RuleViolation(f"{label} is absent from this company") from None


def _stock(state: CompanyState, item_id: str) -> Stock:
    if item_id not in state.item_ids:
        raise RuleViolation("Item is absent from this company")
    reserved = sum(line.reserved_quantity for line in state.lines.values()
                   if line.item_id == item_id and state.orders[line.order_id].status != "fulfilled")
    return Stock(state.on_hand[item_id], reserved, state.on_hand[item_id] - reserved)


def _shortage(state: CompanyState, line: OrderLine) -> Shortage:
    if state.orders[line.order_id].status == "fulfilled":
        return Shortage(line.quantity, 0, line.original_shortage, 0, 0, 0)
    inbound = sum(po.quantity for po in state.purchase_orders.values()
                  if po.line_id == line.id and po.status == "approved")
    physical = line.quantity - line.reserved_quantity
    return Shortage(line.quantity, line.reserved_quantity, line.original_shortage,
                    physical, inbound, physical - inbound)


def _unfinished(state: CompanyState, order_id: str) -> Order:
    order = _record(state.orders, order_id, "Order")
    if order.status == "fulfilled":
        raise RuleViolation("Order is already fulfilled")
    return order


def _refresh(state: CompanyState, order_id: str) -> Order:
    order = state.orders[order_id]
    ready = all(state.lines[i].reserved_quantity == state.lines[i].quantity for i in order.line_ids)
    order = replace(order, status="ready" if ready else "open")
    state.orders[order_id] = order
    return order


class Workflow:
    def __init__(self, repository: Repository, *, clock: Callable[[], datetime] | None = None):
        self.repository = repository
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def _now(self) -> datetime:
        now = self.clock()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise RuleViolation("Clock must return a timezone-aware datetime")
        return now

    def create_order(self, business_id: str, order_id: str, customer_id: str,
                     lines: tuple[LineRequest, ...], *, key: str) -> Order:
        lines = tuple(lines)
        def command(state):
            _identifier(order_id, "Order ID")
            if order_id in state.orders:
                raise RuleViolation("Order business event already exists")
            if customer_id not in state.customer_ids:
                raise RuleViolation("Customer is absent from this company")
            if not lines:
                raise RuleViolation("An order needs at least one line")
            normalized = {}
            for request in lines:
                if not isinstance(request, LineRequest):
                    raise RuleViolation("Order lines must be LineRequest values")
                if request.item_id not in state.item_ids:
                    raise RuleViolation("Item is absent from this company")
                _positive(request.quantity, "Demand")
                if type(request.required_by) is not date:
                    raise RuleViolation("A line requires a calendar deadline")
                if request.maximum_budget_cents is not None and (
                        type(request.maximum_budget_cents) is not int or request.maximum_budget_cents < 0):
                    raise RuleViolation("Budget must be nonnegative integer cents")
                if request.priority not in ("normal", "urgent"):
                    raise RuleViolation("Priority must be normal or urgent")
                previous = normalized.get(request.item_id)
                if previous:
                    if (previous.required_by, previous.maximum_budget_cents, previous.priority) != (
                            request.required_by, request.maximum_budget_cents, request.priority):
                        raise RuleViolation("Duplicate item lines have incompatible constraints")
                    request = replace(previous, quantity=previous.quantity + request.quantity)
                normalized[request.item_id] = request
            ids = []
            for index, request in enumerate(normalized.values(), 1):
                line_id = f"{order_id}:{index}"
                if line_id in state.lines:
                    raise RuleViolation("Order line ID collision")
                ids.append(line_id)
                state.lines[line_id] = OrderLine(
                    line_id, business_id, order_id, request.item_id, request.quantity,
                    request.required_by, request.maximum_budget_cents, request.priority)
            order = Order(order_id, business_id, customer_id, tuple(ids), "open", self._now())
            state.orders[order_id] = order
            return order
        return self.repository.transact(business_id, key, ("create", order_id, customer_id, lines), command)

    def reserve(self, business_id: str, order_id: str, *, key: str) -> Order:
        def command(state):
            order = _unfinished(state, order_id)
            for line_id in order.line_ids:
                line = state.lines[line_id]
                shortage = _shortage(state, line)
                quantity = min(_stock(state, line.item_id).available, shortage.quantity_to_purchase)
                reserved = line.reserved_quantity + quantity
                state.lines[line_id] = replace(line, reserved_quantity=reserved,
                    original_shortage=(line.quantity - reserved if line.original_shortage is None else line.original_shortage))
            return _refresh(state, order_id)
        return self.repository.transact(business_id, key, ("reserve", order_id), command)

    def shortage(self, business_id: str, line_id: str) -> Shortage:
        return self.repository.read(business_id, lambda s: _shortage(s, _record(s.lines, line_id, "Line")))

    def stock(self, business_id: str, item_id: str) -> Stock:
        return self.repository.read(business_id, lambda s: _stock(s, item_id))

    def get_order(self, business_id: str, order_id: str) -> Order:
        return self.repository.read(business_id, lambda s: _record(s.orders, order_id, "Order"))

    def get_line(self, business_id: str, line_id: str) -> OrderLine:
        return self.repository.read(business_id, lambda s: _record(s.lines, line_id, "Line"))

    def get_po(self, business_id: str, po_id: str) -> PurchaseOrder:
        return self.repository.read(business_id, lambda s: _record(s.purchase_orders, po_id, "PO"))

    def add_quote(self, business_id: str, quote: Quote, *, key: str) -> Quote:
        def command(state):
            self._store_quote(state, business_id, quote)
            return quote
        return self.repository.transact(business_id, key, ("quote", quote), command)

    @staticmethod
    def _store_quote(state, business_id: str, quote: Quote):
        if not isinstance(quote, Quote) or quote.business_id != business_id:
            raise RuleViolation("Quote company differs from context")
        line = _record(state.lines, quote.line_id, "Line")
        _unfinished(state, line.order_id)
        if quote.supplier_id not in state.supplier_ids:
            raise RuleViolation("Supplier is absent from this company")
        if quote.currency != state.currency:
            raise RuleViolation("Mixed currencies are unsupported")
        if quote.id in state.quotes:
            raise RuleViolation("Quote is immutable and already exists")
        if any(q.line_id == quote.line_id and q.supplier_id == quote.supplier_id for q in state.quotes.values()):
            raise RuleViolation("One immutable quote per supplier and demand in v1; requoting is unsupported")
        state.quotes[quote.id] = quote

    def add_quotes(self, business_id: str, quotes: tuple[Quote, ...], *, key: str) -> tuple[Quote, ...]:
        """Accept one validated estimate batch atomically, including replay state."""
        quotes = tuple(quotes)
        def command(state):
            if not quotes:
                raise RuleViolation("A quote batch cannot be empty")
            for quote in quotes:
                self._store_quote(state, business_id, quote)
            return quotes
        return self.repository.transact(business_id, key, ("quotes", quotes), command)

    def recommend(self, business_id: str, line_id: str):
        def query(state):
            line = _record(state.lines, line_id, "Line")
            _unfinished(state, line.order_id)
            used = {p.quote_id for p in state.purchase_orders.values()}
            quotes = tuple(q for q in state.quotes.values() if q.line_id == line_id and q.id not in used)
            spent = sum(p.total_cents for p in state.purchase_orders.values() if p.line_id == line_id)
            remaining_budget = None if line.maximum_budget_cents is None else line.maximum_budget_cents - spent
            return select_quotes(_shortage(state, line).quantity_to_purchase, quotes,
                now=self._now(), deadline=line.required_by, currency=state.currency, budget_cents=remaining_budget)
        return self.repository.read(business_id, query)

    def approve(self, business_id: str, line_id: str, *, selections: tuple[tuple[str, int], ...],
                owner_id: str, approval_id: str, key: str) -> tuple[PurchaseOrder, ...]:
        selections = tuple(tuple(choice) for choice in selections)
        def command(state):
            _identifier(approval_id, "Approval ID")
            if owner_id not in state.owner_ids:
                raise RuleViolation("Approval requires an explicitly identified company owner")
            if approval_id in state.approvals:
                raise RuleViolation("Approval business event already exists")
            line = _record(state.lines, line_id, "Line")
            _unfinished(state, line.order_id)
            if line.original_shortage is None:
                raise RuleViolation("Reserve available stock before approving purchases")
            if not selections or any(len(choice) != 2 for choice in selections):
                raise RuleViolation("Approval must explicitly select quotes and quantities")
            if len({q for q, _ in selections}) != len(selections):
                raise RuleViolation("Duplicate quote selection")
            now = self._now()
            purchases = []
            used = {p.quote_id for p in state.purchase_orders.values()}
            total_quantity = 0
            for index, (quote_id, quantity) in enumerate(selections, 1):
                _positive(quantity, "Purchased quantity")
                quote = _record(state.quotes, quote_id, "Quote")
                if quote.business_id != business_id or quote.line_id != line_id:
                    raise RuleViolation("Quote, line and company must agree")
                if quote_id in used:
                    raise RuleViolation("Selected quote has already been purchased")
                try:
                    quote.validate_at(now, line.required_by, state.currency)
                    cost = quote.cost(quantity)
                except ValueError as exc:
                    raise RuleViolation(str(exc)) from exc
                po_id = f"{approval_id}:{index}"
                if po_id in state.purchase_orders:
                    raise RuleViolation("PO ID collision")
                total_quantity += quantity
                purchases.append(PurchaseOrder(po_id, business_id, line_id, quote.id, quote.supplier_id,
                    quantity, cost, quote.currency, owner_id, now, quote))
            if total_quantity > _shortage(state, line).quantity_to_purchase:
                raise RuleViolation("Purchased quantity exceeds remaining unallocated shortage")
            spent = sum(p.total_cents for p in state.purchase_orders.values() if p.line_id == line_id)
            combined = spent + sum(p.total_cents for p in purchases)
            if line.maximum_budget_cents is not None and combined > line.maximum_budget_cents:
                raise RuleViolation(f"Combined purchase cost {combined} exceeds line shortage budget {line.maximum_budget_cents}")
            for purchase in purchases:
                state.purchase_orders[purchase.id] = purchase
            state.approvals.add(approval_id)
            return tuple(purchases)
        payload = ("approve", line_id, selections, owner_id, approval_id)
        return self.repository.transact(business_id, key, payload, command)

    def receive(self, business_id: str, po_id: str, *, key: str, quantity: int | None = None) -> PurchaseOrder:
        def command(state):
            po = _record(state.purchase_orders, po_id, "PO")
            if po.status != "approved":
                raise RuleViolation("PO has already been received")
            if quantity is not None and (type(quantity) is not int or quantity != po.quantity):
                raise RuleViolation("Partial receipts are outside v1; receive the full purchased quantity")
            line = state.lines[po.line_id]
            _unfinished(state, line.order_id)
            if line.reserved_quantity + po.quantity > line.quantity:
                raise RuleViolation("Receipt would over-reserve demand")
            state.on_hand[line.item_id] += po.quantity
            state.lines[line.id] = replace(line, reserved_quantity=line.reserved_quantity + po.quantity)
            po = replace(po, status="received", received_at=self._now())
            state.purchase_orders[po_id] = po
            _refresh(state, line.order_id)
            return po
        return self.repository.transact(business_id, key, ("receive", po_id, quantity), command)

    def fulfill(self, business_id: str, order_id: str, *, key: str, quantity: int | None = None) -> Order:
        def command(state):
            order = _unfinished(state, order_id)
            if quantity is not None:
                raise RuleViolation("Partial shipments are outside v1; fulfill the entire order")
            if order.status != "ready" or any(state.lines[i].reserved_quantity != state.lines[i].quantity for i in order.line_ids):
                raise RuleViolation("All lines must be fully reserved before fulfillment")
            for line_id in order.line_ids:
                line = state.lines[line_id]
                if state.on_hand[line.item_id] < line.quantity:
                    raise RuleViolation("On-hand stock cannot cover the order")
                state.on_hand[line.item_id] -= line.quantity
                state.lines[line_id] = replace(line, reserved_quantity=0)
            order = replace(order, status="fulfilled", fulfilled_at=self._now())
            state.orders[order_id] = order
            return order
        return self.repository.transact(business_id, key, ("fulfill", order_id, quantity), command)

    def transition(self, business_id: str, entity_id: str, *, action: str, **kwargs):
        raise RuleViolation(f"Unsupported lifecycle action {action!r}: partial receipts/shipments, returns, cancellations and transfers are outside v1")
