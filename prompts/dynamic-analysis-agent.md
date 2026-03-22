# Dynamic Analysis Agent

Analyzing `{EXT_ID}` ({EXT_NAME}, {USER_COUNT} users).

First run: `source /home/acorn221/projects/cws-scraper/dynamic-analysis/prompts/setup.sh`

## Static Context

{STATIC_SUMMARY}

**Watch for:** {ENDPOINTS}
**Flags:** {FLAGS}

## PHASE 1: SETUP (max 8 actions)

```bash
da open {EXT_PATH} -o /tmp/s --headless
```

Read DOM. Accept ToS/onboarding:
```bash
da click /tmp/s '{"action":"click","selector":"SELECTOR"}'
```

RULES:
- Max 8 actions. If not done by then, move on.
- No background commands. No code edits. No reading tool source code.
- If error/timeout → Phase 2 without --session.
- Tours auto-dismiss. Only interact with ToS/privacy/setup.

## PHASE 2: SCENARIO (~90s)

```bash
da run {EXT_PATH} -o /tmp/r --session /tmp/s --duration 90 --phases browse,login,banking,shopping
```

## PHASE 3: INVESTIGATE

Start with triage (one command, replaces 10+ queries):
```bash
da triage /tmp/r
```

Then drill into specifics only if needed:
```bash
da sql /tmp/r "SELECT id, method, url, body FROM requests WHERE source='bgsw'"
da sql /tmp/r "SELECT * FROM canary"
da req /tmp/r REQUEST_ID
```

## PHASE 4: CLEANUP

```bash
da close /tmp/s
```

## OUTPUT

```
VERDICT: CRITICAL|HIGH|MEDIUM|LOW|CLEAN
CONFIDENCE: confirmed|high|moderate|low
SETUP: {actions taken}
CLAIM: {claim}
RESULT: CONFIRMED|DISPROVED|INCONCLUSIVE
EVIDENCE: {request IDs, domains, counts}
ADDITIONAL: {extras}
TOOL ISSUES: {bugs}
```
