import type { DraftErrors, ProcurementRequest, RequestDraft, SupplierQuote } from './model';

export function parseMoney(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error('Enter a nonnegative amount with up to two decimal places.');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('This amount is too large to compare accurately.');
  return cents;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

export function validateDraft(draft: RequestDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.item.trim()) errors.item = 'Enter the item you need.';
  if (!/^\d+$/.test(draft.quantity) || !Number.isSafeInteger(Number(draft.quantity)) || Number(draft.quantity) < 1) {
    errors.quantity = 'Enter a positive whole-number quantity.';
  }
  if (!isCalendarDate(draft.deadline)) errors.deadline = 'Choose a valid delivery deadline.';
  if (draft.budget.trim()) {
    try { parseMoney(draft.budget); }
    catch (error) { errors.budget = (error as Error).message; }
  }
  if (new Set(draft.supplierIds).size !== draft.supplierIds.length || draft.supplierIds.length < 3 || draft.supplierIds.length > 5) {
    errors.suppliers = 'Select 3–5 suppliers to compare.';
  }
  return errors;
}

function validCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateComparisonInput(request: ProcurementRequest, quotes: SupplierQuote[]): void {
  if (request.items.length !== 1) throw new Error('This demo compares one requested item at a time.');
  const item = request.items[0];
  if (!request.id || !item.id || !item.name.trim() || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !isCalendarDate(item.requiredDate)) {
    throw new Error('The request has an invalid item, quantity, or date.');
  }
  if (request.maxBudgetCents !== null && !validCents(request.maxBudgetCents)) throw new Error('The budget is invalid.');
  if (new Set(request.selectedSupplierIds).size !== request.selectedSupplierIds.length || request.selectedSupplierIds.length < 3 || request.selectedSupplierIds.length > 5) {
    throw new Error('Select 3–5 distinct suppliers.');
  }
  const suppliers = new Set<string>();
  const ids = new Set<string>();
  for (const quote of quotes) {
    if (!quote.id || ids.has(quote.id) || suppliers.has(quote.supplierId)) throw new Error('Duplicate or invalid quote.');
    if (quote.requestId !== request.id || !request.selectedSupplierIds.includes(quote.supplierId)) throw new Error('The quote does not belong to this selected request.');
    if (quote.items.length !== 1 || quote.items[0].requestedItemId !== item.id) throw new Error('The quote does not match the requested item.');
    const line = quote.items[0];
    if (!Number.isSafeInteger(line.availableQuantity) || line.availableQuantity < 0 || !isCalendarDate(line.expectedDate)) throw new Error('The quote has invalid availability or delivery date.');
    if (!['total', 'unit'].includes(line.price.kind) || !validCents(line.price.cents)) throw new Error('The quote price is invalid.');
    const total = line.price.kind === 'unit' ? line.price.cents * item.quantity : line.price.cents;
    if (!validCents(total)) throw new Error('The quote total is too large to compare accurately.');
    ids.add(quote.id);
    suppliers.add(quote.supplierId);
  }
}
