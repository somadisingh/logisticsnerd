"""Owner-only local API for the persistent purchasing/stock workspace.

This is an explicit development authentication adapter. A host/core integration must
replace it with trusted business routing and actor resolution before deployment.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from hmac import compare_digest
import os
from typing import Annotated, Any, Callable, Iterator, Literal

from fastapi import Depends, FastAPI, Header, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import Field

from .http_models import Command, Currency, Input, NonNegativeInt, PositiveInt, PositivePathInt


@dataclass(frozen=True)
class Settings:
    database_url: str = ""
    business_key: str = ""
    api_token: str = ""
    actor_ref: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(*(os.environ.get(name, "") for name in (
            "LOGISTICS_DATABASE_URL", "LOGISTICS_BUSINESS_KEY", "LOGISTICS_API_TOKEN", "LOGISTICS_ACTOR_REF"
        )))

    @property
    def configured(self) -> bool:
        return all((self.database_url, self.business_key, self.api_token, self.actor_ref))


class QuoteInput(Command):
    supplier_id: PositiveInt
    item_id: PositiveInt
    quantity_priced: PositiveInt
    capacity_quantity: PositiveInt
    price_minor: NonNegativeInt
    pricing_kind: Literal["unit", "total"] = "unit"
    currency: Currency
    expires_at: datetime
    expected_date: date
    quote_ref: Annotated[str, Field(min_length=1, max_length=200)] | None = None


class PurchaseInput(Command):
    supplier_id: PositiveInt
    currency: Currency


class PurchaseLineInput(Command):
    quote_version_id: PositiveInt
    quantity: PositiveInt
    expected_version: NonNegativeInt | None = None


class AllocationInput(Command):
    demand_line_id: PositiveInt
    quantity: PositiveInt
    cost_share_minor: NonNegativeInt | None = None
    expected_version: NonNegativeInt | None = None


class ApprovalInput(Command):
    expected_version: NonNegativeInt | None = None


class ReceiptAllocation(Input):
    purchase_allocation_id: PositiveInt
    demand_line_id: PositiveInt
    quantity: PositiveInt


class ReceiptLine(Input):
    po_line_id: PositiveInt
    item_id: PositiveInt
    location_id: PositiveInt
    quantity: PositiveInt
    lot_number: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    expiry_date: date | None = None
    allocations: Annotated[list[ReceiptAllocation], Field(max_length=1000)] = []


class DeliveryInput(Command):
    delivery_ref: Annotated[str, Field(min_length=1, max_length=200)]
    received_on: date
    lines: Annotated[list[ReceiptLine], Field(min_length=1, max_length=1000)]
    as_of: date | None = None


@contextmanager
def database_connection(settings: Settings) -> Iterator[Any]:
    from . import db
    with db.connect(settings.database_url, business_key=settings.business_key) as conn:
        yield conn


class WorkspaceService:
    """Thin transport adapter. Domain decisions remain in purchasing/stock commands."""

    def workspace(self, conn: Any) -> dict[str, Any]:
        tables = {
            "references": "core_bindings", "demands": "demand_lines", "quotes": "quote_versions",
            "purchase_orders": "purchase_orders", "purchase_lines": "purchase_order_lines",
            "allocations": "purchase_allocations", "stock": "stock_levels",
        }
        result = {name: conn.execute(f"SELECT * FROM logistics.{table}").fetchall() for name, table in tables.items()}
        from .records import decorate_references
        result["references"] = decorate_references(conn, result["references"])
        for row in result["stock"]:
            row["available"] = row["on_hand"] - row["reserved"]
        from .purchasing import _demand_position
        for demand in result["demands"]:
            position = _demand_position(conn, demand["id"])
            demand["reserved_quantity"] = position["reserved"]
            demand["inbound_quantity"] = position["inbound"]
            demand["remaining_to_buy"] = max(0, demand["quantity"] - position["shipped"]
                                             - position["reserved"] - position["inbound"])
        return result

    def actor_id(self, conn: Any, actor_ref: str) -> int:
        row = conn.execute(
            "SELECT id FROM logistics.core_bindings WHERE kind='actor' AND external_key=%s AND valid_to IS NULL",
            (actor_ref,),
        ).fetchone()
        if row is None:
            from .errors import ValidationError
            raise ValidationError("The configured actor has no current core binding.")
        return int(row["id"])

    def call(self, conn: Any, operation: str, payload: dict[str, Any]) -> Any:
        from . import purchasing, stock
        if operation == "receive_delivery":
            return stock.receive_delivery(conn, **payload)
        if operation == "stock_summary":
            return stock.stock_summary(conn, **payload)
        return getattr(purchasing, operation)(conn, **payload)


def _public_json(value: Any) -> Any:
    return jsonable_encoder(value, custom_encoder={Decimal: str})


def create_app(
    settings: Settings | None = None,
    *,
    connection_factory: Callable[[Settings], Any] = database_connection,
    service: WorkspaceService | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    service = service or WorkspaceService()
    app = FastAPI(title="LogisticsNerd local purchasing API", docs_url=None, redoc_url=None, openapi_url=None)

    def error(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Do not echo input: an accidental pasted credential must not enter responses/logs.
        return JSONResponse(status_code=422, content={"error": {"code": "invalid_request", "message": "Check the request fields.",
            "fields": [{"location": list(issue["loc"]), "message": issue["msg"]} for issue in exc.errors()]}})

    @app.exception_handler(Exception)
    async def command_error(_: Request, exc: Exception) -> JSONResponse:
        from . import errors
        if isinstance(exc, errors.LogisticsError):
            status = 403 if isinstance(exc, errors.AuthorizationError) else 404 if isinstance(exc, errors.NotFound) else 409 if isinstance(exc, errors.Conflict) else 422
            return error(status, type(exc).__name__, str(exc))
        # Connection and driver errors can contain passwords, hostnames or SQL.
        return error(503, "backend_unavailable", "The purchasing service is unavailable. Check the backend configuration.")

    @app.middleware("http")
    async def sanitize_unexpected_errors(request: Request, call_next: Callable) -> Any:
        # Catch before Starlette's outer server-error handler re-raises to an
        # access server logger. Driver exceptions can include connection details.
        try:
            return await call_next(request)
        except Exception as exc:
            return await command_error(request, exc)

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        if not settings.configured:
            from fastapi import HTTPException
            raise HTTPException(status_code=503, detail="Configure the local purchasing backend first.")
        expected = f"Bearer {settings.api_token}"
        if authorization is None or not compare_digest(authorization.encode(), expected.encode()):
            from fastapi import HTTPException
            raise HTTPException(status_code=401, detail="A valid owner development token is required.", headers={"WWW-Authenticate": "Bearer"})

    def connection(_: None = Depends(authorize)) -> Iterator[Any]:
        with connection_factory(settings) as conn:
            yield conn

    def invoke(conn: Any, name: str, values: dict[str, Any]) -> Any:
        return _public_json(service.call(conn, name, values))

    @app.get("/api/purchasing/health")
    def health() -> dict[str, Any]:
        return {"service": "logistics-purchasing", "configured": settings.configured,
                "authentication": "owner-development-token", "core_mapping": "external-adapter-required"}

    @app.get("/api/purchasing/workspace")
    def workspace(conn: Any = Depends(connection)) -> Any:
        return _public_json(service.workspace(conn))

    @app.get("/api/purchasing/references")
    def references(conn: Any = Depends(connection)) -> Any:
        return _public_json(service.workspace(conn)["references"])

    @app.get("/api/purchasing/demands")
    def demands(conn: Any = Depends(connection)) -> Any:
        return _public_json(service.workspace(conn)["demands"])

    @app.get("/api/purchasing/quotes")
    def quotes(conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "list_quotes", {})

    @app.get("/api/purchasing/orders")
    def orders(conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "list_purchase_orders", {})

    @app.get("/api/purchasing/orders/{purchase_order_id}")
    def order(purchase_order_id: PositivePathInt, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "get_purchase_order", {"purchase_order_id": purchase_order_id})

    @app.get("/api/purchasing/demands/{demand_line_id}/comparison")
    def comparison(demand_line_id: PositivePathInt, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "compare_suppliers", {"demand_line_id": demand_line_id})

    @app.post("/api/purchasing/quotes", status_code=201)
    def quote(body: QuoteInput, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "create_quote", body.model_dump())

    @app.post("/api/purchasing/orders", status_code=201)
    def purchase(body: PurchaseInput, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "create_purchase_order", body.model_dump())

    @app.post("/api/purchasing/orders/{purchase_order_id}/lines", status_code=201)
    def line(purchase_order_id: PositivePathInt, body: PurchaseLineInput, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "add_purchase_line", {"purchase_order_id": purchase_order_id, **body.model_dump()})

    @app.post("/api/purchasing/lines/{po_line_id}/allocations", status_code=201)
    def allocation(po_line_id: PositivePathInt, body: AllocationInput, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "allocate_purchase_line", {"po_line_id": po_line_id, **body.model_dump()})

    @app.post("/api/purchasing/orders/{purchase_order_id}/approve")
    def approve(purchase_order_id: PositivePathInt, body: ApprovalInput, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "approve_purchase_order", {"purchase_order_id": purchase_order_id,
            "actor_id": service.actor_id(conn, settings.actor_ref), **body.model_dump()})

    @app.get("/api/purchasing/orders/{purchase_order_id}/progress")
    def progress(purchase_order_id: PositivePathInt, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "purchase_progress", {"purchase_order_id": purchase_order_id})

    @app.post("/api/purchasing/deliveries", status_code=201)
    def delivery(body: DeliveryInput, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "receive_delivery", body.model_dump())

    @app.get("/api/purchasing/stock/{item_id}/{location_id}")
    def summary(item_id: PositivePathInt, location_id: PositivePathInt, conn: Any = Depends(connection)) -> Any:
        return invoke(conn, "stock_summary", {"item_id": item_id, "location_id": location_id})

    from .records_api import register_routes
    register_routes(app, connection, _public_json)
    return app


app = create_app()
