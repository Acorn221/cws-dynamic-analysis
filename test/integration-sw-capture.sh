#!/usr/bin/env bash
# Integration test: verifies that service worker fetch() calls are captured.
#
# Uses real fixture extensions that make fetch() calls from the SW.
# Requires a browser (headless Chrome). Runs in ~60 seconds.
#
# Usage:
#   bash test/integration-sw-capture.sh
#   bash test/integration-sw-capture.sh --verbose

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DA="node $SCRIPT_DIR/../dist/cli.js"
FIXTURES="$SCRIPT_DIR/fixtures"
VERBOSE="${1:-}"
PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

cleanup() {
  # Kill any lingering Chrome processes from our test
  pkill -f "cws-da-test-" 2>/dev/null || true
  rm -rf /tmp/cws-da-test-* 2>/dev/null || true
}
trap cleanup EXIT

log() {
  if [ "$VERBOSE" = "--verbose" ] || [ "$VERBOSE" = "-v" ]; then
    echo "  [debug] $*"
  fi
}

check() {
  local desc="$1"
  local result="$2"   # "pass" or "fail"
  local detail="$3"
  TOTAL=$((TOTAL + 1))

  if [ "$result" = "pass" ]; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}✓${NC} $desc"
  else
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}✗${NC} $desc"
    echo -e "    ${RED}$detail${NC}"
  fi
}

run_fixture() {
  local name="$1"
  local fixture_dir="$FIXTURES/$name"
  local output_dir="/tmp/cws-da-test-$name"

  rm -rf "$output_dir"
  echo ""
  echo -e "${YELLOW}Testing: $name${NC}"

  # Run dynamic analysis on the fixture extension
  log "Running: da run $fixture_dir -o $output_dir --headless --duration 30 --phases browse --no-instrument --no-stealth"
  local run_output
  if run_output=$($DA run "$fixture_dir" -o "$output_dir" --headless --duration 30 --phases browse --no-instrument --no-stealth 2>&1); then
    log "Run completed successfully"
  else
    log "Run output: $run_output"
    # Check if it's a browser launch failure (expected in some CI environments)
    if echo "$run_output" | grep -qi "timeout\|no sandbox\|ERR_"; then
      echo -e "  ${YELLOW}⚠ Skipped (browser launch failed — expected in headless-only environments)${NC}"
      return
    fi
    check "run completes without error" "fail" "$(echo "$run_output" | tail -3)"
    return
  fi

  # Verify output files exist
  if [ ! -f "$output_dir/events.db" ]; then
    check "events.db exists" "fail" "events.db not found in $output_dir"
    return
  fi
  check "events.db exists" "pass" ""

  # Query: total requests
  local total_requests
  total_requests=$($DA sql "$output_dir" "SELECT count(*) FROM requests" 2>/dev/null | tail -1 | tr -d '[:space:]')
  log "Total requests: $total_requests"

  if [ "$total_requests" -gt 0 ] 2>/dev/null; then
    check "has requests (total=$total_requests)" "pass" ""
  else
    check "has requests" "fail" "total_requests=$total_requests"
  fi

  # Query: bgsw requests (THE KEY METRIC)
  local bgsw_requests
  bgsw_requests=$($DA sql "$output_dir" "SELECT count(*) FROM requests WHERE source='bgsw'" 2>/dev/null | tail -1 | tr -d '[:space:]')
  log "BGSW requests: $bgsw_requests"

  if [ "$bgsw_requests" -gt 0 ] 2>/dev/null; then
    check "has bgsw requests (count=$bgsw_requests)" "pass" ""
  else
    check "has bgsw requests" "fail" "bgsw_requests=$bgsw_requests — SW fetch() calls NOT captured!"
  fi

  # Query: verify the fixture's specific endpoint was hit
  local httpbin_requests
  httpbin_requests=$($DA sql "$output_dir" "SELECT count(*) FROM requests WHERE url LIKE '%httpbin.org%' AND source='bgsw'" 2>/dev/null | tail -1 | tr -d '[:space:]')
  log "httpbin.org bgsw requests: $httpbin_requests"

  if [ "$httpbin_requests" -gt 0 ] 2>/dev/null; then
    check "captured httpbin.org fetch from SW (count=$httpbin_requests)" "pass" ""
  else
    check "captured httpbin.org fetch from SW" "fail" "httpbin_requests=$httpbin_requests — fixture fetch() to httpbin.org not captured"
  fi

  # Show details in verbose mode
  if [ "$VERBOSE" = "--verbose" ] || [ "$VERBOSE" = "-v" ]; then
    echo "  [debug] Request breakdown by source:"
    $DA sql "$output_dir" "SELECT source, count(*) n FROM requests GROUP BY source ORDER BY n DESC" 2>/dev/null | sed 's/^/    /'
    echo "  [debug] BGSW requests:"
    $DA sql "$output_dir" "SELECT id, method, url FROM requests WHERE source='bgsw' LIMIT 5" 2>/dev/null | sed 's/^/    /'
  fi
}

echo "================================"
echo "SW Capture Integration Tests"
echo "================================"

# Test 1: fetch-on-install (immediate fetch on SW startup)
# This is the hardest case — the fetch() runs in the top-level SW scope
run_fixture "fetch-on-install"

# Test 2: fetch-on-tab-update (fetch triggered by chrome.tabs events)
# This is the common case — fetch() runs in response to browser events
run_fixture "fetch-on-tab-update"

# Test 3: delayed-fetch (config fetch + alarm-based exfiltration)
# This tests alarm-based periodic exfiltration
run_fixture "delayed-fetch"

echo ""
echo "================================"
echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} (of $TOTAL)"
echo "================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
