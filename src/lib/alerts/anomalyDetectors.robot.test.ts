import { describe, expect, it } from "vitest";
import {
  ROBOT_TEXTED_MONOLOGUE_WORDS,
  detectRobotTexted,
  robotTextedRule,
  type RobotTextedCandidate,
} from "./anomalyDetectors";

// Detector D (2026-08-27) — "texted a robot". Every fixture is a REAL production
// transcript, trimmed. The detector only ever produces a Slack line, so the bar
// is: catch every incident we have already paid for, and stay silent on the
// texted humans who stayed on the line.

const OPENER =
  "AI: Hey, Victor here from Lucky Seven dot com. Quick question. Have you had a chance to log in to your account recently?";

function cand(over: Partial<RobotTextedCandidate> = {}): RobotTextedCandidate {
  return {
    smsId: "sms-1",
    callId: "call-1",
    campaignName: "VOIZO REACTIVATION - NZ | Daily Automated (2026-08-27)",
    mode: "optin_reached_only",
    transcript: `${OPENER}\nUser: Yeah hi, sorry who is this?\nAI: It's Victor from Lucky Seven.\nUser: Oh right, no I'm good thanks.`,
    ...over,
  };
}

// ── the incidents this detector exists for ──────────────────────────────────
const INCIDENTS = {
  // 13 Aug: 21 identical pickups texted. The classifier knows this NOW, so the
  // classifier rule fires first — the point is that it fires at all.
  stayOnTheLine: `${OPENER}\nUser: Thanks. Please stay on the line.\nAI: Goodbye.`,
  // 20-24 Aug: Google Call Assist (a98e617 taught the classifier this too).
  callAssist:
    "User: Hi. I'm call assist by Google, recording this call for the person you're trying to reach. Before I try to connect you, can I ask what you're calling about?\nAI: Goodbye.",
  // The FOURTH family, found 2026-08-27 while measuring this detector: texted as
  // humans, the classifier does not know them. These must trip on the TRIPWIRE.
  cantTakeYourMessage: `${OPENER}\nUser: Hi. The person you have called is not available. We can't take your message at this time. Please call again later. Goodbye.`,
  mailboxCannotReceive: `${OPENER}\nUser: You've reached three zero six three eight one six five four zero. This mailbox cannot receive messages at this time.`,
  operatorsBusy: `${OPENER}\nUser: Hi, and thanks for calling the Coogee Sands Hotel and Apartments. All of our operators are busy on other calls at the moment, but hold the line.`,
  leaveAVoiceMessage: `${OPENER}\nUser: Hey. This is Rob Lonnie. Contact your call right now, but, uh, leave us a voice message, and I'll get back to you.`,
  // An UNKNOWN script — no phrase we have ever seen — still trips on shape alone:
  // one uninterrupted 20+ word turn and nothing else from the "customer".
  unknownScriptMonologue: `${OPENER}\nUser: Greetings and welcome to the automated reception desk of Northgate Dental, where your smile is our priority every single day of the week.\nAI: Goodbye.`,
};

// ── texted humans who must NOT trip ─────────────────────────────────────────
const HUMANS = {
  // multi-turn, short turns — the shape of a real texted human
  shortExchange: cand().transcript,
  // one turn, but short: "Hello?" then the agent talked and they hung up
  oneShortTurn: `${OPENER}\nUser: Hello? Who's this?\nAI: It's Victor from Lucky Seven.`,
  // one LONG turn from a real human — the deliberate cost of the monologue rule,
  // pinned at 19 words so the threshold is exercised from below
  nineteenWordHuman: `${OPENER}\nUser: Look mate I am driving right now and I cannot talk so just send me whatever it is thanks.\nAI: Will do.`,
  // a human who mentions their own voicemail — must not read as a machine
  humanMentionsVoicemail: `${OPENER}\nUser: Yeah I saw you rang.\nAI: Sorry about that.\nUser: All good, I never check my messages anyway, what's it about?`,
};

describe("robotTextedRule — which signal says the texted call was a machine", () => {
  it("classifier rule: the two incidents the classifier now knows", () => {
    expect(robotTextedRule(INCIDENTS.stayOnTheLine)).toBe("classifier");
    expect(robotTextedRule(INCIDENTS.callAssist)).toBe("classifier");
  });

  it("tripwire rule: phrases the classifier does NOT know — and the handover once it learns one", () => {
    // 2026-08-28: the ordinary-greeting sweep taught the classifier "can't take your
    // message" and "mailbox cannot receive". Their tripwire entries stay; reading first
    // as "classifier" is the designed handover (strongest signal first), not a dead wire.
    expect(robotTextedRule(INCIDENTS.cantTakeYourMessage)).toBe("classifier");
    expect(robotTextedRule(INCIDENTS.mailboxCannotReceive)).toBe("classifier");
    expect(robotTextedRule(INCIDENTS.operatorsBusy)).toBe("tripwire");
    expect(robotTextedRule(INCIDENTS.leaveAVoiceMessage)).toBe("tripwire");
  });

  it("monologue rule: a script nobody has seen still trips on shape alone", () => {
    expect(robotTextedRule(INCIDENTS.unknownScriptMonologue)).toBe("monologue");
  });

  it("stays silent on every texted-human shape", () => {
    for (const [name, t] of Object.entries(HUMANS)) {
      expect(robotTextedRule(t), name).toBeNull();
    }
  });

  it("the monologue threshold is exact: 19 words is a human, 20 is a flag", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    expect(robotTextedRule(`${OPENER}\nUser: ${words(ROBOT_TEXTED_MONOLOGUE_WORDS - 1)}`)).toBeNull();
    expect(robotTextedRule(`${OPENER}\nUser: ${words(ROBOT_TEXTED_MONOLOGUE_WORDS)}`)).toBe("monologue");
  });

  it("no transcript, blank transcript: nothing to judge, nothing fires", () => {
    expect(robotTextedRule("")).toBeNull();
    expect(robotTextedRule("   \n ")).toBeNull();
  });

  it("a very long transcript is capped, not scanned in full", () => {
    // 40k of human chatter with a tripwire phrase buried past the cap must NOT trip.
    const filler = `${OPENER}\nUser: ok.\n`.repeat(2000);
    expect(filler.length).toBeGreaterThan(32_000);
    expect(robotTextedRule(filler + "User: this mailbox cannot receive messages")).toBeNull();
  });
});

describe("detectRobotTexted — the sweep-facing predicate", () => {
  it("lists every offender with its rule and a masked excerpt of what the machine said", () => {
    const r = detectRobotTexted([
      cand({ smsId: "a", transcript: INCIDENTS.cantTakeYourMessage }),
      cand({ smsId: "b", transcript: INCIDENTS.mailboxCannotReceive }),
      cand({ smsId: "c" }), // human
    ]);
    expect(r.trip).toBe(true);
    expect(r.offenders.map((o) => o.smsId)).toEqual(["a", "b"]);
    expect(r.offenders[0].rule).toBe("classifier"); // 2026-08-28: learnt by the classifier (see the robotTextedRule test above)
    expect(r.offenders[0].excerpt.startsWith("Hi. The person you have called is not available.")).toBe(true);
    expect(r.offenders[0].excerpt.length).toBeLessThanOrEqual(90);
  });

  it("masks digit runs in the excerpt (a read-back phone number never reaches Slack)", () => {
    const r = detectRobotTexted([cand({ transcript: `${OPENER}\nUser: You have reached 0412345678. This mailbox cannot receive messages.` })]);
    expect(r.offenders[0].excerpt).toContain("###");
    expect(r.offenders[0].excerpt).not.toMatch(/\d{3,}/);
  });

  it("exempts the modes that text voicemail ON PURPOSE (missed-call follow-up is policy)", () => {
    for (const mode of ["registered_optin", "optin_any_pickup"]) {
      const r = detectRobotTexted([cand({ mode, transcript: INCIDENTS.stayOnTheLine })]);
      expect(r.trip, mode).toBe(false);
    }
  });

  it("a NULL / unknown mode is checked, not skipped (it resolves to verbal_yes)", () => {
    expect(detectRobotTexted([cand({ mode: null, transcript: INCIDENTS.callAssist })]).trip).toBe(true);
    expect(detectRobotTexted([cand({ mode: "not-a-mode", transcript: INCIDENTS.callAssist })]).trip).toBe(true);
  });

  it("no candidates, or only humans: no trip, empty list", () => {
    expect(detectRobotTexted([])).toEqual({ trip: false, offenders: [] });
    expect(detectRobotTexted([cand(), cand({ transcript: HUMANS.oneShortTurn })])).toEqual({ trip: false, offenders: [] });
  });
});
