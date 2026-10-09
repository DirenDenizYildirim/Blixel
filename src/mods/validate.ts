// Checks a mod's manifest before anything in it is used. The result is a
// clean copy holding only known fields, or a readable reason the mod cannot
// run. Theme colours are checked strictly: they become CSS variables, so
// anything beyond a plain colour (url(), var(), extra text) could load files
// or break the page. Texts people (or an agent's model) read are checked too:
// short where they name things, and free of characters that do not show or
// that reorder text, which could make them read differently than they are.

import { APP_NAME } from "../brand";
import { normalizeKey } from "../commands/keynames";
import type { Column, Slot } from "../layout/types";
import {
  API_MAJOR,
  CAPABILITIES,
  THEME_NUMBERS,
  THEME_TOKENS,
  type Capability,
  type CommandContribution,
  type LayoutContribution,
  type Manifest,
  type PixelIcon,
  type RulePackContribution,
  type ThemeContribution,
  type ThemeTokens,
  type ViewContribution,
} from "./types";

export const MOD_ID = /^[a-z0-9-]+\.[a-z0-9-]+$/;
/** Ids of things inside a mod (themes, commands, views...). They end up in ids like `mod:<mod>:<id>`, so no ":". */
const LOCAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VIEW_ID = /^(?:chat|editor|shell|mod:[a-z0-9-]+\.[a-z0-9-]+:[A-Za-z0-9_-]{1,64})$/;

const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const ARG = `${NUM}(?:%|deg)?`;
const COMMAS = String.raw`${ARG}\s*,\s*${ARG}\s*,\s*${ARG}(?:\s*,\s*${ARG})?`;
const SPACES = String.raw`${ARG}\s+${ARG}\s+${ARG}(?:\s*\/\s*${ARG})?`;
const COLOUR_FN = new RegExp(String.raw`^(?:rgba?|hsla?|oklch)\(\s*(?:${COMMAS}|${SPACES})\s*\)$`, "i");
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Plain colours only: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla(), oklch() with numbers and percentages. */
export const isColour = (value: unknown): value is string =>
  typeof value === "string" && (HEX.test(value) || COLOUR_FN.test(value));

const NUMBER_RANGES: Record<(typeof THEME_NUMBERS)[number], [number, number]> = {
  avL: [0, 1],
  avC: [0, 0.4],
};

/** Longest mod name, and longest title or label of something a mod adds (commands, views, themes, layouts, rule packs). */
export const MAX_NAME = 40;
export const MAX_TITLE = 60;
const MAX_PACK_DESCRIPTION = 300;

/**
 * Characters that do not show, or that change how the text around them
 * reads: controls (tab and line break are handled apart), zero-width and
 * direction marks, bidirectional embeddings, overrides and isolates, line and
 * paragraph separators, invisible operators, the byte order mark, interlinear
 * annotations and tag characters.
 */
const HIDDEN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;

/** The first hidden character in a text (tabs and line breaks too, unless `multiline`), as "U+202E", or null. */
export function hiddenCharacter(text: string, multiline = false): string | null {
  const found = HIDDEN.exec(text) ?? (multiline ? null : /[\t\n]/.exec(text));
  return found ? `U+${found[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` : null;
}

/** Characters as people count them, not UTF-16 units. */
const length = (text: string) => [...text].length;

/** Whether a name is the app's own (ignoring case, width and spaces around it). */
export const isAppName = (name: string) => name.normalize("NFKC").trim().toLowerCase() === APP_NAME.toLowerCase();

export type Checked = { ok: true; manifest: Manifest } | { ok: false; error: string };

/** A problem in the manifest; the message says where. */
class Invalid extends Error {}
function fail(message: string): never {
  throw new Invalid(message);
}
/** "contributes.themes[0]." to "contributes.themes[0]", for messages about the whole entry. */
const entry = (where: string) => where.replace(/\.$/, "");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown) => (typeof v === "string" ? `"${v.length > 40 ? v.slice(0, 40) + "…" : v}"` : JSON.stringify(v) ?? String(v));

function str(o: Obj, key: string, where: string, required: true): string;
function str(o: Obj, key: string, where: string, required?: false): string | undefined;
function str(o: Obj, key: string, where: string, required = false): string | undefined {
  const v = o[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || (required && !v.trim())) fail(`${where}${key} must be ${required ? "a non-empty" : "a"} text.`);
  return v as string;
}

interface TextRules {
  required?: boolean;
  /** At most this many characters. */
  max?: number;
  /** Tabs and line breaks allowed. */
  multiline?: boolean;
}

/** A text people read: no hidden characters, and within its length. */
function readable(o: Obj, key: string, where: string, rules: TextRules & { required: true }): string;
function readable(o: Obj, key: string, where: string, rules: TextRules): string | undefined;
function readable(o: Obj, key: string, where: string, rules: TextRules): string | undefined {
  const v = rules.required ? str(o, key, where, true) : str(o, key, where);
  if (v === undefined) return undefined;
  checkText(v, `${where}${key}`, rules);
  return v;
}

function checkText(v: string, what: string, rules: TextRules) {
  const hidden = hiddenCharacter(v, rules.multiline);
  if (hidden) {
    const kind = hidden === "U+0009" || hidden === "U+000A" ? "a tab or line break" : `a character that does not show or that reorders text (${hidden})`;
    fail(`${what} has ${kind}; remove it.`);
  }
  if (rules.max !== undefined && length(v) > rules.max) fail(`${what} must be at most ${rules.max} characters.`);
}

function list(o: Obj, key: string, where: string): unknown[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${where}${key} must be a list.`);
  return v as unknown[];
}

function localId(o: Obj, where: string, seen: Set<string>): string {
  const id = o.id;
  if (typeof id !== "string" || !LOCAL_ID.test(id)) {
    fail(`${where}id ${show(id)} must be letters, digits, "-" or "_".`);
  }
  if (seen.has(id as string)) fail(`${where}id "${id}" is used twice.`);
  seen.add(id as string);
  return id as string;
}

/** A path inside the mod's folder: relative, "/" separated, never leaving the folder. */
function relativePath(v: unknown, where: string): string {
  if (typeof v !== "string" || !v.trim()) return fail(`${where} must be a path inside the mod's folder.`);
  const bad =
    v.startsWith("/") || v.includes("\\") || v.includes(":") || v.includes("\0") ||
    v.split("/").some((part) => part === ".." || part === "");
  if (bad) fail(`${where} ${show(v)} must be a relative path inside the mod's folder, with "/" and no "..".`);
  return v;
}

/** A pixel picture: rows of equal length, each character a key with a plain hex colour. */
function icon(raw: unknown): PixelIcon {
  if (!isObj(raw)) return fail("icon must be an object with pixels and colors.");
  const colors = raw.colors;
  if (!isObj(colors)) return fail("icon.colors must map each key to a colour.");
  const keys = Object.keys(colors);
  if (keys.length > 16) fail("icon.colors may hold at most 16 colours.");
  for (const key of keys) {
    if ([...key].length !== 1 || key === "." || key === " ") fail(`icon.colors key ${show(key)} must be one character other than "." or a space.`);
    if (typeof colors[key] !== "string" || !HEX.test(colors[key] as string)) {
      fail(`icon.colors.${key} ${show(colors[key])} must be a colour like "#e06c75".`);
    }
  }
  const pixels = raw.pixels;
  if (!Array.isArray(pixels) || pixels.length < 8 || pixels.length > 32) fail("icon.pixels must hold 8 to 32 rows.");
  const rows = pixels as unknown[];
  const width = typeof rows[0] === "string" ? [...rows[0]].length : 0;
  if (width < 8 || width > 32) fail("icon.pixels rows must be 8 to 32 pixels long.");
  rows.forEach((row, i) => {
    if (typeof row !== "string" || [...row].length !== width) fail(`icon.pixels row ${i + 1} must be ${width} pixels long, like the first.`);
    for (const ch of row as string) {
      if (ch !== "." && ch !== " " && !(ch in colors)) fail(`icon.pixels row ${i + 1} uses ${show(ch)}, which has no colour in icon.colors.`);
    }
  });
  return { pixels: rows as string[], colors: colors as Record<string, string> };
}

function theme(raw: unknown, where: string, seen: Set<string>): ThemeContribution {
  if (!isObj(raw)) return fail(`${entry(where)} must be an object.`);
  const id = localId(raw, where, seen);
  const label = readable(raw, "label", where, { required: true, max: MAX_TITLE });
  if (typeof raw.light !== "boolean") fail(`${where}light must be true or false.`);
  const tokens = raw.tokens;
  if (!isObj(tokens)) return fail(`${where}tokens must be an object.`);
  const known = new Set<string>([...THEME_TOKENS, ...THEME_NUMBERS]);
  for (const key of Object.keys(tokens)) {
    if (!known.has(key)) fail(`${where}tokens has an unknown token "${key}".`);
  }
  const out: Record<string, string | number> = {};
  for (const key of THEME_TOKENS) {
    const value = tokens[key];
    if (value === undefined) fail(`${where}tokens is missing "${key}".`);
    if (!isColour(value)) {
      fail(`${where}tokens.${key} ${show(value)} is not a plain colour (#rrggbb, rgb(), hsl() or oklch()).`);
    }
    out[key] = value as string;
  }
  for (const key of THEME_NUMBERS) {
    const value = tokens[key];
    const [min, max] = NUMBER_RANGES[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      fail(`${where}tokens.${key} must be a number from ${min} to ${max}.`);
    }
    out[key] = value as number;
  }
  return { id, label, light: raw.light as boolean, tokens: out as ThemeTokens };
}

function rulePack(raw: unknown, where: string, seen: Set<string>): RulePackContribution {
  if (!isObj(raw)) return fail(`${entry(where)} must be an object.`);
  // The user reads all of it before attaching, and the instructions go to the
  // agent's model as they are: what the user reads must be what the model gets.
  const pack: RulePackContribution = {
    id: localId(raw, where, seen),
    label: readable(raw, "label", where, { required: true, max: MAX_TITLE }),
  };
  const description = readable(raw, "description", where, { max: MAX_PACK_DESCRIPTION });
  const instructions = readable(raw, "instructions", where, { multiline: true });
  const editArea = readable(raw, "editArea", where, { multiline: true });
  if (description !== undefined) pack.description = description;
  if (instructions !== undefined) pack.instructions = instructions;
  if (editArea !== undefined) pack.editArea = editArea;
  if (raw.protect !== undefined) {
    const protect = list(raw, "protect", where);
    if (protect.some((p) => typeof p !== "string")) fail(`${where}protect must be a list of texts.`);
    protect.forEach((p, i) => checkText(p as string, `${where}protect[${i}]`, {}));
    pack.protect = protect as string[];
  }
  return pack;
}

const size = (v: unknown) => v === "fill" || (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10000);

/** Columns as the layout keeps them: one "fill" column, and one "fill" slot in each column. */
export function columns(raw: unknown, where: string): Column[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail(`${where}columns must be a non-empty list.`);
  const ids = new Set<string>();
  const out = raw.map((c, i): Column => {
    const at = `${where}columns[${i}].`;
    if (!isObj(c)) return fail(`${entry(at)} must be an object.`);
    if (typeof c.id !== "string" || !c.id || ids.has(c.id)) fail(`${at}id must be a text used once.`);
    ids.add(c.id as string);
    if (!size(c.width)) fail(`${at}width must be a number of pixels or "fill".`);
    const slots = c.slots;
    if (!Array.isArray(slots) || slots.length === 0) return fail(`${at}slots must be a non-empty list.`);
    const outSlots = slots.map((s, j): Slot => {
      const sat = `${at}slots[${j}].`;
      if (!isObj(s)) return fail(`${entry(sat)} must be an object.`);
      if (typeof s.view !== "string" || !VIEW_ID.test(s.view)) {
        fail(`${sat}view ${show(s.view)} must be "chat", "editor", "shell" or "mod:<mod id>:<view id>".`);
      }
      if (typeof s.open !== "boolean") fail(`${sat}open must be true or false.`);
      if (!size(s.height)) fail(`${sat}height must be a number of pixels or "fill".`);
      return { view: s.view as Slot["view"], open: s.open as boolean, height: s.height as Slot["height"] };
    });
    if (outSlots.filter((s) => s.height === "fill").length !== 1) fail(`${at}slots must have exactly one "fill" height.`);
    return { id: c.id as string, width: c.width as Column["width"], slots: outSlots };
  });
  if (out.filter((c) => c.width === "fill").length !== 1) fail(`${where}columns must have exactly one "fill" width.`);
  return out;
}

function layout(raw: unknown, where: string, seen: Set<string>): LayoutContribution {
  if (!isObj(raw)) return fail(`${entry(where)} must be an object.`);
  return {
    id: localId(raw, where, seen),
    label: readable(raw, "label", where, { required: true, max: MAX_TITLE }),
    columns: columns(raw.columns, where),
  };
}

function command(raw: unknown, where: string, seen: Set<string>): CommandContribution {
  if (!isObj(raw)) return fail(`${entry(where)} must be an object.`);
  const out: CommandContribution = {
    id: localId(raw, where, seen),
    title: readable(raw, "title", where, { required: true, max: MAX_TITLE }),
  };
  const key = str(raw, "key", where);
  if (key !== undefined) {
    const normal = normalizeKey(key);
    if (!normal) fail(`${where}key ${show(key)} is not a key; write it like "Ctrl+Alt+O".`);
    out.key = normal as string;
  }
  return out;
}

function view(raw: unknown, where: string, seen: Set<string>): ViewContribution {
  if (!isObj(raw)) return fail(`${entry(where)} must be an object.`);
  const out: ViewContribution = {
    id: localId(raw, where, seen),
    title: readable(raw, "title", where, { required: true, max: MAX_TITLE }),
    entry: relativePath(raw.entry, `${where}entry`),
  };
  if (raw.minWidth !== undefined) {
    const w = raw.minWidth;
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 4000) fail(`${where}minWidth must be a number of pixels.`);
    out.minWidth = w as number;
  }
  return out;
}

function contributions<T>(
  o: Obj,
  key: string,
  check: (raw: unknown, where: string, seen: Set<string>) => T,
): T[] | undefined {
  if (o[key] === undefined) return undefined;
  const seen = new Set<string>();
  return list(o, key, "contributes.").map((raw, i) => check(raw, `contributes.${key}[${i}].`, seen));
}

function check(raw: unknown, options: { builtin: boolean }): Manifest {
  if (!isObj(raw)) return fail("mod.json must hold an object.");
  const id = raw.id;
  if (typeof id !== "string" || !MOD_ID.test(id)) {
    fail(`id ${show(id)} must be "author.name": lower case letters, digits and "-", with one ".".`);
  }
  if (!options.builtin && (id as string).startsWith("builtin.")) fail(`ids starting with "builtin." are kept for the app's own mods.`);
  if (raw.api !== API_MAJOR) {
    fail(
      typeof raw.api === "number"
        ? `It is made for mod API ${raw.api}; this version runs mod API ${API_MAJOR}.`
        : `api must be the mod API version it is made for (${API_MAJOR}).`,
    );
  }
  const manifest: Manifest = {
    id: id as string,
    name: readable(raw, "name", "", { required: true, max: MAX_NAME }),
    version: str(raw, "version", "", true),
    api: API_MAJOR,
  };
  // The name appears beside everything the mod adds; the app's own would pass it off as the app.
  if (!options.builtin && isAppName(manifest.name)) fail(`name may not be "${APP_NAME}", the app's own name.`);
  if (!SEMVER.test(manifest.version)) fail(`version ${show(manifest.version)} must look like "1.2.0".`);
  const author = readable(raw, "author", "", {});
  const description = readable(raw, "description", "", { multiline: true });
  if (author !== undefined) manifest.author = author;
  if (description !== undefined) manifest.description = description;
  if (raw.main !== undefined) manifest.main = relativePath(raw.main, "main");
  if (raw.icon !== undefined) manifest.icon = icon(raw.icon);

  if (raw.permissions !== undefined) {
    const permissions = list(raw, "permissions", "");
    for (const p of permissions) {
      if (typeof p !== "string" || !(p in CAPABILITIES)) {
        fail(`permissions has ${show(p)}, which is not one of ${Object.keys(CAPABILITIES).join(", ")}.`);
      }
    }
    manifest.permissions = [...new Set(permissions as Capability[])];
  }

  if (raw.contributes !== undefined) {
    const c = raw.contributes;
    if (!isObj(c)) return fail("contributes must be an object.");
    // Kinds this version does not know are left out, so a mod made for a later
    // minor version still loads what it can.
    const out: NonNullable<Manifest["contributes"]> = {};
    const themes = contributions(c, "themes", theme);
    const rulePacks = contributions(c, "rulePacks", rulePack);
    const layouts = contributions(c, "layouts", layout);
    const commands = contributions(c, "commands", command);
    const views = contributions(c, "views", view);
    if (themes) out.themes = themes;
    if (rulePacks) out.rulePacks = rulePacks;
    if (layouts) out.layouts = layouts;
    if (commands) out.commands = commands;
    if (views) out.views = views;
    manifest.contributes = out;
  }
  return manifest;
}

/** Checks a manifest as read from mod.json. Built-in mods may use the "builtin." id prefix. */
export function validateManifest(raw: unknown, options: { builtin?: boolean } = {}): Checked {
  try {
    return { ok: true, manifest: check(raw, { builtin: options.builtin ?? false }) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * The parts of a rejected manifest that are safe to show (name, version,
 * author, description), with nothing that could run or be applied. A text
 * that would fail the checks is left out (a name gives way to the id).
 */
export function displayOnly(raw: unknown, id: string): Manifest {
  const o = isObj(raw) ? raw : {};
  const text = (v: unknown, max: number, multiline = false) =>
    typeof v === "string" && v.trim() && length(v) <= max && !hiddenCharacter(v, multiline) ? v : undefined;
  const name = text(o.name, MAX_NAME);
  const out: Manifest = {
    id,
    name: name && !isAppName(name) ? name : id,
    version: text(o.version, 40) ?? "",
    api: typeof o.api === "number" ? o.api : 0,
  };
  const author = text(o.author, 200);
  const description = text(o.description, 2000, true);
  if (author) out.author = author;
  if (description) out.description = description;
  return out;
}
