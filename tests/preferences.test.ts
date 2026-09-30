import { describe, expect, it } from 'vitest';
import { mockQuotes, requestFromDraft, sampleDraft } from '../src/data';
import { compareQuotes } from '../src/domain/compare';
import type { PurchasingPreference } from '../src/domain/model';
import { deliveryGapDays, evaluationReason } from '../src/domain/reasons';

function fixture(id = 'chairs') {
  const request = requestFromDraft(sampleDraft(id));
  return { request, quotes: mockQuotes(request) };
}

describe('purchasing preferences', () => {
  it.each([
    ['chairs', 'metro', 'comfort'],
    ['paper', 'paper-everyday', 'paper-express'],
    ['boxes', 'boxes-carton', 'boxes-quick'],
  ])('%s defaults to lowest cost and can choose earliest feasible delivery', (id, cheapest, earliest) => {
    const { request, quotes } = fixture(id);
    expect(compareQuotes(request, quotes).recommendedSupplierIds).toEqual([cheapest]);
    const fast = compareQuotes(request, quotes, 'earliest_delivery');
    expect(fast.recommendedSupplierIds).toEqual([earliest]);
    expect(fast.preference).toBe('earliest_delivery');
  });

  it('continues enforcing the budget even when a faster quote is available', () => {
    const { request, quotes } = fixture('boxes');
    const fast = compareQuotes(request, quotes, 'earliest_delivery');
    expect(fast.evaluations.find((value) => value.supplierId === 'boxes-premier')?.feasible).toBe(false);
    request.maxBudgetCents = 30000;
    expect(compareQuotes(request, quotes, 'earliest_delivery').recommendedSupplierIds).toEqual(['boxes-carton']);
    request.maxBudgetCents = null;
    expect(compareQuotes(request, quotes, 'earliest_delivery').recommendedSupplierIds).toEqual(['boxes-premier']);
  });

  it('never makes insufficient stock or a missed deadline feasible through preference changes', () => {
    const { request, quotes } = fixture();
    quotes[2].items[0].expectedDate = '2026-10-01';
    const cost = compareQuotes(request, quotes);
    const fast = compareQuotes(request, quotes, 'earliest_delivery');
    expect(fast.evaluations).toEqual(cost.evaluations);
    expect(fast.recommendedSupplierIds).toEqual(['comfort']);
    request.items[0].requiredDate = '2026-10-09';
    expect(compareQuotes(request, quotes, 'earliest_delivery').outcome).toBe('no_feasible_quote');
  });

  it('breaks an earliest-delivery tie with lower total cost', () => {
    const { request, quotes } = fixture();
    quotes[0].items[0].expectedDate = quotes[1].items[0].expectedDate;
    expect(compareQuotes(request, quotes, 'earliest_delivery').recommendedSupplierIds).toEqual(['metro']);
    const result = compareQuotes(request, quotes, 'earliest_delivery');
    expect(evaluationReason(result.evaluations[1], result, request)).toContain('Same delivery date; the recommended quote has a lower total');
  });

  it.each<PurchasingPreference>(['lowest_cost', 'earliest_delivery'])('keeps complete price/date ties visible with %s', (preference) => {
    const { request, quotes } = fixture();
    quotes[0].items[0].expectedDate = quotes[1].items[0].expectedDate;
    quotes[1].items[0].price.cents = quotes[0].items[0].price.cents;
    const result = compareQuotes(request, quotes, preference);
    expect(result.outcome).toBe('tied');
    expect(new Set(result.recommendedSupplierIds)).toEqual(new Set(['metro', 'comfort']));
    expect(evaluationReason(result.feasible[0], result, request)).toContain('tied on price and delivery');
  });

  it('explains a cheaper, later alternative without calling the earliest winner cheapest', () => {
    const { request, quotes } = fixture();
    const result = compareQuotes(request, quotes, 'earliest_delivery');
    expect(evaluationReason(result.feasible[0], result, request)).toContain('earliest feasible delivery');
    expect(evaluationReason(result.evaluations[0], result, request)).toContain('2 days later than the recommended quote for $700 less');
    expect(evaluationReason(result.feasible[0], result, request)).not.toContain('lowest');
  });

  it('handles later delivery at an equal or higher price accurately', () => {
    const { request, quotes } = fixture();
    quotes[0].items[0].price.cents = quotes[1].items[0].price.cents;
    let result = compareQuotes(request, quotes, 'earliest_delivery');
    expect(evaluationReason(result.evaluations[0], result, request)).toContain('at the same price.');
    quotes[0].items[0].price.cents += 100;
    result = compareQuotes(request, quotes, 'earliest_delivery');
    expect(evaluationReason(result.evaluations[0], result, request)).toContain('for $1 more.');
  });

  it('does not mutate quote facts and remains independent of input order', () => {
    const { request, quotes } = fixture('boxes');
    const original = structuredClone(quotes);
    expect(compareQuotes(request, [...quotes].reverse(), 'earliest_delivery').recommendedSupplierIds).toEqual(['boxes-quick']);
    expect(quotes).toEqual(original);
    expect(compareQuotes(request, quotes).recommendedSupplierIds).toEqual(['boxes-carton']);
  });

  it('preserves the distinct no-quotes outcome for either priority', () => {
    const { request } = fixture();
    expect(compareQuotes(request, [], 'earliest_delivery').outcome).toBe('no_quotes');
  });

  it('calculates calendar-day differences across month, leap-year, and year boundaries', () => {
    expect(deliveryGapDays('2026-10-06', '2026-10-11')).toBe(5);
    expect(deliveryGapDays('2024-02-28', '2024-03-01')).toBe(2);
    expect(deliveryGapDays('2026-12-31', '2027-01-01')).toBe(1);
    expect(deliveryGapDays('2026-10-06', '2026-10-06')).toBe(0);
  });

  it('rejects an unknown runtime priority rather than silently ranking by another rule', () => {
    const { request, quotes } = fixture();
    expect(() => compareQuotes(request, quotes, 'balanced' as PurchasingPreference)).toThrow('purchasing preference');
  });
});
