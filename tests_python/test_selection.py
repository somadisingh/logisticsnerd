"""Deterministic synthetic fixtures; no credentials, HTTP, or live models."""

from dataclasses import FrozenInstanceError, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from itertools import product
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from logistics_rules.selection import MAX_NEEDED, Quote, select_quotes


NOW = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
DEADLINE = date(2026, 10, 15)


def quote(supplier="supplier-a", **changes):
    values = dict(
        id=f"quote-{supplier}", business_id="company-a", line_id="line-a", supplier_id=supplier,
        capacity_quantity=50, quantity_priced=50, price_cents=9_000, pricing_kind="unit",
        currency="USD", source="synthetic", generated_at=NOW - timedelta(hours=1),
        expires_at=NOW + timedelta(days=1), expected_date=date(2026, 10, 12),
    )
    values.update(changes)
    return Quote(**values)


def select(needed, quotes, **changes):
    values = dict(now=NOW, deadline=DEADLINE, currency="USD", budget_cents=600_000)
    values.update(changes)
    return select_quotes(needed, tuple(quotes), **values)


class QuoteTests(unittest.TestCase):
    def test_strict_quantity_money_currency_source_and_time_validation(self):
        for changes in (
            {"capacity_quantity": True}, {"capacity_quantity": -1}, {"quantity_priced": -1},
            {"quantity_priced": 1.0}, {"price_cents": False}, {"price_cents": -1},
            {"price_cents": 10.0}, {"currency": "usd"}, {"source": "live_ai"},
            {"pricing_kind": "maybe"}, {"generated_at": NOW.replace(tzinfo=None)},
            {"expires_at": NOW - timedelta(hours=1)}, {"expected_date": NOW}, {"id": " "},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                quote(**changes)

    def test_quotes_are_immutable_and_estimates_are_explicit(self):
        value = quote()
        with self.assertRaises(FrozenInstanceError):
            value.price_cents = 1
        self.assertTrue(value.estimated)
        self.assertTrue(quote(source="ai_estimate").estimated)
        self.assertFalse(quote(source="supplier").estimated)

    def test_capacity_priced_quantity_and_purchased_quantity_are_separate(self):
        value = quote(capacity_quantity=100, quantity_priced=10, price_cents=25)
        self.assertEqual(value.cost(4), 100)
        for quantity in (0, True, 11, 101):
            with self.subTest(quantity=quantity), self.assertRaises(ValueError):
                value.cost(quantity)
        self.assertEqual(quote(capacity_quantity=7, quantity_priced=50).cost(7), 63_000)

    def test_total_quote_applies_only_to_exact_priced_quantity(self):
        value = quote(pricing_kind="total", quantity_priced=10, price_cents=500)
        self.assertEqual(value.cost(10), 500)
        with self.assertRaisesRegex(ValueError, "exactly 10"):
            value.cost(9)

    def test_expiry_is_exclusive_and_invalidity_has_factual_dates(self):
        value = quote(expires_at=NOW, expected_date=date(2026, 10, 16))
        with self.assertRaises(ValueError) as result:
            value.validate_at(NOW, DEADLINE, "USD")
        self.assertIn("expired at 2026-10-01T12:00:00+00:00", str(result.exception))
        self.assertIn("delivery 2026-10-16 is after deadline 2026-10-15", str(result.exception))
        with self.assertRaisesRegex(ValueError, "after approval/comparison time"):
            quote(generated_at=NOW + timedelta(hours=1)).validate_at(NOW, DEADLINE, "USD")

    def test_delivery_freshness_uses_utc_date_across_timezone_boundaries(self):
        value = quote(
            generated_at=NOW - timedelta(days=2), expires_at=NOW + timedelta(days=10),
            expected_date=date(2026, 10, 1),
        )
        # The local date is October 2; UTC is still October 1, so same-day
        # delivery remains valid. The caller's timezone cannot change the rule.
        before_boundary = datetime(2026, 10, 2, 0, 30, tzinfo=timezone(timedelta(hours=2)))
        value.validate_at(before_boundary, DEADLINE, "USD")
        # The local date is October 1; UTC has reached October 2, so yesterday's
        # delivery is stale even though the quote's expiry is still in future.
        after_boundary = datetime(2026, 10, 1, 20, 30, tzinfo=timezone(timedelta(hours=-4)))
        with self.assertRaisesRegex(ValueError, "delivery 2026-10-01 is before current UTC date 2026-10-02"):
            value.validate_at(after_boundary, DEADLINE, "USD")


class SelectionTests(unittest.TestCase):
    def test_existing_chair_brief_is_compatible_with_demo_selection(self):
        # Read the actual browser fixture rather than duplicate its quote facts.
        # Explicit currency/company/expiry are test metadata absent from the
        # demo, not an integration mapping. Its fixed total implicitly prices
        # the full requested quantity; the domain makes that quantity explicit.
        fixture_path = Path(__file__).resolve().parents[1] / "src" / "data" / "demo.json"
        fixture = json.loads(fixture_path.read_text(), parse_float=Decimal)
        item = fixture["requested_items"][0]
        quote_lines = {line["quote_id"]: line for line in fixture["quote_items"]}
        quotes = []
        for header in fixture["supplier_quotes"]:
            line = quote_lines[header["id"]]
            quotes.append(quote(
                header["supplier_id"], id=header["id"], line_id=line["requested_item_id"],
                capacity_quantity=line["available_quantity"], quantity_priced=item["quantity"],
                pricing_kind="total", price_cents=int(Decimal(str(line["total_price"])) * 100),
                generated_at=datetime.fromisoformat(header["submitted_at"].replace("Z", "+00:00")),
                expected_date=date.fromisoformat(line["expected_delivery_date"]),
            ))
        options = dict(
            budget_cents=int(Decimal(str(fixture["request"]["max_budget"])) * 100),
            deadline=date.fromisoformat(item["required_delivery_date"]),
        )
        result = select(item["quantity"], quotes, **options)
        self.assertTrue(result.feasible)
        self.assertEqual([(a.quote_id, a.quantity, a.total_cents) for a in result.allocations], [("quote-metro", 50, 450_000)])
        self.assertEqual(result.total_cents, 450_000)
        self.assertIn("capacity 35", " ".join(result.explanations))
        self.assertEqual(select(item["quantity"], list(reversed(quotes)), **options), result)
        options["deadline"] = date(2026, 10, 10)
        self.assertEqual(select(item["quantity"], quotes, **options).allocations[0].quote_id, "quote-comfort")

    def test_zero_capacity_is_valid_quote_fact_but_cannot_be_purchased(self):
        for pricing_kind in ("unit", "total"):
            with self.subTest(pricing_kind=pricing_kind):
                unavailable = quote(capacity_quantity=0, pricing_kind=pricing_kind)
                result = select(1, [unavailable])
                self.assertFalse(result.feasible)
                self.assertEqual(result.allocations, ())
                self.assertIn("capacity 0 cannot cover any of remaining shortage 1", " ".join(result.explanations))
                with self.assertRaisesRegex(ValueError, "capacity 0 is below purchased quantity 1"):
                    unavailable.cost(1)

    def test_equal_cost_prefers_earlier_delivery_then_supplier_id(self):
        first = quote("z", pricing_kind="total", price_cents=100)
        earlier = quote("y", pricing_kind="total", price_cents=100, expected_date=date(2026, 10, 10))
        self.assertEqual(select(50, [first, earlier]).allocations[0].quote_id, "quote-y")
        same_day = replace(earlier, id="quote-a", supplier_id="a")
        self.assertEqual(select(50, [earlier, same_day]).allocations[0].quote_id, "quote-a")

    def test_split_sourcing_covers_shortage_no_single_supplier_can_cover(self):
        quotes = [quote("X", capacity_quantity=7, quantity_priced=7, price_cents=100),
                  quote("Y", capacity_quantity=4, quantity_priced=4, price_cents=120)]
        result = select(11, quotes, budget_cents=1_180)
        self.assertTrue(result.feasible)
        self.assertEqual([(a.quote_id, a.quantity) for a in result.allocations], [("quote-X", 7), ("quote-Y", 4)])
        self.assertEqual(result.total_cents, 1_180)
        self.assertIn("synthetic estimate, not a supplier commitment", " ".join(result.explanations))
        self.assertIn("Explicit owner approval is required", " ".join(result.explanations))

    def test_split_search_finds_cheapest_combination_instead_of_greedy_total(self):
        quotes = [quote("bundle", pricing_kind="total", quantity_priced=3, capacity_quantity=3, price_cents=200),
                  quote("unit", quantity_priced=4, capacity_quantity=4, price_cents=100)]
        result = select(4, quotes)
        self.assertEqual(result.total_cents, 300)
        self.assertEqual(sum(a.quantity for a in result.allocations), 4)
        self.assertEqual(result.allocations[0].quantity, 3)

    def test_exact_solver_matches_independent_exhaustive_small_fixture(self):
        quotes = [
            quote("unit-a", capacity_quantity=3, quantity_priced=2, price_cents=80),
            quote("bundle-a", capacity_quantity=4, quantity_priced=3, price_cents=180, pricing_kind="total"),
            quote("unit-b", capacity_quantity=4, quantity_priced=4, price_cents=90),
            quote("bundle-b", capacity_quantity=2, quantity_priced=2, price_cents=200, pricing_kind="total"),
        ]
        # Enumerate every legal basket directly, separately from the DP and
        # Quote.cost. This catches invalid pruning or greedy split decisions.
        baskets = []
        for quantities in product(range(3), (0, 3), range(5), (0, 2)):
            a, b, c, d = quantities
            cost = a * 80 + (180 if b else 0) + c * 90 + (200 if d else 0)
            baskets.append((sum(quantities), cost))
        for needed in range(13):
            with self.subTest(needed=needed):
                costs = [cost for quantity, cost in baskets if quantity == needed]
                result = select(needed, quotes, budget_cents=None)
                self.assertEqual(result.feasible, bool(costs))
                if costs:
                    self.assertEqual(result.total_cents, min(costs))
                    self.assertEqual(sum(a.quantity for a in result.allocations), needed)

    def test_equal_cost_split_prefers_earliest_complete_delivery(self):
        quotes = [quote("early", capacity_quantity=1, quantity_priced=1, price_cents=100, expected_date=date(2026, 10, 8)),
                  quote("middle", capacity_quantity=2, quantity_priced=2, price_cents=100, expected_date=date(2026, 10, 9)),
                  quote("late", capacity_quantity=1, quantity_priced=1, price_cents=100, expected_date=date(2026, 10, 10))]
        result = select(2, quotes)
        self.assertNotIn("quote-late", [a.quote_id for a in result.allocations])
        self.assertEqual(result, select(2, quotes[::-1]))

    def test_budget_covers_combined_purchases_and_equality_is_allowed(self):
        quotes = [quote("x", capacity_quantity=7, quantity_priced=7, price_cents=100),
                  quote("y", capacity_quantity=4, quantity_priced=4, price_cents=100)]
        self.assertTrue(select(11, quotes, budget_cents=1_100).feasible)
        result = select(11, quotes, budget_cents=1_099)
        self.assertFalse(result.feasible)
        self.assertEqual(result.allocations, ())
        self.assertIn("1100", " ".join(result.explanations))
        self.assertIn("exceeds purchased-shortage budget 1099 cents by 1 cents", " ".join(result.explanations))
        self.assertTrue(select(11, quotes, budget_cents=None).feasible)

    def test_zero_budget_accepts_only_zero_price_and_exact_currency_is_required(self):
        self.assertFalse(select(1, [quote()], budget_cents=0).feasible)
        self.assertTrue(select(1, [quote(price_cents=0)], budget_cents=0).feasible)
        for needed in (0, 1):
            with self.subTest(needed=needed), self.assertRaisesRegex(ValueError, "Mixed currencies"):
                select(needed, [quote(currency="EUR")], budget_cents=0)

    def test_expired_late_quotes_are_explained_and_not_selected(self):
        result = select(1, [quote("expired", expires_at=NOW), quote("late", expected_date=date(2026, 10, 16))])
        self.assertFalse(result.feasible)
        self.assertEqual(result.total_cents, 0)
        self.assertIn("expired", " ".join(result.explanations))
        self.assertIn("after deadline 2026-10-15", " ".join(result.explanations))
        self.assertIn("at most 0 units", " ".join(result.explanations))

    def test_revalidation_rejects_past_delivery_even_with_unexpired_quote(self):
        value = quote(expected_date=date(2026, 10, 2), expires_at=NOW + timedelta(days=10))
        same_day = datetime(2026, 10, 2, 23, 59, tzinfo=timezone.utc)
        self.assertTrue(select(1, [value], now=same_day).feasible)
        later = same_day + timedelta(minutes=1)
        result = select(1, [value], now=later)
        self.assertFalse(result.feasible)
        self.assertEqual(result.allocations, ())
        self.assertIn("delivery 2026-10-02 is before current UTC date 2026-10-03", " ".join(result.explanations))
        with self.assertRaisesRegex(ValueError, "before current UTC date"):
            value.validate_at(later, DEADLINE, "USD")

    def test_fixed_total_cannot_be_rescaled_or_oversupplied(self):
        self.assertFalse(select(4, [quote(pricing_kind="total", quantity_priced=5)]).feasible)
        result = select(5, [quote(pricing_kind="total", capacity_quantity=3, quantity_priced=3)])
        self.assertFalse(result.feasible)
        self.assertIn("at most 3 units", " ".join(result.explanations))

    def test_no_quotes_or_zero_shortage_have_distinct_results(self):
        self.assertFalse(select(1, []).feasible)
        result = select(0, [])
        self.assertTrue(result.feasible)
        self.assertEqual(result.allocations, ())
        self.assertIn("No unallocated shortage remains", result.explanations[0])

    def test_duplicate_and_cross_company_or_line_quotes_are_rejected(self):
        first = quote()
        cases = [
            ([first, first], "Duplicate quote"),
            ([first, replace(first, id="other")], "Duplicate supplier"),
            ([first, quote("other", business_id="company-b")], "different companies"),
            ([first, quote("other", line_id="line-b")], "different order lines"),
        ]
        for quotes, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                select(1, quotes)

    def test_invalid_comparison_arguments_and_bounded_search_fail_explicitly(self):
        for needed in (True, -1, 1.1, MAX_NEEDED + 1):
            with self.subTest(needed=needed), self.assertRaises(ValueError):
                select(needed, [quote()])
        with self.assertRaisesRegex(ValueError, "budget_cents"):
            select(1, [quote()], budget_cents=True)
        with patch("logistics_rules.selection.MAX_TRANSITIONS", 1):
            with self.assertRaisesRegex(ValueError, "exceeded 1 transitions"):
                select(2, [quote()])


if __name__ == "__main__":
    unittest.main()
