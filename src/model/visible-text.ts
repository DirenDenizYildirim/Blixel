// Text from agents and connectors, made safe to show: characters that are
// invisible or reorder what is shown (bidirectional controls, zero-width
// marks, tag characters) are taken out, so what the user reads is what the
// text says. The core cleans them too; this catches anything that slips past.

/** Control, format and invisible filler characters; tab and newline are kept below. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

export function visibleText(text: string): string {
  return (
    text
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      .replace(HIDDEN, (c) => (c === "\n" || c === "\t" ? c : ""))
      // A long run of empty lines could push the rest of a request out of
      // sight, so it shows as one marked line.
      .replace(/\n(?:[ \t]*\n){3,}/g, (run) => `\n[${run.split("\n").length - 2} empty lines]\n`)
  );
}
