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

RULES: Max 8 actions. No background. No code edits. If error → Phase 2 without --session.

## PHASE 2: SCENARIO (~90s)

```bash
da run {EXT_PATH} -o /tmp/r --session /tmp/s --duration 90 --phases browse,login,banking,shopping
```

## PHASE 3: INVESTIGATE

```bash
da summary /tmp/r
da net /tmp/r --source bgsw
da net /tmp/r --source cs
da net /tmp/r --domain {DOMAIN}
da domains /tmp/r
da canary /tmp/r
da hooks /tmp/r --api chrome --unique
da log /tmp/r --source extension
da manifest /tmp/r
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
