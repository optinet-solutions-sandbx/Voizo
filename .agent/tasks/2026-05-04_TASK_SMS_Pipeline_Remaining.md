# TASK — SMS Pipeline Remaining Work

**Created:** 2026-05-04
**Priority:** High (blocking Maria/Ernie's production use)
**Depends on:** `2026-05-04_HANDOFF_SMS_Pipeline_E2E.md`

---

## Open items — ordered by priority

### P0 — Blocking production

- [ ] **Maria re-test with new campaign** — She must create a NEW campaign so the clone gets the system prompt prefix. Existing campaigns don't have it.
- [ ] **Commit + push audit fixes** — `maxDuration`, `campaign!` removal, `goalSource` removal. Code is edited, needs `git commit && push`.

### P1 — Operational

- [ ] **Mobivate sender ID registration**
  - "Lucky7even" is Pending for Gibraltar (GI) and Canada (CA)
  - Philippines (PH) is missing — submit "New Request" on Mobivate dashboard → Originator section
  - Until approved, carrier overrides sender to "CloudOTP" or similar
- [ ] **Monitor Vapi support ticket** — Analysis pipeline bug. Escalated via Composer with call IDs, field comparison, assistant configs. Watch for response.
- [ ] **Verify delivery receipts flowing** — After next real SMS, check Vercel logs for `[mobivate/delivery-status]` lines. Confirm status updates from `sent` → `delivered` in `sms_messages_v2`.

### P2 — Cleanup (after Vapi fixes analysis)

- [ ] **Remove diagnostic logging** — Commit `be80bd8` added temporary `[vapi-diag] call-object:` logging. Remove once Vapi resolves the analysis issue. Code comment marks it as temporary.
- [ ] **Evaluate transcript fallback removal** — After 2+ weeks of stable Vapi analysis, consider removing the transcript-based fallback. The code auto-prefers Vapi's analysis (`if (successEval == null)`), so the fallback only fires when analysis is missing.
- [ ] **Migrate SMS dispatch to `after()`** — Next.js App Router `after()` API runs code after returning 200. Would fully comply with Manifesto §6 "Return 200 fast." Currently mitigated by `maxDuration = 30`.

### P3 — Hardening (pre-production)

- [ ] **Add auth to `/api/vapi/clone-assistant`** — Currently zero auth. Anyone can create Vapi assistants. Manifesto tracks this as a known gap. Must fix before customer dialing.
- [ ] **Add rate limiting to clone-assistant** — Prevent bulk creation of billable Vapi resources.
- [ ] **IP allowlisting for Mobivate delivery webhook** — Optional. Mobivate doesn't sign callbacks, so IP-based filtering is the only realistic auth. Ask Mobivate for their callback IP range.
- [ ] **Enable `noUnusedLocals` in tsconfig** — Would catch dead code like `goalSource` at compile time.

## Files modified this session

| File | What changed |
|------|-------------|
| `src/app/api/webhooks/vapi/end-of-call/route.ts` | Transcript fallback, opt-out fallback, diagnostic logging, maxDuration, audit fixes |
| `src/app/api/vapi/clone-assistant/route.ts` | System prompt prefix injection |
| `src/lib/mobivate.ts` | `shortenUrls: true`, `excludeOptouts: true` |
| `src/app/api/webhooks/mobivate/delivery-status/route.ts` | Form-encoded body parsing |
