#!/usr/bin/env bash
# Smoke test: validates all CLI commands work against the test fixture.
# Runs in <5 seconds. No browser needed.
# Usage: npm test   OR   bash test/smoke.sh
set -e

DIR="$(dirname "$0")/fixtures/urban-vpn"
DA="node $(dirname "$0")/../dist/cli.js"
PASS=0
FAIL=0

check() {
  local desc="$1"; shift
  if output=$("$@" 2>&1); then
    PASS=$((PASS + 1))
    echo "  ✓ $desc"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $desc"
    echo "    $output" | head -3
  fi
}

echo "Smoke testing against: $DIR"
echo ""

echo "Query commands:"
check "summary"     $DA query summary "$DIR"
check "stats"       $DA query stats "$DIR"
check "manifest"    $DA query manifest "$DIR"
check "net"         $DA query network "$DIR" --limit 3
check "net --source bgsw"  $DA query network "$DIR" --source bgsw --limit 3
check "net --flagged"      $DA query network "$DIR" --flagged --limit 3
check "net --domain urban" $DA query network "$DIR" --domain urban --limit 3
check "net --json"  $DA query network "$DIR" --json --limit 2
REQ_ID=$($DA sql "$DIR" "SELECT id FROM requests LIMIT 1" 2>/dev/null | tail -1)
check "request"     $DA query request "$DIR" "$REQ_ID"
check "hooks"       $DA query hooks "$DIR" --limit 3
check "hooks --unique" $DA query hooks "$DIR" --unique --limit 3
check "hooks --api chrome" $DA query hooks "$DIR" --api chrome --unique --limit 3
check "canary"      $DA query canary "$DIR"
check "domains"     $DA query domains "$DIR"
check "domains --json" $DA query domains "$DIR" --json
check "console"     $DA query console "$DIR" --limit 3
check "console --level error" $DA query console "$DIR" --level error --limit 3

echo ""
echo "SQL commands:"
check "sql .tables"  $DA sql "$DIR" ".tables"
check "sql .schema"  $DA sql "$DIR" ".schema"
check "sql count"    $DA sql "$DIR" "SELECT count(*) n FROM requests"
check "sql group"    $DA sql "$DIR" "SELECT source, count(*) n FROM requests GROUP BY source"
check "sql hooks"    $DA sql "$DIR" "SELECT api, count(*) n FROM hooks GROUP BY api ORDER BY n DESC LIMIT 5"
check "sql canary"   $DA sql "$DIR" "SELECT * FROM canary"

echo ""
echo "Shortcuts:"
check "da summary"   $DA summary "$DIR"
check "da net"       $DA net "$DIR" --limit 2
check "da hooks"     $DA hooks "$DIR" --unique --limit 3
check "da canary"    $DA canary "$DIR"
check "da domains"   $DA domains "$DIR"
check "da log"       $DA log "$DIR" --limit 2
check "da manifest"  $DA manifest "$DIR"
check "da stats"     $DA stats "$DIR"

echo ""
echo "================================"
echo "  $PASS passed, $FAIL failed"
echo "================================"

[ $FAIL -eq 0 ] || exit 1
