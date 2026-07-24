import { describe, it, expect } from "vitest";
import { vapiCallIdFromRecordingUrl, normalizeVapiCallId, pickPlayableUrl } from "./recordingProxy";

// Real stored shapes from calls_v2.recording_url (verified 2519/2519 rows carry the
// Vapi call id as the filename's leading UUID — probe 2026-07-17):
const OLD_HOST =
  "https://storage.vapi.ai/019f6009-9281-7bb4-ab97-8216c4ae4a17-1784022684716-a79a22f5-3302-4273-aea8-417069560f52-mono.wav";
const NEW_HOST =
  "https://94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/hipaa-recordings/019f6f9d-b49f-7775-accd-4150968ca909-1784284043732-ebc59e10-ad0d-4420-b10a-11e912d52fa4-mono.wav";

describe("vapiCallIdFromRecordingUrl", () => {
  it("extracts the call id from a legacy storage.vapi.ai URL", () => {
    expect(vapiCallIdFromRecordingUrl(OLD_HOST)).toBe("019f6009-9281-7bb4-ab97-8216c4ae4a17");
  });

  it("extracts the call id from a private R2 URL (post 2026-07-16 storage migration)", () => {
    expect(vapiCallIdFromRecordingUrl(NEW_HOST)).toBe("019f6f9d-b49f-7775-accd-4150968ca909");
  });

  it("lowercases an uppercase UUID", () => {
    expect(
      vapiCallIdFromRecordingUrl("https://x.example/019F6009-9281-7BB4-AB97-8216C4AE4A17-rest.mp3"),
    ).toBe("019f6009-9281-7bb4-ab97-8216c4ae4a17");
  });

  it("returns null when the filename does not start with a UUID", () => {
    expect(vapiCallIdFromRecordingUrl("https://storage.vapi.ai/not-a-uuid.mp3")).toBeNull();
  });

  it("returns null for non-strings, non-URLs and empty strings", () => {
    expect(vapiCallIdFromRecordingUrl(null)).toBeNull();
    expect(vapiCallIdFromRecordingUrl(undefined)).toBeNull();
    expect(vapiCallIdFromRecordingUrl(42)).toBeNull();
    expect(vapiCallIdFromRecordingUrl("")).toBeNull();
    expect(vapiCallIdFromRecordingUrl("not a url at all")).toBeNull();
  });
});

describe("normalizeVapiCallId", () => {
  it("accepts a bare full UUID and lowercases it", () => {
    expect(normalizeVapiCallId("019f9457-ca85-7bb4-8245-82724736afed")).toBe("019f9457-ca85-7bb4-8245-82724736afed");
    expect(normalizeVapiCallId("019F9457-CA85-7BB4-8245-82724736AFED")).toBe("019f9457-ca85-7bb4-8245-82724736afed");
  });

  it("rejects partial UUIDs, extra chars, URLs, and non-strings", () => {
    expect(normalizeVapiCallId("019f9457-ca85-7bb4-8245-82724736afed-extra")).toBeNull(); // must be the WHOLE string
    expect(normalizeVapiCallId("019f9457")).toBeNull();
    expect(normalizeVapiCallId("https://x/019f9457-ca85-7bb4-8245-82724736afed.wav")).toBeNull();
    expect(normalizeVapiCallId("")).toBeNull();
    expect(normalizeVapiCallId(null)).toBeNull();
    expect(normalizeVapiCallId(42)).toBeNull();
  });
});

describe("pickPlayableUrl", () => {
  const PRESIGNED = "https://hipaa-recordings.acct.r2.cloudflarestorage.com/x-mono.wav?X-Amz-Signature=abc";

  it("prefers presignedMonoUrl over everything else", () => {
    const artifact = {
      presignedMonoUrl: PRESIGNED,
      presignedStereoUrl: "https://x.example/stereo.wav?sig",
      recording: { mono: { combinedUrl: "https://x.example/raw-mono.wav" } },
      recordingUrl: "https://x.example/raw.wav",
    };
    expect(pickPlayableUrl(artifact)).toBe(PRESIGNED);
  });

  it("falls back presignedStereoUrl → recording.mono.combinedUrl → recordingUrl", () => {
    expect(pickPlayableUrl({ presignedStereoUrl: "https://x.example/s.wav" })).toBe("https://x.example/s.wav");
    expect(pickPlayableUrl({ recording: { mono: { combinedUrl: "https://x.example/c.wav" } } })).toBe(
      "https://x.example/c.wav",
    );
    expect(pickPlayableUrl({ recordingUrl: "https://x.example/r.wav" })).toBe("https://x.example/r.wav");
  });

  it("ignores non-https candidates and returns null when nothing playable", () => {
    expect(pickPlayableUrl({ presignedMonoUrl: "http://insecure.example/a.wav", recordingUrl: 7 })).toBeNull();
    expect(pickPlayableUrl({})).toBeNull();
    expect(pickPlayableUrl(null)).toBeNull();
    expect(pickPlayableUrl(undefined)).toBeNull();
    expect(pickPlayableUrl("nonsense")).toBeNull();
  });
});
