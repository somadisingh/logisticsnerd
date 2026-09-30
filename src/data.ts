import demo from './data/demo.json';
import expanded from './data/scenarios.json';
import type { ProcurementRequest, RequestDraft, Supplier, SupplierQuote } from './domain/model';
import { parseMoney, validateDraft } from './domain/validate';

interface DemoOffer extends Supplier {
  availableQuantity: number;
  totalCents: number;
  expectedDate: string;
}

export interface DemoScenario {
  id: string;
  title: string;
  description: string;
  lesson: string;
  unitLabel: string;
  itemName: string;
  quantity: number;
  deadline: string;
  budget: number;
  suppliers: DemoOffer[];
}

interface OfferSource {
  id: string;
  name: string;
  initials: string;
  contact_info: string;
  available_quantity: number;
  total_price: number;
  expected_delivery_date: string;
}

function offerFromSource(value: OfferSource): DemoOffer {
  return {
    id: value.id, name: value.name, initials: value.initials, contactInfo: value.contact_info,
    availableQuantity: value.available_quantity, totalCents: parseMoney(String(value.total_price)), expectedDate: value.expected_delivery_date,
  };
}

const originalItem = demo.requested_items[0];
export const scenarios: DemoScenario[] = [
  {
    id: 'chairs', title: 'Office chairs', description: 'Office seating · one complete order', lesson: 'A low price needs enough stock to work.', unitLabel: 'chairs',
    itemName: originalItem.item_name, quantity: originalItem.quantity, deadline: originalItem.required_delivery_date, budget: demo.request.max_budget,
    suppliers: [
      ...demo.suppliers.map((supplier) => {
        const quote = demo.supplier_quotes.find((value) => value.supplier_id === supplier.id)!;
        const line = demo.quote_items.find((value) => value.quote_id === quote.id)!;
        return offerFromSource({ ...supplier, ...line });
      }),
      ...expanded.chair_suppliers.map(offerFromSource),
    ],
  },
  ...expanded.additional.map((value) => ({
    id: value.id, title: value.title, description: value.description, lesson: value.lesson, unitLabel: value.unit_label,
    itemName: value.item_name, quantity: value.quantity, deadline: value.required_delivery_date, budget: value.max_budget,
    suppliers: value.suppliers.map(offerFromSource),
  })),
];

export const suppliers: Supplier[] = scenarios.flatMap((scenario) => scenario.suppliers);

export function scenarioForItem(name: string): DemoScenario | undefined {
  return scenarios.find((scenario) => scenario.itemName.toLowerCase() === name.trim().toLowerCase());
}

export function sampleDraft(scenarioId = 'chairs'): RequestDraft {
  const scenario = scenarios.find((value) => value.id === scenarioId);
  if (!scenario) throw new Error('Unknown demo scenario.');
  return {
    item: scenario.itemName, quantity: String(scenario.quantity), deadline: scenario.deadline,
    budget: String(scenario.budget), supplierIds: scenario.suppliers.map((supplier) => supplier.id),
  };
}

export function requestFromDraft(draft: RequestDraft): ProcurementRequest {
  if (Object.keys(validateDraft(draft)).length) throw new Error('Please correct the request before continuing.');
  if (draft.supplierIds.some((id) => !suppliers.some((supplier) => supplier.id === id))) throw new Error('Unknown supplier.');
  return {
    id: 'request-demo', buyerId: demo.buyer.id, createdAt: new Date().toISOString(),
    maxBudgetCents: draft.budget.trim() ? parseMoney(draft.budget) : null,
    selectedSupplierIds: [...draft.supplierIds],
    items: [{ id: 'item-demo', name: draft.item.trim(), quantity: Number(draft.quantity), requiredDate: draft.deadline, unitLabel: scenarioForItem(draft.item)?.unitLabel ?? 'units' }],
  };
}

export function mockQuotes(request: ProcurementRequest): SupplierQuote[] {
  const item = request.items[0];
  const scenario = scenarioForItem(item.name);
  if (!scenario || item.quantity !== scenario.quantity) return [];
  return scenario.suppliers.filter((supplier) => request.selectedSupplierIds.includes(supplier.id)).map((supplier) => ({
    id: `quote-${supplier.id}`, requestId: request.id, supplierId: supplier.id,
    submittedAt: '2026-09-29T13:00:00Z',
    items: [{ requestedItemId: item.id, availableQuantity: supplier.availableQuantity, price: { kind: 'total', cents: supplier.totalCents }, expectedDate: supplier.expectedDate }],
  }));
}
