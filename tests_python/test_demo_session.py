"""The browser fixture executes actual domain rules, without a database or network."""

import json
import subprocess
import sys
import unittest

from logistics_rules.demo_session import DemoSession


class DemoSessionTests(unittest.TestCase):
    def setUp(self):
        self.session = DemoSession()

    def action(self, action, **request):
        result = self.session.run({"action": action, **request})
        self.assertTrue(result["ok"], result.get("error"))
        return result["snapshot"]

    def ready_to_receive(self):
        for action in ("create_order", "reserve", "compare", "approve"):
            snapshot = self.action(action)
        return snapshot

    def test_full_demo_uses_split_purchases_and_preserves_other_reservation(self):
        initial = self.session.snapshot()
        self.assertIsNone(initial["order"])
        self.assertEqual(initial["stock"], {"on_hand": 6, "reserved": 2, "available": 4})
        self.action("create_order")
        reserved = self.action("reserve")
        self.assertEqual(reserved["lines"][0]["shortage"]["quantity_to_purchase"], 11)
        compared = self.action("compare")
        self.assertEqual(compared["purchases"], [])
        self.assertEqual(compared["recommendation"]["total_cents"], 1180)
        self.assertEqual([value["quantity"] for value in compared["recommendation"]["allocations"]], [7, 4])
        self.assertTrue(all(quote["estimated"] for quote in compared["quotes"]))
        approved = self.action("approve")
        self.assertEqual(approved["stock"]["on_hand"], 6)
        self.assertEqual(approved["lines"][0]["shortage"]["quantity_to_purchase"], 0)
        self.assertEqual(approved["lines"][0]["shortage"]["approved_inbound"], 11)
        self.assertTrue(all(po["received_at"] is None for po in approved["purchases"]))
        first = self.action("receive_x")
        self.assertEqual(first["stock"]["on_hand"], 13)
        self.assertEqual(first["order"]["status"], "open")
        self.assertIsNone(first["purchases"][1]["received_at"])
        rejected = self.session.run({"action": "fulfill"})
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["snapshot"]["stock"], first["stock"])
        self.assertIsNone(rejected["snapshot"]["order"]["fulfilled_at"])
        received = self.action("receive_y")
        self.assertEqual(received["order"]["status"], "ready")
        fulfilled = self.action("fulfill")
        self.assertEqual(fulfilled["stock"], {"on_hand": 2, "reserved": 2, "available": 0})
        self.assertIsNotNone(fulfilled["order"]["fulfilled_at"])
        replayed = self.action("replay")
        self.assertEqual(replayed["stock"], fulfilled["stock"])
        isolated = self.action("check_isolation")
        self.assertEqual(isolated["stock"], fulfilled["stock"])
        self.assertIn("4 Company B", isolated["events"][-1]["detail"])

    def test_explicit_approval_cannot_be_skipped(self):
        self.action("create_order")
        self.action("reserve")
        result = self.session.run({"action": "approve"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["snapshot"]["purchases"], [])
        self.assertFalse(self.session.run({"action": "receive_x"})["ok"])

    def test_preview_fixtures_match_the_created_order_and_synthetic_quotes(self):
        preview = self.session.snapshot()
        created = self.action("create_order")
        line = created["lines"][0]
        self.assertEqual(preview["scenario"]["quantity"], line["quantity"])
        self.assertEqual(preview["budget_cents"], line["maximum_budget_cents"])
        self.assertEqual(preview["item"]["id"], line["item_id"])
        self.action("reserve")
        compared = self.action("compare")
        quotes = {quote["supplier_id"]: quote for quote in compared["quotes"]}
        self.assertEqual(len(preview["suppliers"]), len(quotes))
        for supplier in preview["suppliers"]:
            quote = quotes[supplier["id"]]
            self.assertEqual(supplier["capacity_quantity"], quote["capacity_quantity"])
            self.assertEqual(supplier["quantity_priced"], quote["quantity_priced"])
            self.assertEqual(supplier["unit_price_cents"], quote["price_cents"])
            self.assertEqual(supplier["expected_date"], quote["expected_date"])

    def test_receiving_y_first_does_not_ready_the_order(self):
        self.ready_to_receive()
        self.assertEqual(self.action("receive_y")["stock"]["on_hand"], 10)
        self.assertFalse(self.session.run({"action": "fulfill"})["ok"])
        self.assertEqual(self.action("receive_x")["order"]["status"], "ready")

    def test_stale_compare_cannot_replace_the_approved_plan(self):
        approved = self.ready_to_receive()
        for completed in (False, True):
            if completed:
                self.action("receive_x")
                self.action("receive_y")
                before = self.action("fulfill")
            else:
                before = approved
            rejected = self.session.run({"action": "compare"})
            self.assertFalse(rejected["ok"])
            self.assertIn("approved supplier plan is fixed", rejected["error"])
            after = rejected["snapshot"]
            self.assertEqual(after["recommendation"], approved["recommendation"])
            self.assertEqual(after["recommendation"]["total_cents"], 1180)
            for field in ("stock", "order", "lines", "purchases", "quotes"):
                self.assertEqual(after[field], before[field])

    def test_same_keys_replay_but_new_keys_reject_completed_business_events(self):
        self.ready_to_receive()
        first = self.action("receive_x", key="custom-receipt-key")
        repeated = self.action("receive_x", key="custom-receipt-key")
        self.assertEqual(first["stock"], repeated["stock"])
        rejected = self.session.run({"action": "receive_x", "key": "another-key"})
        self.assertFalse(rejected["ok"])
        self.assertEqual(first["stock"], rejected["snapshot"]["stock"])
        self.action("receive_y")
        self.action("fulfill", key="custom-fulfillment")
        self.action("replay")

    def test_key_payload_conflict_is_rejected(self):
        self.action("create_order", key="same-key")
        rejected = self.session.run({"action": "reserve", "key": "same-key"})
        self.assertFalse(rejected["ok"])
        self.assertIn("different payload", rejected["error"])
        self.assertEqual(rejected["snapshot"]["stock"]["reserved"], 2)

    def test_reset_restores_fixtures_and_malformed_requests_do_not_mutate_stock(self):
        self.ready_to_receive()
        self.action("receive_x")
        reset = self.action("reset")
        self.assertIsNone(reset["order"])
        self.assertEqual(reset["purchases"], [])
        for request in (None, [], {"action": "unknown"}, {"action": "reserve", "business_id": "B"}, {"action": "reserve", "key": ""}):
            result = self.session.run(request)
            self.assertFalse(result["ok"])
            self.assertEqual(result["snapshot"]["stock"], reset["stock"])

    def test_worker_protocol_has_one_json_response_per_input_and_keeps_session(self):
        commands = ["{broken", json.dumps({"action": "create_order"}), json.dumps({"action": "reserve"})]
        result = subprocess.run(
            [sys.executable, "-m", "logistics_rules.demo_session"],
            input="\n".join(commands) + "\n", capture_output=True, text=True, check=True,
        )
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(responses), 3)
        self.assertFalse(responses[0]["ok"])
        self.assertTrue(responses[1]["ok"])
        self.assertEqual(responses[2]["snapshot"]["lines"][0]["shortage"]["quantity_to_purchase"], 11)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
