"""Deterministic AI-shaped estimates; no network or provider credentials."""
from dataclasses import replace
from datetime import timedelta
import unittest

from logistics_rules.demo_session import DemoSession, NOW
from logistics_rules.selection import Quote
from logistics_rules.repository import RuleViolation


class AIDemoTests(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.session = DemoSession(clock=lambda: self.now)
        self.run_action('use_ai')
        self.run_action('create_order')
        self.run_action('reserve')

    def run_action(self, action, **values):
        result = self.session.run({'action': action, **values})
        self.assertTrue(result['ok'], result.get('error'))
        return result['snapshot']

    def estimates(self):
        return {
            'provenance': {'kind': 'ai_estimate', 'model': 'fixture-model', 'generatedAt': NOW.isoformat(),
                           'expiresAt': (NOW + timedelta(days=7)).isoformat(), 'cached': False},
            'assumptions': ['Fictional supplier offers; explicit all-in linear unit prices.'],
            'quotes': [dict(supplier_id=supplier, capacity_quantity=capacity, quantity_priced=11,
                            price_cents=price, currency='USD', expected_date='2026-10-25')
                       for supplier, capacity, price in [('X', 7, 100), ('Y', 4, 120), ('Z', 0, 90)]],
        }

    def test_ai_split_is_checked_approved_and_received_without_double_counting(self):
        compared = self.run_action('apply_ai', estimates=self.estimates())
        self.assertEqual(compared['recommendation']['total_cents'], 1180)
        self.assertEqual(compared['purchases'], [])
        self.assertEqual(compared['supplier_data'], 'ai_estimate')
        self.assertEqual(compared['estimate_provenance']['model'], 'fixture-model')
        self.assertEqual(compared['suppliers'][0]['quantity_priced'], 11)
        approved = self.run_action('approve')
        self.assertEqual(approved['stock']['on_hand'], 6)
        self.assertEqual([p['quantity'] for p in approved['purchases']], [7, 4])
        self.assertTrue(all(p['quote_snapshot']['source'] == 'ai_estimate' for p in approved['purchases']))
        self.run_action('receive', supplier_id='X')
        self.assertFalse(self.session.run({'action': 'fulfill'})['ok'])
        self.run_action('receive', supplier_id='Y')
        final = self.run_action('fulfill')
        self.assertEqual(final['stock'], dict(on_hand=2, reserved=2, available=0))
        self.assertEqual(self.run_action('replay')['stock'], final['stock'])
        self.assertEqual(self.run_action('check_isolation')['stock'], final['stock'])
        self.assertFalse(self.session.run({'action': 'apply_ai', 'estimates': self.estimates()})['ok'])

    def test_single_supplier_z_purchase_does_not_depend_on_po_position(self):
        estimates = self.estimates()
        for offer in estimates['quotes']:
            offer['capacity_quantity'] = 11 if offer['supplier_id'] == 'Z' else 0
        self.run_action('apply_ai', estimates=estimates)
        approved = self.run_action('approve')
        self.assertEqual([p['supplier_id'] for p in approved['purchases']], ['Z'])
        self.assertFalse(self.session.run({'action': 'receive', 'supplier_id': 'X'})['ok'])
        self.run_action('receive', supplier_id='Z')
        self.run_action('fulfill')
        self.assertEqual(self.run_action('replay')['stock']['on_hand'], 2)

    def test_three_supplier_receipts_require_every_purchase(self):
        estimates = self.estimates()
        for offer, capacity in zip(estimates['quotes'], (4, 4, 3)):
            offer['capacity_quantity'] = capacity
            offer['price_cents'] = 100
        self.run_action('apply_ai', estimates=estimates)
        self.assertEqual(len(self.run_action('approve')['purchases']), 3)
        for supplier in ('X', 'Y'):
            self.run_action('receive', supplier_id=supplier)
            self.assertFalse(self.session.run({'action': 'fulfill'})['ok'])
        self.run_action('receive', supplier_id='Z')
        self.assertEqual(self.run_action('fulfill')['stock']['on_hand'], 2)

    def test_over_budget_estimates_are_explained_and_cannot_be_approved(self):
        estimates = self.estimates()
        for offer in estimates['quotes']:
            offer['price_cents'] = 10000
        compared = self.run_action('apply_ai', estimates=estimates)
        self.assertFalse(compared['recommendation']['feasible'])
        self.assertIn('exceeds', ' '.join(compared['recommendation']['explanations']))
        self.assertFalse(self.session.run({'action': 'approve'})['ok'])
        self.assertEqual(self.session.snapshot()['purchases'], [])
        self.assertEqual(self.session.snapshot()['stock']['on_hand'], 6)

    def test_malformed_estimate_batches_leave_no_partial_quotes(self):
        cases = []
        for field, value in [('currency', 'EUR'), ('quantity_priced', 15), ('price_cents', True), ('supplier_id', 'X')]:
            body = self.estimates()
            body['quotes'][1][field] = value
            cases.append(body)
        expired = self.estimates()
        expired['provenance']['expiresAt'] = (NOW - timedelta(seconds=1)).isoformat()
        cases.append(expired)
        cases.append({'provenance': {}})
        for body in cases:
            with self.subTest(body=body):
                result = self.session.run({'action': 'apply_ai', 'estimates': body})
                self.assertFalse(result['ok'])
                self.assertEqual(result['snapshot']['quotes'], [])
                self.assertEqual(result['snapshot']['purchases'], [])

    def test_approval_rechecks_expiry_on_the_live_ai_clock(self):
        self.run_action('apply_ai', estimates=self.estimates())
        self.now += timedelta(days=8)
        result = self.session.run({'action': 'approve'})
        self.assertFalse(result['ok'])
        self.assertIn('expired', result['error'])
        self.assertEqual(result['snapshot']['purchases'], [])

    def test_sources_reset_fixtures_and_never_fall_back_to_sample_on_ai_failure(self):
        self.assertFalse(self.session.run({'action': 'compare'})['ok'])
        self.assertEqual(self.session.snapshot()['quotes'], [])
        self.run_action('apply_ai', estimates=self.estimates())
        sample = self.run_action('use_sample')
        self.assertEqual(sample['source'], 'sample')
        self.assertIsNone(sample['order'])
        self.assertIsNone(sample['estimate_provenance'])
        self.assertEqual(sample['stock'], dict(on_hand=6, reserved=2, available=4))

    def test_budget_is_explicit_and_immutable_after_creation(self):
        self.run_action('reset')
        created = self.run_action('create_order', budget_cents=15000)
        self.assertEqual(created['lines'][0]['maximum_budget_cents'], 15000)
        changed = self.session.run({'action': 'create_order', 'budget_cents': 20000})
        self.assertFalse(changed['ok'])
        self.assertEqual(changed['snapshot']['budget_cents'], 15000)
        self.run_action('reset')
        for budget in (True, -1, 1.5, 100_000_001):
            self.assertFalse(self.session.run({'action': 'create_order', 'budget_cents': budget})['ok'])

    def test_quote_batch_rolls_back_and_same_key_replays_original_terms(self):
        first = Quote('one', 'A', 'customer-order:1', 'X', 7, 11, 100, 'unit', 'USD', 'ai_estimate', NOW, NOW + timedelta(days=1), NOW.date())
        invalid = replace(first, id='two', business_id='B', supplier_id='Y')
        with self.assertRaises(RuleViolation):
            self.session.rules.add_quotes('A', (first, invalid), key='batch')
        self.assertEqual(self.session.snapshot()['quotes'], [])
        result = self.session.rules.add_quotes('A', (first,), key='batch')
        self.assertEqual(self.session.rules.add_quotes('A', (first,), key='batch'), result)
        with self.assertRaises(RuleViolation):
            self.session.rules.add_quotes('A', (replace(first, price_cents=101),), key='batch')


if __name__ == '__main__':
    unittest.main()
