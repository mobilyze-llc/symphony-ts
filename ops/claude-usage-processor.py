#!/usr/bin/env python3
"""Process Claude usage API data — called by ops/claude-usage (SYMPH-236)"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone


def main():
    keychain_json = os.environ.get("KEYCHAIN_JSON", "")
    json_mode = os.environ.get("JSON_MODE", "false") == "true"
    home_dir = os.environ.get("HOME", "")

    # --- Extract access token ---
    try:
        keychain = json.loads(keychain_json)
        access_token = keychain["claudeAiOauth"]["accessToken"]
    except (json.JSONDecodeError, KeyError):
        print(
            "Error: Unable to extract access token from Keychain credentials",
            file=sys.stderr,
        )
        sys.exit(1)

    if not access_token:
        print(
            "Error: Unable to extract access token from Keychain credentials",
            file=sys.stderr,
        )
        sys.exit(1)

    # --- Call usage API via curl ---
    try:
        result = subprocess.run(
            [
                "curl",
                "-s",
                "-f",
                "-H",
                f"Authorization: Bearer {access_token}",
                "-H",
                "anthropic-beta: oauth-2025-04-20",
                "https://api.anthropic.com/api/oauth/usage",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            print(
                "Error: Failed to fetch usage data from Anthropic API",
                file=sys.stderr,
            )
            sys.exit(1)
        api = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        print(
            "Error: Failed to fetch usage data from Anthropic API",
            file=sys.stderr,
        )
        sys.exit(1)

    # --- Validate response shape ---
    if "five_hour" not in api or api["five_hour"] is None:
        print(
            "Error: Unexpected API response format: missing five_hour",
            file=sys.stderr,
        )
        sys.exit(1)
    if "utilization" not in api["five_hour"]:
        print(
            "Error: Unexpected API response format: missing five_hour.utilization",
            file=sys.stderr,
        )
        sys.exit(1)
    if "seven_day" not in api or api["seven_day"] is None:
        print(
            "Error: Unexpected API response format: missing seven_day",
            file=sys.stderr,
        )
        sys.exit(1)
    if "utilization" not in api["seven_day"]:
        print(
            "Error: Unexpected API response format: missing seven_day.utilization",
            file=sys.stderr,
        )
        sys.exit(1)

    # --- Read sequence.json ---
    sequence_file = os.path.join(home_dir, ".claude-swap-backup", "sequence.json")
    seq = {}
    if os.path.isfile(sequence_file):
        try:
            with open(sequence_file) as f:
                seq = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass

    accounts_raw = seq.get("accounts", {})
    active_num = str(seq.get("activeAccountNumber", ""))

    accounts = []
    for num in sorted(accounts_raw.keys(), key=lambda x: int(x)):
        info = accounts_raw[num]
        accounts.append(
            {
                "account_number": int(num),
                "email": info.get("email", ""),
                "org": info.get("organizationName", ""),
            }
        )

    active_account = None
    if active_num and active_num in accounts_raw:
        info = accounts_raw[active_num]
        active_account = {
            "account_number": int(active_num),
            "email": info.get("email", ""),
            "org": info.get("organizationName", ""),
        }

    # --- Write usage cache ---
    cache_dir = os.path.join(home_dir, ".symphony")
    cache_file = os.path.join(cache_dir, "usage-cache.json")
    os.makedirs(cache_dir, exist_ok=True)

    account_key = (
        str(active_account["account_number"]) if active_account else "unknown"
    )

    existing_cache = {}
    if os.path.isfile(cache_file):
        try:
            with open(cache_file) as f:
                existing_cache = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass

    existing_cache[account_key] = {
        "five_hour": api["five_hour"]["utilization"],
        "seven_day": api["seven_day"]["utilization"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    with open(cache_file, "w") as f:
        json.dump(existing_cache, f, indent=2)

    # --- Output ---
    if json_mode:
        output = {
            "five_hour": api["five_hour"],
            "seven_day": api["seven_day"],
            "active_account": active_account,
            "accounts": accounts,
        }
        print(json.dumps(output, indent=2))
    else:
        if active_account:
            print(
                f"Account: {active_account['email']} (#{active_account['account_number']})"
            )
        else:
            print("Account: unknown")
        five = api["five_hour"]["utilization"]
        seven = api["seven_day"]["utilization"]
        five_reset = api["five_hour"].get("resets_at", "unknown")
        seven_reset = api["seven_day"].get("resets_at", "unknown")
        print(f"5-hour usage:  {five}%  (resets at {five_reset})")
        print(f"7-day usage:   {seven}%  (resets at {seven_reset})")


if __name__ == "__main__":
    main()
