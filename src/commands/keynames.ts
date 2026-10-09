// Key strings like "Ctrl+Shift+P": parsing what commands declare, naming a
// key press the same way, and showing a key to the user. "Ctrl" means Cmd on
// macOS, so one key string works on every system.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Modifiers in the order a normalized key string lists them. "Meta" is the key "Ctrl" does not mean on this system. */
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;

const NAMED: Record<string, string> = {
  esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  plus: "+",
};

/** One key name: a single character (letters upper case), F1..F24, or a named key. Null if unknown. */
function keyName(raw: string): string | null {
  if (raw.length === 1) return raw === " " ? "Space" : raw.toUpperCase();
  const lower = raw.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  return f ? `F${f[1]}` : null;
}

/**
 * The normalized form of a declared key, such as "shift+ctrl+p" to
 * "Ctrl+Shift+P"; null if it is not a key. "Cmd" is read as "Ctrl".
 */
export function normalizeKey(text: string): string | null {
  // "Ctrl++" names the plus key itself.
  const trimmed = text.trim();
  const plusKey = trimmed === "+" || trimmed.endsWith("++");
  const parts = plusKey ? [...(trimmed.length > 1 ? trimmed.slice(0, -2).split("+") : []), "+"] : trimmed.split("+");
  if (parts.some((p) => p === "")) return null;
  const mods = new Set<string>();
  let key: string | null = null;
  for (const [i, part] of parts.entries()) {
    const lower = part.toLowerCase();
    const mod =
      lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "mod" ? "Ctrl"
      : lower === "alt" || lower === "option" ? "Alt"
      : lower === "shift" ? "Shift"
      : lower === "meta" || lower === "super" ? "Meta"
      : null;
    if (mod && i < parts.length - 1) {
      if (mods.has(mod)) return null;
      mods.add(mod);
      continue;
    }
    if (i !== parts.length - 1) return null;
    key = keyName(part);
  }
  if (!key) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

/**
 * Names a key press like a declared key, or null for a bare modifier.
 * Letters and digits are read from the physical key when the layout gives
 * something else (Alt on macOS, AZERTY digits, non-Latin letters).
 */
export function eventKey(e: KeyboardEvent): string | null {
  if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta" || e.key === "OS") return null;
  let key: string | null = null;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (digit) key = digit[1];
  else if (letter) key = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : letter[1];
  else key = keyName(e.key);
  if (!key) return null;
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  const meta = isMac ? e.ctrlKey : e.metaKey;
  const mods = { Ctrl: ctrl, Alt: e.altKey, Shift: e.shiftKey, Meta: meta };
  return [...MODIFIERS.filter((m) => mods[m]), key].join("+");
}

/** A normalized key as the user's system writes it: "Cmd+Shift+P" on macOS. */
export function formatKey(key: string): string {
  if (!isMac) return key;
  return key
    .split("+")
    .map((p, i, all) => (i === all.length - 1 ? p : p === "Ctrl" ? "Cmd" : p === "Alt" ? "Option" : p === "Meta" ? "Ctrl" : p))
    .join("+");
}
