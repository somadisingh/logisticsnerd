"""Authenticated transport for local business setup and registered-table records.

Only tables registered by the records service are exposed. Purchasing, approved
documents and the stock ledger never pass through the generic CRUD endpoints.
"""
from typing import Annotated, Any, Callable, Literal

from fastapi import Depends, FastAPI, Query
from pydantic import Field, StrictBool, StrictInt

from .http_models import Command, Input, NonNegativeInt, PositivePathInt


Name = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[a-z][a-z0-9_]*$")]
Label = Annotated[str, Field(min_length=1, max_length=100)]


class FieldDefinition(Input):
    slug: Name
    label: Label
    type: Literal["text", "integer", "money", "boolean", "date", "reference"]
    required: StrictBool = False
    unique: StrictBool = False
    target_table: Name | None = None
    min_value: StrictInt | None = None


class SetupInput(Command):
    business_name: Annotated[str, Field(min_length=1, max_length=200)]
    business_type: Annotated[str, Field(max_length=200)] = ""
    currency: Annotated[str, Field(pattern=r"^[A-Z]{3}$")]
    uses_inventory: StrictBool = True
    setup_notes: Annotated[str, Field(max_length=4000)] = ""


class TableInput(Command):
    slug: Name
    label: Label
    fields: Annotated[list[FieldDefinition], Field(min_length=1, max_length=50)]


class AddFieldInput(Command):
    field: FieldDefinition
    expected_version: NonNegativeInt


class RecordInput(Command):
    values: dict[str, Any]


class RecordUpdateInput(RecordInput):
    expected_version: NonNegativeInt


class VersionInput(Command):
    expected_version: NonNegativeInt


class ArchiveInput(VersionInput):
    archived: StrictBool


def register_routes(app: FastAPI, connection: Callable, public_json: Callable) -> None:
    from . import records

    prefix = "/api/business"

    @app.get(prefix + "/catalog")
    def catalog(conn: Any = Depends(connection)) -> Any:
        return public_json(records.catalog(conn))

    @app.post(prefix + "/setup")
    def setup(body: SetupInput, conn: Any = Depends(connection)) -> Any:
        return public_json(records.configure(conn, **body.model_dump()))

    @app.post(prefix + "/tables", status_code=201)
    def create_table(body: TableInput, conn: Any = Depends(connection)) -> Any:
        values = body.model_dump(exclude_none=True)
        return public_json(records.create_table(conn, **values))

    @app.post(prefix + "/tables/{table_slug}/fields", status_code=201)
    def add_field(table_slug: Name, body: AddFieldInput, conn: Any = Depends(connection)) -> Any:
        return public_json(records.add_field(conn, table_slug=table_slug, **body.model_dump(exclude_none=True)))

    @app.get(prefix + "/tables/{table_slug}/records")
    def list_records(table_slug: Name, include_archived: bool = Query(False), conn: Any = Depends(connection)) -> Any:
        return public_json(records.list_records(conn, table_slug=table_slug, include_archived=include_archived))

    @app.post(prefix + "/tables/{table_slug}/records", status_code=201)
    def create_record(table_slug: Name, body: RecordInput, conn: Any = Depends(connection)) -> Any:
        return public_json(records.create_record(conn, table_slug=table_slug, **body.model_dump()))

    @app.patch(prefix + "/tables/{table_slug}/records/{record_id}")
    def update_record(table_slug: Name, record_id: PositivePathInt, body: RecordUpdateInput, conn: Any = Depends(connection)) -> Any:
        return public_json(records.update_record(conn, table_slug=table_slug, record_id=record_id, **body.model_dump()))

    @app.delete(prefix + "/tables/{table_slug}/records/{record_id}")
    def delete_record(table_slug: Name, record_id: PositivePathInt, body: VersionInput, conn: Any = Depends(connection)) -> Any:
        return public_json(records.delete_record(conn, table_slug=table_slug, record_id=record_id, **body.model_dump()))

    @app.post(prefix + "/tables/{table_slug}/records/{record_id}/archive")
    def archive_record(table_slug: Name, record_id: PositivePathInt, body: ArchiveInput, conn: Any = Depends(connection)) -> Any:
        return public_json(records.archive_record(conn, table_slug=table_slug, record_id=record_id, **body.model_dump()))

    @app.post(prefix + "/orders/{record_id}/submit")
    def submit_order(record_id: PositivePathInt, body: VersionInput, conn: Any = Depends(connection)) -> Any:
        return public_json(records.submit_customer_order(conn, record_id=record_id, **body.model_dump()))
