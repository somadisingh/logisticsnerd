import type { ComparisonResult, Evaluation, ProcurementRequest, PurchasingPreference, Rejection, SupplierQuote } from './model';
import { validateComparisonInput } from './validate';

export function compareQuotes(request: ProcurementRequest, quotes: SupplierQuote[], preference: PurchasingPreference = 'lowest_cost'): ComparisonResult {
  if (!['lowest_cost', 'earliest_delivery'].includes(preference)) throw new Error('Choose a valid purchasing preference.');
  validateComparisonInput(request, quotes);
  const item = request.items[0];
  const evaluations: Evaluation[] = quotes.map((quote) => {
    const line = quote.items[0];
    const totalCents = line.price.kind === 'unit' ? line.price.cents * item.quantity : line.price.cents;
    const rejections: Rejection[] = [];
    if (line.availableQuantity < item.quantity) rejections.push({ code: 'quantity', actual: line.availableQuantity, required: item.quantity });
    if (line.expectedDate > item.requiredDate) rejections.push({ code: 'deadline', actual: line.expectedDate, required: item.requiredDate });
    if (request.maxBudgetCents !== null && totalCents > request.maxBudgetCents) rejections.push({ code: 'budget', actual: totalCents, required: request.maxBudgetCents });
    return { quoteId: quote.id, supplierId: quote.supplierId, availableQuantity: line.availableQuantity, expectedDate: line.expectedDate, totalCents, feasible: rejections.length === 0, rejections };
  });
  const feasible = evaluations.filter((value) => value.feasible).sort((a, b) => {
    const priceOrder = a.totalCents - b.totalCents;
    const dateOrder = a.expectedDate.localeCompare(b.expectedDate);
    return (preference === 'lowest_cost' ? priceOrder || dateOrder : dateOrder || priceOrder) || a.supplierId.localeCompare(b.supplierId);
  });
  const best = feasible[0];
  const recommendedSupplierIds = best
    ? feasible.filter((value) => value.totalCents === best.totalCents && value.expectedDate === best.expectedDate).map((value) => value.supplierId)
    : [];
  const outcome = quotes.length === 0 ? 'no_quotes' : !best ? 'no_feasible_quote' : recommendedSupplierIds.length > 1 ? 'tied' : 'recommended';
  return { preference, outcome, evaluations, feasible, recommendedSupplierIds };
}
