// src/lib/qaTranscript.ts
//
// Prefix each spoken line of a call transcript with "Message N: " so the QA prompt can
// reference specific turns by number ("in Message 3 the customer…") instead of describing
// them in prose. The SAME numbering is applied to the transcript the model scores and to
// the transcript shown in the UI, so a reviewer's "Message N" matches what the model sees.
// Numbering counts non-empty lines in order (blank lines are preserved but not counted).

export function numberTranscript(text: string): string {
  if (!text) return text;
  let n = 0;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      n += 1;
      return `Message ${n}: ${t}`;
    })
    .join("\n");
}
