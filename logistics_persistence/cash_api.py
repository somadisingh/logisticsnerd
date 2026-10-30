"""Owner-authenticated HTTP interface for supplier balances, payments and cash."""
from datetime import date
from typing import Any, Callable

from fastapi import Depends, FastAPI

from .http_models import Command, NonNegativeInt, PositiveInt


class SupplierPaymentInput(Command):
    supplier_id: PositiveInt
    amount_minor: PositiveInt
    paid_on: date


class OpeningCashInput(Command):
    amount_minor: NonNegativeInt
    as_of: date


def register_routes(app: FastAPI, connection: Callable, public_json: Callable) -> None:
    from . import cash

    prefix = '/api/cash'

    @app.get(prefix + '/suppliers')
    def suppliers(conn: Any = Depends(connection)) -> Any:
        return public_json(cash.supplier_balances(conn))

    @app.get(prefix + '/balance')
    def balance(conn: Any = Depends(connection)) -> Any:
        return public_json(cash.cash_balance(conn))

    @app.post(prefix + '/supplier-payments', status_code=201)
    def pay_supplier(body: SupplierPaymentInput, conn: Any = Depends(connection)) -> Any:
        payload = body.model_dump()
        payload['paid_on'] = body.paid_on.isoformat()
        return public_json(cash.record_supplier_payment(conn, **payload))

    @app.post(prefix + '/opening', status_code=201)
    def opening(body: OpeningCashInput, conn: Any = Depends(connection)) -> Any:
        payload = body.model_dump()
        payload['as_of'] = body.as_of.isoformat()
        return public_json(cash.record_opening_cash(conn, **payload))
