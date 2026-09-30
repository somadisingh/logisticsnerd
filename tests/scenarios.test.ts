import { describe, expect, it } from 'vitest';
import { mockQuotes, requestFromDraft, sampleDraft, scenarios } from '../src/data';
import { compareQuotes } from '../src/domain/compare';

function compareScenario(id: string, changes: Partial<ReturnType<typeof sampleDraft>> = {}) {
  const request = requestFromDraft({ ...sampleDraft(id), ...changes });
  const quotes = mockQuotes(request);
  return { request, quotes, result: compareQuotes(request, quotes) };
}

describe('curated buying scenarios', () => {
  it.each([
    ['chairs', 5, 'metro', 450000, 3],
    ['paper', 4, 'paper-everyday', 48000, 2],
    ['boxes', 5, 'boxes-carton', 28000, 3],
  ])('%s has the correct supplier set, winner, price, and feasible count', (id, count, winner, cents, feasibleCount) => {
    const { request, quotes, result } = compareScenario(String(id));
    expect(request.selectedSupplierIds).toHaveLength(Number(count));
    expect(quotes).toHaveLength(Number(count));
    expect(result.recommendedSupplierIds).toEqual([winner]);
    expect(result.feasible[0].totalCents).toBe(cents);
    expect(result.feasible).toHaveLength(Number(feasibleCount));
    expect(quotes.every((quote) => quote.requestId === request.id && quote.items[0].requestedItemId === request.items[0].id)).toBe(true);
  });

  it('preserves the original chair quote values when adding suppliers', () => {
    const { result } = compareScenario('chairs');
    expect(result.evaluations.slice(0, 3).map((value) => [value.supplierId, value.availableQuantity, value.totalCents, value.expectedDate])).toEqual([
      ['metro', 50, 450000, '2026-10-12'], ['comfort', 50, 520000, '2026-10-10'], ['budget', 35, 380000, '2026-10-14'],
    ]);
    expect(result.evaluations.find((value) => value.supplierId === 'atelier')?.rejections.map((reason) => reason.code)).toEqual(['deadline']);
  });

  it('rejects the cheapest paper quote because it arrives late', () => {
    const { result } = compareScenario('paper');
    const cheapest = result.evaluations.find((value) => value.supplierId === 'paper-value')!;
    expect(cheapest.totalCents).toBeLessThan(result.feasible[0].totalCents);
    expect(cheapest.rejections.map((reason) => reason.code)).toEqual(['deadline']);
  });

  it('makes the cheapest paper quote eligible after extending the deadline', () => {
    expect(compareScenario('paper', { deadline: '2026-10-10' }).result.recommendedSupplierIds).toEqual(['paper-value']);
  });

  it('chooses the earlier paper delivery only when a tighter deadline requires it', () => {
    expect(compareScenario('paper', { deadline: '2026-10-05' }).result.recommendedSupplierIds).toEqual(['paper-express']);
  });

  it('keeps cheaper boxes recommended over a faster, more expensive feasible offer', () => {
    const { result } = compareScenario('boxes');
    const faster = result.feasible.find((value) => value.supplierId === 'boxes-quick')!;
    expect(faster.expectedDate < result.feasible[0].expectedDate).toBe(true);
    expect(faster.totalCents - result.feasible[0].totalCents).toBe(7000);
  });

  it('rejects insufficient stock and an over-budget box quote separately', () => {
    const { result } = compareScenario('boxes');
    expect(result.evaluations.find((value) => value.supplierId === 'boxes-budget')?.rejections.map((reason) => reason.code)).toEqual(['quantity']);
    expect(result.evaluations.find((value) => value.supplierId === 'boxes-premier')?.rejections.map((reason) => reason.code)).toEqual(['budget']);
  });

  it('reevaluates the box delivery trade-off and still enforces the budget', () => {
    expect(compareScenario('boxes', { deadline: '2026-10-06' }).result.recommendedSupplierIds).toEqual(['boxes-quick']);
    expect(compareScenario('boxes', { deadline: '2026-10-06', budget: '300' }).result.outcome).toBe('no_feasible_quote');
    expect(compareScenario('boxes', { deadline: '2026-10-06', budget: '' }).result.recommendedSupplierIds).toEqual(['boxes-quick']);
  });

  it.each(['chairs', 'paper', 'boxes'])('%s never rescales quotes for an unsupported quantity', (id) => {
    const draft = sampleDraft(id);
    draft.quantity = String(Number(draft.quantity) + 1);
    expect(mockQuotes(requestFromDraft(draft))).toEqual([]);
  });

  it('returns quotes only from the selected suppliers, with no scenario leakage', () => {
    const draft = sampleDraft('boxes');
    draft.supplierIds = ['boxes-quick', 'boxes-budget', 'boxes-premier'];
    const { result, quotes } = compareScenario('boxes', draft);
    expect(quotes.map((quote) => quote.supplierId)).toEqual(draft.supplierIds);
    expect(result.recommendedSupplierIds).toEqual(['boxes-quick']);
    draft.supplierIds = sampleDraft('chairs').supplierIds;
    expect(mockQuotes(requestFromDraft(draft))).toEqual([]);
  });

  it('keeps sample drafts independent and identifies the unit being purchased', () => {
    const draft = sampleDraft('paper');
    draft.supplierIds.pop();
    draft.quantity = '1';
    expect(sampleDraft('paper').supplierIds).toHaveLength(4);
    expect(sampleDraft('paper').quantity).toBe('100');
    expect(requestFromDraft(sampleDraft('paper')).items[0].unitLabel).toBe('reams');
    expect(new Set(scenarios.flatMap((scenario) => scenario.suppliers.map((supplier) => supplier.id))).size).toBe(14);
  });

  it('normalizes item names without changing the quote facts', () => {
    const { result } = compareScenario('paper', { item: '  PRINTER PAPER  ' });
    expect(result.recommendedSupplierIds).toEqual(['paper-everyday']);
    expect(result.feasible[0].totalCents).toBe(48000);
  });
});
