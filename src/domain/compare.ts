import type { ComparisonResult, Evaluation, ProcurementRequest, Rejection, SupplierQuote } from './model';
import { validateComparisonInput } from './validate';

export function compareQuotes(request: ProcurementRequest, quotes: SupplierQuote[]): ComparisonResult {
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
  const feasible = evaluations.filter((value) => value.feasible).sort((a, b) =>
    a.totalCents - b.totalCents || a.expectedDate.localeCompare(b.expectedDate) || a.supplierId.localeCompare(b.supplierId));
  const best = feasible[0];
  const recommendedSupplierIds = best
    ? feasible.filter((value) => value.totalCents === best.totalCents && value.expectedDate === best.expectedDate).map((value) => value.supplierId)
    : [];
  const outcome = quotes.length === 0 ? 'no_quotes' : !best ? 'no_feasible_quote' : recommendedSupplierIds.length > 1 ? 'tied' : 'recommended';
  return { outcome, evaluations, feasible, recommendedSupplierIds };
}
