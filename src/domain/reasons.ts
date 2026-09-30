import type { ComparisonResult, Evaluation, ProcurementRequest, Rejection } from './model';

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

export function dateLabel(date: string, includeYear = false): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(includeYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export function deliveryGapDays(earlier: string, later: string): number {
  return (Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) / 86_400_000;
}

export function rejectionText(reason: Rejection): string {
  switch (reason.code) {
    case 'quantity': return `${reason.actual} available; ${reason.required} required.`;
    case 'deadline': {
      const actual = String(reason.actual);
      const required = String(reason.required);
      const differentYears = actual.slice(0, 4) !== required.slice(0, 4);
      return `Delivery ${dateLabel(actual, differentYears)} is after ${dateLabel(required, differentYears)}.`;
    }
    case 'budget': return `${money(Number(reason.actual))} exceeds your ${money(Number(reason.required))} budget.`;
  }
}

export function evaluationReason(value: Evaluation, result: ComparisonResult, request: ProcurementRequest): string {
  if (!value.feasible) return value.rejections.map(rejectionText).join(' ');
  const essentials = request.maxBudgetCents === null ? 'quantity and deadline' : 'quantity, deadline, and budget';
  const earliest = result.preference === 'earliest_delivery';
  if (result.recommendedSupplierIds.includes(value.supplierId)) {
    return result.outcome === 'tied' ? `Meets ${essentials}; tied on price and delivery.` : `Meets ${essentials}; ${earliest ? 'earliest feasible delivery' : 'lowest feasible total'}.`;
  }
  const best = result.feasible[0];
  if (earliest) {
    if (value.expectedDate === best.expectedDate) return `Same delivery date; the recommended quote has a lower total.`;
    const days = deliveryGapDays(best.expectedDate, value.expectedDate);
    const priceDifference = value.totalCents - best.totalCents;
    return `Meets ${essentials}; delivery ${days} ${days === 1 ? 'day' : 'days'} later than the recommended quote${priceDifference === 0 ? ' at the same price' : ` for ${money(Math.abs(priceDifference))} ${priceDifference < 0 ? 'less' : 'more'}`}.`;
  }
  return value.totalCents === best.totalCents
    ? `Same total price; the recommended quote promises earlier delivery.`
    : `Meets ${essentials}; ${money(value.totalCents - best.totalCents)} more than the recommended quote.`;
}
