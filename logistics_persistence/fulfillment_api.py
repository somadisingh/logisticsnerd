"""Owner-authenticated HTTP interface for existing stock shipping commands."""
from datetime import date
from typing import Annotated, Any, Callable, Literal

from fastapi import Depends, FastAPI
from pydantic import AwareDatetime, Field, model_validator

from .http_models import Command, PositiveInt, PositivePathInt

Text = Annotated[str, Field(min_length=1, max_length=200)]
Reference = Annotated[str, Field(min_length=1, max_length=500)]


class ShipmentInput(Command):
    shipment_number: Text
    order_ref: Text


class ShipmentLineInput(Command):
    reservation_id: PositiveInt
    quantity: PositiveInt


class DispatchInput(Command):
    carrier: Text
    as_of: date
    label_ref: Reference | None = None
    tracking_ref: Reference | None = None

    @model_validator(mode='after')
    def has_reference(self):
        if not (self.label_ref or self.tracking_ref):
            raise ValueError('A label or tracking reference is required to dispatch')
        return self


class TrackingInput(Command):
    event: Literal['in_transit', 'out_for_delivery', 'delivery_failed', 'delivered', 'exception']
    occurred_at: AwareDatetime
    detail: Annotated[str, Field(max_length=4000)] | None = None


def register_routes(app: FastAPI, connection: Callable, public_json: Callable) -> None:
    from . import fulfillment

    prefix = '/api/fulfillment'

    @app.get(prefix + '/workspace')
    def workspace(conn: Any = Depends(connection)) -> Any:
        return public_json(fulfillment.workspace(conn))

    @app.get(prefix + '/shipments')
    def shipments(conn: Any = Depends(connection)) -> Any:
        return public_json(fulfillment.list_shipments(conn))

    @app.get(prefix + '/shipments/{shipment_id}')
    def shipment(shipment_id: PositivePathInt, conn: Any = Depends(connection)) -> Any:
        return public_json(fulfillment.shipment(conn, shipment_id))

    @app.post(prefix + '/shipments', status_code=201)
    def create_shipment(body: ShipmentInput, conn: Any = Depends(connection)) -> Any:
        return public_json(fulfillment.create_shipment(conn, **body.model_dump()))

    @app.post(prefix + '/shipments/{shipment_id}/lines', status_code=201)
    def add_line(shipment_id: PositivePathInt, body: ShipmentLineInput, conn: Any = Depends(connection)) -> Any:
        return public_json(fulfillment.add_shipment_line(conn, shipment_id=shipment_id, **body.model_dump()))

    @app.post(prefix + '/shipments/{shipment_id}/dispatch')
    def dispatch(shipment_id: PositivePathInt, body: DispatchInput, conn: Any = Depends(connection)) -> Any:
        payload = body.model_dump()
        payload['as_of'] = body.as_of.isoformat()
        return public_json(fulfillment.dispatch(conn, shipment_id=shipment_id, **payload))

    @app.post(prefix + '/shipments/{shipment_id}/events', status_code=201)
    def record_event(shipment_id: PositivePathInt, body: TrackingInput, conn: Any = Depends(connection)) -> Any:
        payload = body.model_dump()
        payload['occurred_at'] = body.occurred_at.isoformat()
        return public_json(fulfillment.record_tracking_event(conn, shipment_id=shipment_id, **payload))
