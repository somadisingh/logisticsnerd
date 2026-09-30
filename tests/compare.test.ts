import { describe, expect, it } from 'vitest';
import { mockQuotes, requestFromDraft, sampleDraft } from '../src/data';
import { compareQuotes } from '../src/domain/compare';
import { dateLabel, evaluationReason, rejectionText } from '../src/domain/reasons';
import { isCalendarDate, parseMoney, validateDraft } from '../src/domain/validate';

function fixture() {
  const request = requestFromDraft(sampleDraft());
  return { request, quotes: mockQuotes(request) };
}

describe('supplier selection', () => {
  it('reproduces the brief: A wins, B costs $700 more, C cannot supply 50', () => {
    const { request, quotes } = fixture();
    const result = compareQuotes(request, quotes);
    expect(result.outcome).toBe('recommended');
    expect(result.recommendedSupplierIds).toEqual(['metro']);
    expect(result.evaluations.map((value) => [value.supplierId, value.totalCents, value.feasible])).toEqual([
      ['metro', 450000, true], ['comfort', 520000, true], ['budget', 380000, false],
    ]);
    expect(evaluationReason(result.evaluations[1], result, request)).toContain('$700 more');
    expect(result.evaluations[2].rejections).toEqual([{ code: 'quantity', actual: 35, required: 50 }]);
  });

  it('allows quantity, deadline, and budget equality', () => {
    const { request, quotes } = fixture();
    request.items[0].requiredDate = '2026-10-12';
    request.maxBudgetCents = 450000;
    expect(compareQuotes(request, quotes).recommendedSupplierIds).toEqual(['metro']);
  });

  it('rejects a total that is one cent over budget', () => {
    const { request, quotes } = fixture();
    request.maxBudgetCents = 449999;
    expect(compareQuotes(request, quotes).evaluations[0].rejections).toEqual([{ code: 'budget', actual: 450000, required: 449999 }]);
  });

  it('prefers an earlier delivery only when price is equal', () => {
    const { request, quotes } = fixture();
    quotes[1].items[0].price.cents = 450000;
    expect(compareQuotes(request, quotes).recommendedSupplierIds).toEqual(['comfort']);
  });

  it('shows both best choices for a complete tie', () => {
    const { request, quotes } = fixture();
    quotes[1].items[0].price.cents = 450000;
    quotes[1].items[0].expectedDate = quotes[0].items[0].expectedDate;
    const result = compareQuotes(request, quotes);
    expect(result.outcome).toBe('tied');
    expect(new Set(result.recommendedSupplierIds)).toEqual(new Set(['comfort', 'metro']));
  });

  it('collects every failed constraint on a quote', () => {
    const { request, quotes } = fixture();
    request.maxBudgetCents = 300000;
    quotes[2].items[0].expectedDate = '2026-10-16';
    expect(compareQuotes(request, quotes).evaluations[2].rejections.map((value) => value.code)).toEqual(['quantity', 'deadline', 'budget']);
  });

  it('returns no winner when no quote qualifies', () => {
    const { request, quotes } = fixture();
    request.items[0].requiredDate = '2026-10-09';
    const result = compareQuotes(request, quotes);
    expect(result.outcome).toBe('no_feasible_quote');
    expect(result.recommendedSupplierIds).toEqual([]);
    expect(result.evaluations.every((value) => !value.feasible)).toBe(true);
  });

  it('selects B when the deadline moves to October 10', () => {
    const { request, quotes } = fixture();
    request.items[0].requiredDate = '2026-10-10';
    expect(compareQuotes(request, quotes).recommendedSupplierIds).toEqual(['comfort']);
  });

  it('omits the budget rule and budget claims when no limit is set', () => {
    const { request, quotes } = fixture();
    request.maxBudgetCents = null;
    const result = compareQuotes(request, quotes);
    expect(result.recommendedSupplierIds).toEqual(['metro']);
    expect(evaluationReason(result.evaluations[0], result, request)).not.toContain('budget');
  });

  it('enforces an explicitly zero budget while allowing an explicit zero-price offer', () => {
    const { request, quotes } = fixture();
    request.maxBudgetCents = 0;
    expect(compareQuotes(request, quotes).outcome).toBe('no_feasible_quote');
    quotes[0].items[0].price.cents = 0;
    expect(compareQuotes(request, quotes).recommendedSupplierIds).toEqual(['metro']);
  });

  it('calculates unit-price cost using requested quantity, not availability', () => {
    const { request, quotes } = fixture();
    quotes[0].items[0].price = { kind: 'unit', cents: 9000 };
    quotes[0].items[0].availableQuantity = 100;
    expect(compareQuotes(request, quotes).evaluations[0].totalCents).toBe(450000);
  });

  it('separates no response from business infeasibility', () => {
    const { request } = fixture();
    expect(compareQuotes(request, []).outcome).toBe('no_quotes');
  });

  it('is independent of quote submission order', () => {
    const { request, quotes } = fixture();
    expect(compareQuotes(request, [...quotes].reverse()).recommendedSupplierIds).toEqual(['metro']);
  });

  it('rejects broken request, item, supplier, and duplicate quote relationships', () => {
    const { request, quotes } = fixture();
    const wrongRequest = structuredClone(quotes);
    wrongRequest[0].requestId = 'other';
    expect(() => compareQuotes(request, wrongRequest)).toThrow('selected request');
    const wrongItem = structuredClone(quotes);
    wrongItem[0].items[0].requestedItemId = 'other';
    expect(() => compareQuotes(request, wrongItem)).toThrow('requested item');
    const wrongSupplier = structuredClone(quotes);
    wrongSupplier[0].supplierId = 'other';
    expect(() => compareQuotes(request, wrongSupplier)).toThrow('selected request');
    expect(() => compareQuotes(request, [quotes[0], quotes[0]])).toThrow('Duplicate');
  });

  it('rejects malformed quote facts instead of silently changing the winner', () => {
    const { request, quotes } = fixture();
    quotes[0].items[0].expectedDate = '2026-02-30';
    expect(() => compareQuotes(request, quotes)).toThrow('delivery date');
    quotes[0].items[0].expectedDate = '2026-10-12';
    quotes[0].items[0].price.cents = NaN;
    expect(() => compareQuotes(request, quotes)).toThrow('price');
  });

  it('rejects integer-overflow totals', () => {
    const { request, quotes } = fixture();
    quotes[0].items[0].price = { kind: 'unit', cents: Number.MAX_SAFE_INTEGER };
    expect(() => compareQuotes(request, quotes)).toThrow('too large');
  });

  it('accepts zero available quantity as a submitted but infeasible quote', () => {
    const { request, quotes } = fixture();
    quotes[0].items[0].availableQuantity = 0;
    expect(compareQuotes(request, quotes).evaluations[0].rejections[0]).toEqual({ code: 'quantity', actual: 0, required: 50 });
  });

  it('does not invent prices for changed items or quantities', () => {
    const draft = sampleDraft();
    draft.item = 'Printer paper';
    expect(mockQuotes(requestFromDraft(draft))).toEqual([]);
    draft.item = 'Office chairs';
    draft.quantity = '100';
    expect(mockQuotes(requestFromDraft(draft))).toEqual([]);
  });
});

describe('input normalization', () => {
  it('parses cents exactly and distinguishes zero from blank budget', () => {
    expect(parseMoney('4500.01')).toBe(450001);
    expect(parseMoney('0.29')).toBe(29);
    expect(parseMoney('6000')).toBe(600000);
    expect(parseMoney('0')).toBe(0);
    const draft = sampleDraft();
    draft.budget = '0';
    expect(requestFromDraft(draft).maxBudgetCents).toBe(0);
    draft.budget = '';
    expect(requestFromDraft(draft).maxBudgetCents).toBeNull();
  });

  it('rejects negative amounts, excessive decimals, and unsafe totals', () => {
    for (const amount of ['-1', '1.001', '', 'NaN', '1e9', '9007199254740992']) expect(() => parseMoney(amount)).toThrow();
  });

  it('validates the calendar and leap-year boundaries', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-04-31', '0000-01-01', '2026-1-1']) expect(isCalendarDate(value)).toBe(false);
    expect(isCalendarDate('2000-02-29')).toBe(true);
    expect(isCalendarDate('1900-02-29')).toBe(false);
  });

  it('returns field-specific request errors', () => {
    expect(Object.keys(validateDraft({ item: ' ', quantity: '1.5', deadline: '2026-02-30', budget: '-1', supplierIds: [] })).sort()).toEqual(['budget', 'deadline', 'item', 'quantity', 'suppliers']);
    expect(validateDraft(sampleDraft())).toEqual({});
  });

  it('formats dates without a local timezone shifting the day', () => {
    expect(dateLabel('2026-10-15', true)).toBe('Oct 15, 2026');
    expect(rejectionText({ code: 'deadline', actual: '2026-10-18', required: '2026-10-15' })).toBe('Delivery Oct 18 is after Oct 15.');
  });

  it('includes years when a deadline explanation spans different years', () => {
    expect(rejectionText({ code: 'deadline', actual: '2026-10-12', required: '2025-10-15' })).toBe('Delivery Oct 12, 2026 is after Oct 15, 2025.');
  });
});
