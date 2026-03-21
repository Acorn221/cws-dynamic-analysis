# Dynamic Analysis Agent Prompt

You are analyzing Chrome extension `{EXT_ID}` (`{EXT_NAME}`, {USER_COUNT} users).

All commands run from: `/home/acorn221/projects/cws-scraper/dynamic-analysis/`

## Static Analysis Context

{STATIC_SUMMARY}

**Endpoints to watch for:** {ENDPOINTS}
**Flags:** {FLAGS}

## PHASE 1: SETUP (max 8 actions, 2 minutes)

Open the extension and complete any onboarding:

```bash
node dist/cli.js interact start {EXT_PATH} -o /tmp/da-session --headless
```

Read the DOM snapshot. If there's a ToS/privacy policy/onboarding, accept everything:

```bash
node dist/cli.js interact action /tmp/da-session '{"action":"click","selector":"SELECTOR"}'
```

**RULES:**
- Max 8 interact actions. If onboarding isn't done by then, move on.
- Each action returns a new DOM snapshot. Read it before deciding the next action.
- If an action returns "ACTION FAILED", try a different selector or move on.
- If an action returns "ERROR" or times out, the session may be dead. Move to Phase 2 without --session.
- DO NOT edit any source code. If something is broken, report it and continue.
- DO NOT run interact commands in the background. They return inline.

When setup is done (or you've hit 8 actions), proceed to Phase 2. **Do NOT call `interact stop`** — the browser stays open for Phase 2.

## PHASE 2: BROWSING SCENARIO (automated, ~90 seconds)

Run the scenario on the same browser session:

```bash
node dist/cli.js run {EXT_PATH} -o /tmp/da-results --session /tmp/da-session --duration 90 --phases browse,login,banking,shopping
```

If --session fails, fall back to fresh browser:
```bash
node dist/cli.js run {EXT_PATH} -o /tmp/da-results --headless --duration 90 --no-instrument --phases browse,login,banking,shopping
```

## PHASE 3: INVESTIGATION

Query the results. Focus on proving/disproving the static analysis claims.

```bash
# Overview
node dist/cli.js query summary /tmp/da-results

# Extension-originated traffic (most important)
node dist/cli.js query network /tmp/da-results --source bgsw
node dist/cli.js query network /tmp/da-results --source cs

# Check for specific endpoints from static analysis
node dist/cli.js query network /tmp/da-results --domain {DOMAIN_1}
node dist/cli.js query network /tmp/da-results --domain {DOMAIN_2}

# All external domains
node dist/cli.js query domains /tmp/da-results

# Canary data exfiltration (strongest signal)
node dist/cli.js query canary /tmp/da-results

# Chrome API usage
node dist/cli.js query hooks /tmp/da-results --api chrome --unique

# Extension console output
node dist/cli.js query console /tmp/da-results --source extension

# Manifest/permissions
node dist/cli.js query manifest /tmp/da-results

# Drill into suspicious requests
node dist/cli.js query request /tmp/da-results <REQUEST_ID>
```

## PHASE 4: CLEANUP & REPORT

```bash
node dist/cli.js interact stop /tmp/da-session
```

Return your findings in this format:

```
VERDICT: {CRITICAL|HIGH|MEDIUM|LOW|CLEAN}
CONFIDENCE: {confirmed|high|moderate|low}

SETUP: {what you saw and clicked during onboarding}

CLAIM: {static analysis claim 1}
RESULT: CONFIRMED | DISPROVED | INCONCLUSIVE
EVIDENCE: {specific request IDs, domains, API calls, or lack thereof}

CLAIM: {static analysis claim 2}
RESULT: ...
EVIDENCE: ...

ADDITIONAL FINDINGS: {anything static analysis missed}

TOOL ISSUES: {any CLI bugs or limitations encountered}
```

Return ONLY this structured output. No other text.
