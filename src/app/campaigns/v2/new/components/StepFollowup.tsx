"use client";

import { useMemo, type Dispatch } from "react";
import { AlertTriangle, MessageSquareText } from "lucide-react";

import {
  SHORTENED_URL_LENGTH, smsSegmentCount,
  type WizardAction, type WizardState,
} from "../wizardState";

interface Props {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
}

export default function StepFollowup({ state, dispatch }: Props) {
  // Derived values — ported verbatim from page-classic.tsx:241-257.
  const estimatedDeliveredLength = useMemo(() => {
    const msgLen = state.smsMessage.trim().length;
    const urlLen = state.smsLink.trim() ? SHORTENED_URL_LENGTH : 0;
    const optLen = state.smsOptout.trim().length;
    const spaces = (msgLen > 0 ? 1 : 0) + (urlLen > 0 ? 1 : 0);
    return msgLen + urlLen + optLen + spaces;
  }, [state.smsMessage, state.smsLink, state.smsOptout]);

  const smsSegments = smsSegmentCount(estimatedDeliveredLength);
  const hasUrlInMessage = /https?:\/\//i.test(state.smsMessage);
  const isValidSmsLink = state.smsLink.trim() === "" || state.smsLink.trim().startsWith("https://");
  const isSmsBodyEmpty = state.smsEnabled && state.smsMessage.trim().length === 0;

  function setSms<K extends keyof Pick<WizardState, "smsEnabled" | "smsMessage" | "smsLink" | "smsOptout" | "smsLinkEditing" | "smsOptoutEditing">>(
    key: K,
    value: WizardState[K],
  ) {
    dispatch({ type: "SET_SMS_FIELDS", payload: { [key]: value } as Partial<WizardState> });
  }

  /**
   * Compliance guards — confirm dialogs before unlocking the link / opt-out
   * fields. PORTED VERBATIM from page-classic.tsx:898 and 939. Do not
   * simplify away (real legal/compliance gate per R-list).
   */
  function unlockLink() {
    if (window.confirm("Changing the link affects where customers land. Continue?")) {
      setSms("smsLinkEditing", true);
    }
  }
  function unlockOptout() {
    if (window.confirm("Changing the opt-out text affects compliance. Continue?")) {
      setSms("smsOptoutEditing", true);
    }
  }

  return (
    <div className="flex-1 flex flex-col">
      <h1 className="text-[22px] font-bold tracking-tight">Send a follow-up text?</h1>
      <p className="text-sm text-[var(--text-3)] mt-1.5 leading-relaxed">
        Optional. After a successful call (goal reached), Voizo can fire an SMS via Mobivate
        within seconds.
      </p>

      <div className="mt-7 flex flex-col gap-[18px]">
        {/* Enable toggle row — items-center vertically centers the
            toggle with the whole text block instead of pinning it to
            the title line. */}
        <div className="flex items-center justify-between gap-4 p-4 rounded-2xl border-[1.5px] border-[var(--border)] bg-[var(--bg-app)]">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text-1)]">Post-call SMS</div>
            <div className="text-xs text-[var(--text-3)] mt-1 leading-relaxed">
              Send a Mobivate message after every <span className="font-mono text-[var(--text-2)]">goal_reached</span> call. Includes shortened link + STOP footer.
            </div>
          </div>
          <Toggle
            on={state.smsEnabled}
            onChange={(v) => setSms("smsEnabled", v)}
          />
        </div>

        {/* Body section */}
        {state.smsEnabled && (
          <div className="p-4 rounded-2xl border-[1.5px] border-[var(--border)] bg-[var(--bg-app)] flex flex-col gap-3.5">
            {/* Message */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)] block mb-1.5">
                Message
              </label>
              <textarea
                value={state.smsMessage}
                onChange={(e) => setSms("smsMessage", e.target.value)}
                rows={2}
                placeholder="Enter your promotional message..."
                className="w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none transition-all"
              />
              {hasUrlInMessage && (
                <p className="text-[10px] text-amber-400 mt-1 inline-flex items-center gap-1">
                  <AlertTriangle size={9} /> Tip: use the Link field below for URLs — they&apos;ll be auto-shortened.
                </p>
              )}
              {isSmsBodyEmpty && (
                <p className="text-[10px] text-red-400 mt-1">Message cannot be empty when SMS is enabled.</p>
              )}
            </div>

            {/* Link (locked-by-default) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                  Link
                  <span className="text-[10px] font-normal text-[var(--text-3)] normal-case ml-1.5">
                    auto-shortened to cllk.me/…
                  </span>
                </label>
                {!state.smsLinkEditing ? (
                  <button
                    type="button"
                    onClick={unlockLink}
                    className="text-[10px] text-blue-400 hover:text-blue-300 font-medium"
                  >
                    Edit
                  </button>
                ) : (
                  <span className="text-[10px] text-amber-400">Editing</span>
                )}
              </div>
              <input
                type="url"
                value={state.smsLink}
                onChange={(e) => setSms("smsLink", e.target.value)}
                disabled={!state.smsLinkEditing}
                placeholder="https://..."
                className={`w-full bg-[var(--bg-card)] border rounded-lg px-3 py-2 text-sm transition-all ${
                  !isValidSmsLink
                    ? "border-red-500/50 focus:ring-red-500"
                    : "border-[var(--border)] focus:ring-blue-500"
                } ${
                  state.smsLinkEditing
                    ? "text-[var(--text-1)] focus:outline-none focus:ring-1 focus:border-blue-500"
                    : "text-[var(--text-3)] opacity-75 cursor-not-allowed"
                }`}
              />
              {!isValidSmsLink && (
                <p className="text-[10px] text-red-400 mt-1">Link must start with https://</p>
              )}
            </div>

            {/* Opt-out (locked-by-default) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                  Opt-out footer
                </label>
                {!state.smsOptoutEditing ? (
                  <button
                    type="button"
                    onClick={unlockOptout}
                    className="text-[10px] text-blue-400 hover:text-blue-300 font-medium"
                  >
                    Edit
                  </button>
                ) : (
                  <span className="text-[10px] text-amber-400">Editing</span>
                )}
              </div>
              <input
                type="text"
                value={state.smsOptout}
                onChange={(e) => setSms("smsOptout", e.target.value)}
                disabled={!state.smsOptoutEditing}
                placeholder="e.g. STOP? Qwt5.me"
                className={`w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm transition-all ${
                  state.smsOptoutEditing
                    ? "text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    : "text-[var(--text-3)] opacity-75 cursor-not-allowed"
                }`}
              />
            </div>

            {/* Divider */}
            <div className="border-t border-[var(--border)]" />

            {/* Preview */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)] inline-flex items-center gap-1.5">
                  <MessageSquareText size={11} /> Preview
                </span>
                <span
                  className={`text-[10px] font-mono font-medium ${
                    smsSegments > 2
                      ? "text-red-400"
                      : smsSegments > 1
                        ? "text-amber-400"
                        : "text-emerald-400"
                  }`}
                >
                  ~{estimatedDeliveredLength} chars · {smsSegments} SMS{smsSegments !== 1 ? "" : ""}
                </span>
              </div>
              <p className="text-xs text-[var(--text-2)] leading-relaxed whitespace-pre-wrap bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2">
                {state.smsMessage.trim()}
                {state.smsLink.trim() ? ` ${state.smsLink.trim()}` : ""}
                {state.smsOptout.trim() ? ` ${state.smsOptout.trim()}` : ""}
              </p>
              <p className="text-[10px] text-[var(--text-3)] mt-1">
                Link appears shortened (cllk.me) on delivery.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Custom toggle (HTML mockup styling)
// ─────────────────────────────────────────────────────────────────────────

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  // 40x22 pill with a 16x16 knob. left:3 + (on ? translate 18 : 0)
  // → off knob spans x=3..19 (margin 3px both sides), on knob spans
  // x=21..37 (margin 3px both sides). Vertically the knob's top:3 makes
  // it span y=3..19, centered in the 22px pill (margin 3px above + below).
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative w-[40px] h-[22px] rounded-full transition-colors flex-shrink-0 ${
        on ? "bg-blue-500" : "bg-[var(--bg-elevated)]"
      }`}
    >
      <span
        className={`block absolute top-[3px] left-[3px] w-[16px] h-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-transform duration-200 ${
          on ? "translate-x-[18px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
