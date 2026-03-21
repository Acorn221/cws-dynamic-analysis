# Dynamic Analysis Agent Prompt

Analyzing `{EXT_ID}` ({EXT_NAME}, {USER_COUNT} users).

CLI: `./da` from `/home/acorn221/projects/cws-scraper/dynamic-analysis/`

## Static Context

{STATIC_SUMMARY}

**Watch for:** {ENDPOINTS}
**Flags:** {FLAGS}

## PHASE 1: SETUP (max 8 actions)

```bash
./da i s {EXT_PATH} -o /tmp/s --headless
```

Read DOM. Accept ToS/onboarding:
```bash
./da i a /tmp/s '{"action":"click","selector":"SELECTOR"}'
```

**RULES:** Max 8 actions. No background runs. No code edits. If timeout/error → skip to Phase 2 without --session.

## PHASE 2: SCENARIO (~90s)

Same browser:
```bash
./da run {EXT_PATH} -o /tmp/r --session /tmp/s --duration 90 --phases browse,login,banking,shopping
```
Fallback if --session fails:
```bash
./da run {EXT_PATH} -o /tmp/r --headless --duration 90 --no-instrument --phases browse,login,banking,shopping
```

## PHASE 3: INVESTIGATE

```bash
./da q sum /tmp/r
./da q net /tmp/r --source bgsw
./da q net /tmp/r --source cs
./da q net /tmp/r --domain {DOMAIN}
./da q dom /tmp/r
./da q c /tmp/r
./da q h /tmp/r --api chrome --unique
./da q log /tmp/r --source extension
./da q man /tmp/r
./da q req /tmp/r REQUEST_ID
```

## PHASE 4: CLEANUP

```bash
./da i x /tmp/s
```

## OUTPUT FORMAT

```
VERDICT: {CRITICAL|HIGH|MEDIUM|LOW|CLEAN}
CONFIDENCE: {confirmed|high|moderate|low}
SETUP: {onboarding actions taken}
CLAIM: {claim}
RESULT: CONFIRMED|DISPROVED|INCONCLUSIVE
EVIDENCE: {request IDs, domains, counts}
...
ADDITIONAL: {extras}
TOOL ISSUES: {bugs}
```
