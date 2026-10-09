// A short fingerprint of JSON content, to notice when a mod changes something
// the user approved (such as a rule pack attached to an agent). Not for security.

/** FNV-1a over the JSON text, as 8 hex digits. */
export function contentHash(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
