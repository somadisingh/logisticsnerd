import demo from './data/demo.json';
import type { ProcurementRequest, RequestDraft, Supplier, SupplierQuote } from './domain/model';
import { parseMoney, validateDraft } from './domain/validate';

export const suppliers: Supplier[] = demo.suppliers.map((value) => ({
  id: value.id, name: value.name, initials: value.initials, contactInfo: value.contact_info,
}));

export function sampleDraft(): RequestDraft {
  const item = demo.requested_items[0];
  return { item: item.item_name, quantity: String(item.quantity), deadline: item.required_delivery_date, budget: String(demo.request.max_budget), supplierIds: [...demo.request.selected_supplier_ids] };
}

export function requestFromDraft(draft: RequestDraft): ProcurementRequest {
  if (Object.keys(validateDraft(draft)).length) throw new Error('Please correct the request before continuing.');
  if (draft.supplierIds.some((id) => !suppliers.some((supplier) => supplier.id === id))) throw new Error('Unknown supplier.');
  return {
    id: 'request-demo', buyerId: demo.buyer.id, createdAt: new Date().toISOString(),
    maxBudgetCents: draft.budget.trim() ? parseMoney(draft.budget) : null,
    selectedSupplierIds: [...draft.supplierIds],
    items: [{ id: 'item-demo', name: draft.item.trim(), quantity: Number(draft.quantity), requiredDate: draft.deadline }],
  };
}

export function mockQuotes(request: ProcurementRequest): SupplierQuote[] {
  const item = request.items[0];
  const sample = demo.requested_items[0];
  if (item.name.toLowerCase() !== sample.item_name.toLowerCase() || item.quantity !== sample.quantity) return [];
  return demo.supplier_quotes.filter((quote) => request.selectedSupplierIds.includes(quote.supplier_id)).map((quote) => {
    const line = demo.quote_items.find((value) => value.quote_id === quote.id);
    if (!line) throw new Error('The demo quote is missing its item.');
    return {
      id: quote.id, requestId: request.id, supplierId: quote.supplier_id,
      submittedAt: quote.submitted_at, notes: quote.notes,
      items: [{ requestedItemId: item.id, availableQuantity: line.available_quantity, price: { kind: 'total', cents: parseMoney(String(line.total_price)) }, expectedDate: line.expected_delivery_date }],
    };
  });
}
