"""Multi-rail token launch helpers for Phantom Pipeline.

Verified live rail:
- Bankr: POST https://api.bankr.bot/token-launches/deploy
- Robinhood Chain musebook quote token:
  0x91A2DAe9699f0B82540B5886b0d8759C22820bA3

Observed Musepad rail:
- Musebook posts use !musepad ... platform: bankr
- Musepad replies show deployment via Bankr on Robinhood Chain, paired against musebook.

OrcaPod:
- The public /api-docs page exists, but its client-rendered endpoint schema was
  not machine-verifiable when this adapter was written. Execution therefore
  fails closed instead of inventing an endpoint or payload.
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict, Optional

import httpx


BANKR_API_BASE = "https://api.bankr.bot"
BANKR_DEPLOY_PATH = "/token-launches/deploy"
MUSEBOOK_ROBINHOOD_ADDRESS = "0x91A2DAe9699f0B82540B5886b0d8759C22820bA3"
ORCAPOD_DOCS_URL = "https://orcapod.fun/api-docs"

_EVM_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9._-]{1,20}$")


class LaunchValidationError(ValueError):
    pass


def _clean_text(value: str, field: str, max_len: int) -> str:
    value = " ".join((value or "").split())
    if not value:
        raise LaunchValidationError(f"{field} is required")
    if len(value) > max_len:
        raise LaunchValidationError(f"{field} exceeds {max_len} characters")
    return value


def validate_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    name = _clean_text(str(manifest.get("name", "")), "name", 80)
    symbol = _clean_text(str(manifest.get("symbol", "")), "symbol", 20)
    if not _SYMBOL_RE.fullmatch(symbol):
        raise LaunchValidationError(
            "symbol must be 1-20 characters using letters, numbers, dot, underscore, or hyphen"
        )

    description = _clean_text(
        str(manifest.get("description", "")), "description", 1000
    )
    evm_wallet = str(manifest.get("evm_wallet", "")).strip()
    if not _EVM_RE.fullmatch(evm_wallet):
        raise LaunchValidationError("evm_wallet must be a 0x-prefixed 20-byte EVM address")

    def optional_url(key: str) -> Optional[str]:
        value = manifest.get(key)
        if value is None:
            return None
        value = str(value).strip()
        if not value:
            return None
        if not (value.startswith("https://") or value.startswith("http://")):
            raise LaunchValidationError(f"{key} must be an http(s) URL")
        return value

    return {
        "name": name,
        "symbol": symbol,
        "description": description,
        "evm_wallet": evm_wallet,
        "solana_wallet": (str(manifest.get("solana_wallet", "")).strip() or None),
        "image_url": optional_url("image_url"),
        "website_url": optional_url("website_url"),
        "tweet_url": optional_url("tweet_url"),
    }


def build_musepad_command(manifest: Dict[str, Any]) -> str:
    """Build the deterministic Musebook command used by the Musepad Bankr rail."""
    m = validate_manifest(manifest)
    parts = [
        "!musepad",
        f"name: {m['name']}",
        f"symbol: {m['symbol']}",
        f"wallet: {m['evm_wallet']}",
        f"description: {m['description']}",
    ]
    if m["image_url"]:
        parts.append(f"image: {m['image_url']}")
    parts.append("platform: bankr")
    return " ".join(parts)


def build_bankr_payload(manifest: Dict[str, Any], *, simulate_only: bool = True) -> Dict[str, Any]:
    """Build a documented Bankr token-launch payload.

    Robinhood Chain + musebook pairing is explicit so the Bankr direct rail and
    the observed Musepad rail resolve to the same quote asset.
    """
    m = validate_manifest(manifest)
    payload: Dict[str, Any] = {
        "tokenName": m["name"],
        "tokenSymbol": m["symbol"],
        "description": m["description"],
        "chain": "robinhood",
        "pairedTokenAddress": MUSEBOOK_ROBINHOOD_ADDRESS,
        "feeRecipient": {"type": "wallet", "value": m["evm_wallet"]},
        "simulateOnly": bool(simulate_only),
    }
    if m["image_url"]:
        payload["image"] = m["image_url"]
    if m["website_url"]:
        payload["websiteUrl"] = m["website_url"]
    if m["tweet_url"]:
        payload["tweetUrl"] = m["tweet_url"]
    return payload


def prepare_orcapod(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize the Solana-side intent but do not fabricate OrcaPod API calls."""
    m = validate_manifest(manifest)
    return {
        "status": "blocked_unverified_api_contract",
        "docs_url": ORCAPOD_DOCS_URL,
        "reason": (
            "OrcaPod API endpoint and request schema have not been independently "
            "verified from the client-rendered docs. No HTTP request will be sent."
        ),
        "intent": {
            "name": m["name"],
            "symbol": m["symbol"],
            "description": m["description"],
            "solana_wallet": m["solana_wallet"],
            "image_url": m["image_url"],
            "website_url": m["website_url"],
        },
    }


def prepare_launch_plan(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Return the shared manifest translated into every currently known rail."""
    m = validate_manifest(manifest)
    return {
        "manifest": m,
        "musepad": {
            "status": "prepared",
            "transport": "signed Musebook post",
            "command": build_musepad_command(m),
            "platform": "bankr",
        },
        "bankr": {
            "status": "prepared",
            "method": "POST",
            "url": f"{BANKR_API_BASE}{BANKR_DEPLOY_PATH}",
            "payload": build_bankr_payload(m, simulate_only=True),
        },
        "orcapod": prepare_orcapod(m),
    }


async def execute_bankr(manifest: Dict[str, Any], *, live: bool = False) -> Dict[str, Any]:
    """Execute Bankr only when both request and environment explicitly allow it.

    Dry-run requests never hit Bankr; they return the exact simulated payload.
    Live requests require:
      - live=True
      - BANKR_ALLOW_LIVE=1
      - BANKR_API_KEY
    """
    if not live:
        return {
            "status": "dry_run",
            "sent": False,
            "payload": build_bankr_payload(manifest, simulate_only=True),
        }

    if os.getenv("BANKR_ALLOW_LIVE") != "1":
        raise PermissionError("live Bankr launch blocked: set BANKR_ALLOW_LIVE=1")

    api_key = os.getenv("BANKR_API_KEY", "").strip()
    if not api_key:
        raise PermissionError("live Bankr launch blocked: BANKR_API_KEY is missing")

    payload = build_bankr_payload(manifest, simulate_only=False)
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(
            f"{BANKR_API_BASE}{BANKR_DEPLOY_PATH}",
            headers=headers,
            json=payload,
        )

    try:
        data: Any = response.json()
    except Exception:
        data = {"raw": response.text[:2000]}

    if response.status_code >= 400:
        return {
            "status": "error",
            "sent": True,
            "http_status": response.status_code,
            "response": data,
        }

    return {
        "status": "submitted",
        "sent": True,
        "http_status": response.status_code,
        "response": data,
    }
