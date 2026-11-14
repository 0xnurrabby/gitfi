#!/usr/bin/env bash
set -euo pipefail

# Deploy the GitFi Repo Registry to NEAR.
# Prerequisites: near-cli-rs, cargo-near, an initialized `near` account, and
# a 32-byte oracle public key exported by the GitFi API (/api/ledger).

ACCOUNT_ID="${GITFI_ACCOUNT_ID:-gitfi.testnet}"
TREASURY_ID="${GITFI_TREASURY_ID:-treasury.${ACCOUNT_ID#*.}}"
ORACLE_KEY_FILE="${GITFI_ORACLE_KEY_FILE:-}"

if [[ -z "${ORACLE_KEY_FILE}" || ! -f "${ORACLE_KEY_FILE}" ]]; then
  echo "Set GITFI_ORACLE_KEY_FILE to a file containing the 32-byte oracle public key as JSON."
  exit 1
fi

cargo near build
cargo near deploy "${ACCOUNT_ID}" with-init-call new \
  json-args "{\"owner_id\":\"${TREASURY_ID}\",\"oracle_public_key\":$(cat "${ORACLE_KEY_FILE}")}" \
  prepaid-gas '100.0 Tgas' \
  attached-deposit '0 NEAR'
