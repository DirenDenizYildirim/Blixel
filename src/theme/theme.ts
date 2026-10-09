// Themes are colour tokens only: each one becomes a CSS variable on :root.
// The themes themselves come from mods (the six standard ones from the
// built-in "builtin.themes"); Slate is also compiled in here, so the app
// always has a theme even before or without any mod.

import { APP_NAME } from "../brand";
import type { ThemeTokens } from "../mods/types";

/** A theme's full id, `<mod id>:<theme id>`, such as "builtin.themes:slate". */
export type ThemeId = string;

export interface AppliedTheme {
  id: ThemeId;
  light: boolean;
  tokens: ThemeTokens;
}

export const FALLBACK_THEME_ID: ThemeId = "builtin.themes:slate";

/** Slate, the default, kept in the code so a broken or missing mod never leaves the app uncoloured. */
export const FALLBACK_THEME: AppliedTheme = {
  id: FALLBACK_THEME_ID,
  light: false,
  tokens: {
    bg: "#282c34",
    side: "#111111",
    card: "#131519",
    code: "#1e2228",
    sel: "#1d2127",
    line: "#2c3640",
    border: "#355a66",
    fg: "#9cdef2",
    strong: "#c4eefb",
    muted: "#7fa3ae",
    com: "#8b93a1",
    accent: "#e06c75",
    accentInk: "#111111",
    dangerBg: "#2a1c21",
    dangerLine: "#7a4a52",
    dangerFg: "#f0959c",
    kw: "#c678dd",
    str: "#e5c07b",
    type: "#56b6c2",
    fn: "#61afef",
    ok: "#7fd99a",
    warn: "#e5c07b",
    avL: 0.8,
    avC: 0.13,
    flagInk: "#111111",
  },
};

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

let applied: AppliedTheme | null = null;
const listeners = new Set<(theme: AppliedTheme) => void>();

/** Sets every token as a CSS variable. Tokens are checked by the mod validator before they get here. */
export function applyTheme(theme: AppliedTheme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty("--" + kebab(key), String(value));
  }
  root.style.colorScheme = theme.light ? "light" : "dark";
  root.dataset.theme = theme.id;
  applied = theme;
  listeners.forEach((fn) => fn(theme));
}

/** Called after every theme change, including new tokens for the same theme (a dev mod reloaded). */
export function onThemeChange(listener: (theme: AppliedTheme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The theme on screen now, for code that hands the tokens on (such as mods' views). */
export function currentTheme(): AppliedTheme {
  return applied ?? FALLBACK_THEME;
}

/** Reads the live value of a theme token, for code that cannot use CSS variables. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim();
}

/** An agent's colour: its hue at the theme's avatar lightness and chroma. */
export function agentColor(hue: number): string {
  return `oklch(var(--av-l) var(--av-c) ${hue.toFixed(1)})`;
}

/** The agent's colour mixed into transparent, for tints behind lines and chips. */
export function agentTint(hue: number, percent: number): string {
  return `color-mix(in oklch, ${agentColor(hue)} ${percent}%, transparent)`;
}

// The chosen theme is remembered in the web view's local storage; without it
// the app starts in Slate.
const KEY = `${APP_NAME}.theme`;

export function savedThemeId(): ThemeId {
  try {
    return localStorage.getItem(KEY) || FALLBACK_THEME_ID;
  } catch {
    return FALLBACK_THEME_ID;
  }
}

export function saveThemeId(id: ThemeId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not remembered; the app still works.
  }
}
