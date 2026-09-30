export interface RequestedItem {
  id: string;
  name: string;
  quantity: number;
  requiredDate: string;
  unitLabel?: string;
}

export interface ProcurementRequest {
  id: string;
  buyerId: string;
  createdAt: string;
  maxBudgetCents: number | null;
  selectedSupplierIds: string[];
  items: RequestedItem[];
}

export interface Supplier {
  id: string;
  name: string;
  initials: string;
  contactInfo: string;
}

export type QuotePrice =
  | { kind: 'total'; cents: number }
  | { kind: 'unit'; cents: number };

export interface QuoteItem {
  requestedItemId: string;
  availableQuantity: number;
  price: QuotePrice;
  expectedDate: string;
}

export interface SupplierQuote {
  id: string;
  requestId: string;
  supplierId: string;
  submittedAt: string;
  notes?: string;
  items: QuoteItem[];
}

export type RejectionCode = 'quantity' | 'deadline' | 'budget';

export interface Rejection {
  code: RejectionCode;
  actual: number | string;
  required: number | string;
}

export interface Evaluation {
  quoteId: string;
  supplierId: string;
  availableQuantity: number;
  expectedDate: string;
  totalCents: number;
  feasible: boolean;
  rejections: Rejection[];
}

export type PurchasingPreference = 'lowest_cost' | 'earliest_delivery';

export interface ComparisonResult {
  preference: PurchasingPreference;
  outcome: 'recommended' | 'tied' | 'no_feasible_quote' | 'no_quotes';
  evaluations: Evaluation[];
  recommendedSupplierIds: string[];
  feasible: Evaluation[];
}

export interface RequestDraft {
  item: string;
  quantity: string;
  deadline: string;
  budget: string;
  supplierIds: string[];
}

export type DraftErrors = Partial<Record<'item' | 'quantity' | 'deadline' | 'budget' | 'suppliers', string>>;
