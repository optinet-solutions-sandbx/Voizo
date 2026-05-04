# HANDOFF — SMS Pipeline End-to-End Fix

**Date:** 2026-05-04 (Sunday)
**Owner:** Jasiel Emro Anasco (jas@optinetsolutions.com)
**Commits:** `cd08e5d` → `19c2c64` + audit fix (8 commits on `main`)
**Previous handoff:** `2026-04-30_HANDOFF_Webhook_Auth_Fix.md`

---

## 1. What shipped (8 commits)

| # | Commit | What |
|---|--------|------|
| 1 | `cd08e5d` | Transcript fallback — Pattern 1 (explicit "I'll send you an SMS") |
| 2 | `a83e34f` | Widened regex — Pattern 2 (contextual: SMS discussed + generic send) |
| 3 | `be80bd8` | Diagnostic logging for Vapi support ticket (temporary — remove when resolved) |
| 4 | `2e2a3c9` | System prompt prefix injection on every cloned assistant |
| 5 | `5ade75f` | Opt-out transcript fallback detection |
| 6 | `265841d` | Mobivate URL shortening (`shortenUrls`) + opt-out filtering (`excludeOptouts`) |
| 7 | `19c2c64` | Mobivate delivery-status webhook: handle form-encoded callbacks |
| 8 | (pending) | Audit fixes: `maxDuration`, remove `campaign!` assertion, remove dead code |

## 2. Why — the two root causes

### Root cause 1: Vapi analysis never runs (STILL BROKEN)
- 51/51 SIP inbound calls return `analysis: {}` — zero analysis tokens consumed.
- Vapi's end-of-call-report webhook emits a truncated call object missing `analysisPlan`, `artifact`, `endedReason`.
- Escalated to Vapi backend team via Composer with full evidence (call IDs, field comparison, assistant configs).
- **Status: Waiting on Vapi. Our transcript fallback bypasses this entirely.**

### Root cause 2: AI phrasing didn't match our detection (FIXED)
- Maria's test call: AI said "I'll send that over now" instead of "I'll send you an SMS".
- Pattern 1 only matched explicit SMS mentions. Added Pattern 2 (contextual match).
- Added system prompt prefix forcing AI to confirm SMS dispatch verbally.

## 3. How the transcript fallback works

Since Vapi's analysis is broken, we evaluate the transcript ourselves:

**Goal reached (SMS confirmation):**
- Pattern 1 (explicit): `/i(?:'ll| will) send (?:you |the )?(?:an? )?(?:sms|text)/i`
- Pattern 2 (contextual): `smsDiscussed` AND `aiConfirmedSend` — both must hold
- Vapi's own analysis takes priority when present — fallback is a safety net

**Opt-out detection:**
- `/(?:don'?t|do not|stop|never) (?:call|contact|phone)/i`
- `/(?:remove|take) (?:me|my (?:number|phone)) (?:off|from|out)/i`
- Compliance-first: false positive (suppress number) safer than false negative (keep calling)

## 4. System prompt prefix (Chris's architecture)

Every cloned assistant now gets a dev-controlled prefix prepended to the agent prompt:

```
[System Instructions — Voizo Platform]
1. SMS CONFIRMATION: Must verbally confirm "I'll send you an SMS now"
2. CALL ENDING: Don't end call immediately after customer agrees
3. OPT-OUT: Acknowledge opt-out request respectfully
[End System Instructions]
```

This lives in `clone-assistant/route.ts`. Ernie/Maria's agent prompt follows after.
Only new campaigns get the prefix — existing campaigns need a re-clone.

## 5. Mobivate changes

- `shortenUrls: true` — Mobivate natively shortens URLs to `cllk.me/xxxxx` links
- `excludeOptouts: true` — Mobivate-side opt-out filtering (additional safety layer)
- Delivery-status webhook now handles both JSON and URL-encoded form callbacks
- **PH routes confirmed live** — €0.14-0.15/SMS, tested to Ernie's +63 number

## 6. Audit fixes (commit pending)

- **`maxDuration = 30`** — prevents Vercel 504 if Mobivate API is slow
- **`campaign!` → `campaign`** — removed non-null assertion; added explicit `&& campaign` guard
- **`goalSource` removed** — dead variable, provenance already tracked in log lines

## 7. Verified end-to-end

- Jas's number: call → goal_reached=true → SMS sent → delivered to phone ✅
- Ernie's number: call → goal_reached=true → SMS sent → delivered to phone ✅
- Ernie's number: direct Mobivate test → PH delivery + URL shortening confirmed ✅

## 8. What to do next

### MUST DO
1. **Commit and push** the audit fixes (maxDuration + campaign guard + dead code removal)
2. **Maria re-test** — she needs to create a NEW campaign (gets system prompt prefix)
3. **Mobivate sender ID** — "Lucky7even" pending approval (GI, CA). Submit PH registration on Mobivate dashboard.
4. **Monitor Vapi ticket** — watch for response on analysis pipeline fix

### WHEN VAPI FIXES ANALYSIS
- Their `successEvaluation` will start populating
- Our code auto-prefers Vapi's analysis over the transcript fallback (line 118: `if (successEval == null)`)
- Remove diagnostic logging (commit `be80bd8`) once confirmed stable
- Consider removing transcript fallback after 2 weeks of stable Vapi analysis

### DO NOT TOUCH
- Originate-shim + webhook-shim — stable on EC2
- Suppression list pipeline — verified e2e, auto-suppress on opt-out
- VAPI_WEBHOOK_SECRET — set on all assistants
- Tom's agent prompts — Ernie/Maria's asset (system prefix is separate)

## 9. Known gaps (from audit)

| Gap | Risk | Status |
|-----|------|--------|
| No auth on `/api/vapi/clone-assistant` | Low (demo phase) | Manifesto tracked gap |
| No auth on Mobivate delivery webhook | Very low (UUIDs, no side effects) | Accepted, documented |
| SMS dispatch inline before 200 | Medium (mitigated by maxDuration) | Tracked for `after()` migration |
| Vapi retry race on idempotency check | Very low (retry delay > handler time) | Acceptable |
