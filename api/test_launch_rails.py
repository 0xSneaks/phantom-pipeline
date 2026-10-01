import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from launch_rails import (
    MUSEBOOK_ROBINHOOD_ADDRESS,
    LaunchValidationError,
    build_bankr_payload,
    build_musepad_command,
    prepare_launch_plan,
)


VALID = {
    "name": "Phantom Test",
    "symbol": "PHT",
    "description": "A deterministic launch fixture.",
    "evm_wallet": "0x1111111111111111111111111111111111111111",
    "solana_wallet": "11111111111111111111111111111111",
    "image_url": "https://example.com/token.png",
    "website_url": "https://example.com",
}


class LaunchRailsTests(unittest.TestCase):
    def test_musepad_uses_bankr_platform(self):
        cmd = build_musepad_command(VALID)
        self.assertTrue(cmd.startswith("!musepad "))
        self.assertIn("platform: bankr", cmd)
        self.assertIn("wallet: 0x1111111111111111111111111111111111111111", cmd)

    def test_bankr_is_robinhood_musebook_and_simulated(self):
        payload = build_bankr_payload(VALID)
        self.assertEqual(payload["chain"], "robinhood")
        self.assertEqual(payload["pairedTokenAddress"], MUSEBOOK_ROBINHOOD_ADDRESS)
        self.assertTrue(payload["simulateOnly"])
        self.assertEqual(payload["feeRecipient"]["value"], VALID["evm_wallet"])

    def test_orcapod_fails_closed(self):
        plan = prepare_launch_plan(VALID)
        self.assertEqual(plan["orcapod"]["status"], "blocked_unverified_api_contract")
        self.assertNotIn("url", plan["orcapod"])

    def test_invalid_evm_wallet_rejected(self):
        bad = dict(VALID)
        bad["evm_wallet"] = "not-a-wallet"
        with self.assertRaises(LaunchValidationError):
            build_bankr_payload(bad)


if __name__ == "__main__":
    unittest.main()
