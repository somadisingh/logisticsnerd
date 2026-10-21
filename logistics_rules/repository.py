"""Small transactional port and a nonpersistent, process-local test adapter.

Production must implement durable operation keys and stock/event updates in the
same database transaction. The lock below proves only this fake's behavior.
"""
from copy import deepcopy
from dataclasses import dataclass, field, fields, is_dataclass
from datetime import date, datetime
from threading import RLock
from typing import Any, Callable, Protocol, TypeVar
import re

T = TypeVar("T")


class RuleViolation(ValueError):
    """A command violates a logistics invariant or its company boundary."""


def _payload_identity(value: Any) -> tuple:
    """Versioned, type-sensitive request identity; never Python's 1 == True.

    Ordered lines/selections are part of the request. This fake keeps the full
    structural identity; a durable adapter must persist its canonical encoding
    (and version) rather than use process-specific Python hash().
    """
    kind = type(value)
    tag = f"{kind.__module__}.{kind.__qualname__}"
    if value is None or kind in (str, int, bool):
        return (tag, value)
    if kind is float:
        return (tag, repr(value))
    if kind in (date, datetime):
        return (tag, value.isoformat())
    if kind in (tuple, list):
        return (tag, tuple(_payload_identity(entry) for entry in value))
    if is_dataclass(value) and not isinstance(value, type):
        return (tag, tuple((f.name, _payload_identity(getattr(value, f.name))) for f in fields(value)))
    raise RuleViolation(f"Unsupported operation payload value type {tag}")


@dataclass
class CompanyState:
    business_id: str
    currency: str
    item_ids: frozenset[str]
    customer_ids: frozenset[str]
    supplier_ids: frozenset[str]
    owner_ids: frozenset[str]
    on_hand: dict[str, int]
    orders: dict[str, Any] = field(default_factory=dict)
    lines: dict[str, Any] = field(default_factory=dict)
    quotes: dict[str, Any] = field(default_factory=dict)
    purchase_orders: dict[str, Any] = field(default_factory=dict)
    approvals: set[str] = field(default_factory=set)
    operations: dict[str, tuple[Any, Any]] = field(default_factory=dict)


class Repository(Protocol):
    def read(self, business_id: str, query: Callable[[CompanyState], T]) -> T: ...

    def transact(self, business_id: str, key: str, payload: Any,
                 command: Callable[[CompanyState], T]) -> T:
        """Atomically check replay, apply command and save its original result.

        Same company/key/payload returns a detached original result. Reusing a
        key with another command/payload fails. Exceptions roll back all writes.
        Concurrent reads/checks/writes of stock and event uniqueness must serialize.
        """
        ...


class InMemoryRepository:
    """Fixture-only storage. Restarting the Python process loses everything."""

    def __init__(self):
        self._companies: dict[str, CompanyState] = {}
        self._lock = RLock()

    def seed_company(self, business_id: str, *, currency: str,
                     item_ids: tuple[str, ...], customer_ids: tuple[str, ...],
                     supplier_ids: tuple[str, ...], owner_ids: tuple[str, ...],
                     stock: dict[str, int]) -> None:
        """Test setup only; these identifiers are not new core entities."""
        with self._lock:
            if not isinstance(business_id, str) or not business_id.strip():
                raise RuleViolation("A company identifier is required")
            if business_id in self._companies:
                raise RuleViolation("Company fixture already exists")
            if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
                raise RuleViolation("Configure one uppercase three-letter currency")
            for ids in (item_ids, customer_ids, supplier_ids, owner_ids):
                if any(not isinstance(i, str) or not i.strip() for i in ids) or len(set(ids)) != len(ids):
                    raise RuleViolation("Fixture identifiers must be distinct nonempty strings")
            if set(stock) - set(item_ids):
                raise RuleViolation("Stock refers to an unknown company item")
            if any(type(q) is not int or q < 0 for q in stock.values()):
                raise RuleViolation("Stock must be nonnegative whole units")
            self._companies[business_id] = CompanyState(
                business_id, currency, frozenset(item_ids), frozenset(customer_ids),
                frozenset(supplier_ids), frozenset(owner_ids),
                {i: stock.get(i, 0) for i in item_ids})

    def _get(self, business_id: str) -> CompanyState:
        try:
            return self._companies[business_id]
        except KeyError:
            raise RuleViolation("Company context is unknown") from None

    def read(self, business_id: str, query: Callable[[CompanyState], T]) -> T:
        with self._lock:
            return deepcopy(query(deepcopy(self._get(business_id))))

    def transact(self, business_id: str, key: str, payload: Any,
                 command: Callable[[CompanyState], T]) -> T:
        if not isinstance(key, str) or not key.strip():
            raise RuleViolation("A nonempty operation key is required")
        identity = ("logistics-command-v1", _payload_identity(payload))
        with self._lock:
            current = self._get(business_id)
            if key in current.operations:
                original_identity, original_result = current.operations[key]
                if original_identity != identity:
                    raise RuleViolation("Operation key already used with a different payload")
                return deepcopy(original_result)
            candidate = deepcopy(current)
            result = command(candidate)
            candidate.operations[key] = (identity, deepcopy(result))
            self._companies[business_id] = candidate
            return deepcopy(result)
