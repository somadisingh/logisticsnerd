import { describe, expect, it } from 'vitest';
import { normalizeAfterShip } from '../server/shipping.mjs';
const parcel = { deadline: '2026-10-08', carrier: 'ups', service: '' };
// A point prediction cannot overrule a returned lower bound, and without an
// upper bound a point prediction does not prove that the full window is on time.
describe('partial shipping-window bounds (offline provider fixtures)', () => {
  it.each([
    ['2026-10-09', null, '2026-10-04', 'estimated_late'],
    ['2026-10-09', null, '2026-10-09', 'estimated_late'],
    ['2026-10-09', null, null, 'estimated_late'],
    ['2026-10-08', null, '2026-10-04', 'uncertain'],
    ['2026-10-08', null, null, 'uncertain'],
    ['2026-10-07', null, '2026-10-04', 'uncertain'],
    ['2026-10-07', null, '2026-10-11', 'uncertain'],
    [null, '2026-10-08', '2026-10-04', 'estimated_on_time'],
    [null, '2026-10-09', '2026-10-04', 'uncertain'],
    [null, '2026-10-09', null, 'uncertain'],
    [null, null, '2026-10-08', 'estimated_on_time'],
    [null, null, '2026-10-09', 'estimated_late'],
    [null, null, null, 'unknown'],
    ['2026-10-09', '2026-10-08', '2026-10-04', 'unknown'],
    ['2026-10-07', '2026-10-08', '2026-10-09', 'estimated_on_time'],
    ['2026-10-09', '2026-10-10', '2026-10-04', 'estimated_late'],
  ])('lower=%s upper=%s point=%s -> %s', (min,max,point,expected) => {
    const [rate] = normalizeAfterShip({data:{estimated_delivery_date_min:min, estimated_delivery_date_max:max, estimated_delivery_date:point}},parcel);
    expect(rate.deadlineAssessment).toBe(expected);
    expect(rate.guaranteed).toBe(false);
    expect(rate.costCents).toBeNull();
  });
});
