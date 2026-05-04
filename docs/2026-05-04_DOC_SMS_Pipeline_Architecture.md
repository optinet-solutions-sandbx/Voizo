# SMS Pipeline Architecture — How SMS Fires After a Call

**Last updated:** 2026-05-04
**Status:** Live (transcript fallback active while Vapi analysis is broken)

---

## Flow: Call → SMS

```
Customer picks up
    ↓
Vapi AI agent conducts call
    ↓
Call ends → Vapi POSTs end-of-call-report to our webhook
    ↓
Webhook authenticates (x-vapi-secret, constant-time compare)
    ↓
Match call to calls_v2 row (vapi_call_id → provider_call_id → phone fallback)
    ↓
Evaluate goal_reached:
  1. Check Vapi's analysis.successEvaluation (preferred)
  2. If analysis empty → transcript fallback (regex on AI confirmation phrases)
    ↓
Evaluate opt-out:
  1. Check Vapi's structuredData.optOut (preferred)
  2. If structuredData empty → transcript fallback (customer signals)
    ↓
Update calls_v2 (goal_reached, transcript)
Update campaign_numbers_v2 (outcome)
    ↓
If opted out → upsert to suppression_list
    ↓
SMS gate (ALL three must hold):
  ✓ goal_reached = true
  ✓ campaign.sms_enabled = true
  ✓ campaign.sms_on_goal_reached_only = true
    ↓
Additional gates:
  ✓ Not on suppression_list
  ✓ No existing SMS for this call_id (idempotency)
    ↓
Insert sms_messages_v2 row (status: queued) ← state before provider call
    ↓
Call Mobivate API (sendSMS)
    ↓
Update sms_messages_v2 (status: sent/failed, provider_message_id)
    ↓
Mobivate sends delivery receipt → delivery-status webhook
    ↓
Update sms_messages_v2 (status: delivered/failed/undelivered)
```

## Transcript Fallback Evaluation

Active because Vapi's post-call analysis never runs on SIP inbound calls (51/51 returned `analysis:{}`). Escalated to Vapi.

### Goal reached detection

**Pattern 1 — Explicit SMS mention:**
```
/i(?:'ll| will) send (?:you |the )?(?:an? )?(?:sms|text)/i
```
Matches: "I'll send you an SMS", "I will send the text", "I'll send you a text message"

**Pattern 2 — Contextual (two conditions AND'd):**
```
smsDiscussed: /\bsms\b|text message/i
aiConfirmedSend: /i(?:'ll| will) send (?:that|it)\b/i
```
Matches: SMS/text discussed earlier + AI says "I'll send that over" later.
Both must hold to avoid false positives.

### Opt-out detection

Compliance-first — false positive (suppress) safer than false negative (keep calling).

```
stopCalls: /(?:don'?t|do not|stop|never) (?:call|contact|phone)/i
removeMe: /(?:remove|take) (?:me|my (?:number|phone)) (?:off|from|out)/i
```

Detects on customer signals alone — no AI confirmation required.

## System Prompt Prefix

Every cloned assistant receives a dev-controlled prefix prepended to the agent prompt:

1. **SMS CONFIRMATION** — AI must verbally confirm "I'll send you an SMS now"
2. **CALL ENDING** — Don't end call immediately after customer agrees
3. **OPT-OUT** — Acknowledge opt-out request respectfully

Lives in `src/app/api/vapi/clone-assistant/route.ts`. Only new campaigns get the prefix.

## Mobivate Configuration

| Setting | Value | Purpose |
|---------|-------|---------|
| `shortenUrls` | `true` | Mobivate shortens URLs to `cllk.me/xxxxx` |
| `excludeOptouts` | `true` | Mobivate-side opt-out filtering |
| `reference` | `sms_messages_v2.id` | Correlates delivery receipts to our rows |
| `originator` | `MOBIVATE_SENDER_ID` env var | "Lucky7even" (pending carrier approval) |

## Delivery Receipt Handling

Mobivate delivery receipts arrive as JSON or form-encoded (both supported).
No webhook authentication (Mobivate doesn't sign callbacks).
Validation: match `reference` (our UUID) against `sms_messages_v2.id`.

Status mapping:
| Mobivate status | Our status |
|----------------|------------|
| DELIVERED, DELIVRD | delivered |
| UNDELIVERED, UNDELIVERABLE | undelivered |
| ACCEPTED, SENT, ENROUTE | sent |
| Everything else | failed |

## Key files

| File | Role |
|------|------|
| `src/app/api/webhooks/vapi/end-of-call/route.ts` | Main orchestrator: auth, matching, evaluation, SMS dispatch |
| `src/app/api/vapi/clone-assistant/route.ts` | Creates cloned assistant with system prefix + webhook secret |
| `src/lib/mobivate.ts` | Mobivate API client (send only, no DB writes) |
| `src/app/api/webhooks/mobivate/delivery-status/route.ts` | Receives delivery receipts, updates sms_messages_v2 |
