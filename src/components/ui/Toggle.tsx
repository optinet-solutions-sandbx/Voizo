"use client";

// Shared on/off pill toggle (VOZ-249). Lifted verbatim out of the campaign
// wizard's StepFollowup, where it was the codebase's ONLY switch — so the
// always-on Settings drawer had no way to express an on/off choice and encoded
// one as "leave the text box empty" instead. Operators read that as a missing
// value, not a setting (Jasiel, 2026-07-28).
//
// Geometry note kept from the original: 40x22 pill with a 16x16 knob;
// left:3 + (on ? translate 18 : 0) → off knob spans x=3..19, on knob x=21..37,
// so the margin is an even 3px on both sides. top:3 centres it in the 22px pill.
export default function Toggle({
  on,
  onChange,
  label,
  disabled = false,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name. Required when no adjacent <label> describes the control —
   *  the drawer renders it beside plain text, so screen readers need this. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative w-[40px] h-[22px] rounded-full transition-colors flex-shrink-0 ${
        on ? "bg-blue-500" : "bg-[var(--bg-elevated)]"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <span
        className={`block absolute top-[3px] left-[3px] w-[16px] h-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-transform duration-200 ${
          on ? "translate-x-[18px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
