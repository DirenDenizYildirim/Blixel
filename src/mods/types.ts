// Mods: folders of community work that add themes, rules for agents, layouts,
// commands and views. This file is the shared vocabulary for the manifest
// (`mod.json`), the core's records and the sandboxed runtime. The format
// carries no product name, so a rename never breaks a mod.

import type { Column } from "../layout/types";

/** The mod API's major version this build runs. A mod declaring another is refused. */
export const API_MAJOR = 1;
/** Additions within the major version, reported to mods as `host.api.minor`. */
export const API_MINOR = 0;

/**
 * What a code mod may do beyond drawing its own views and commands. Declared in
 * the manifest, shown to the user, and granted only when the user enables the
 * mod; asking for a new one later needs approval again.
 * - `files:read`: list and read files of the open project, know the active file.
 * - `agents:read`: each agent's id, name, colour, status and current file (not chats).
 * Nothing lets a mod answer a permission request, change an agent's settings,
 * see keys, type into the message box or send messages.
 */
export type Capability = "files:read" | "agents:read";
export const CAPABILITIES: Record<Capability, string> = {
  "files:read": "Read the files of the open project",
  "agents:read": "See your agents' names, status and the file each one is in",
};

/** Every colour token a theme sets; all are required. */
export const THEME_TOKENS = [
  "bg", "side", "card", "code", "sel", "line", "border", "fg", "strong", "muted", "com",
  "accent", "accentInk", "dangerBg", "dangerLine", "dangerFg", "kw", "str", "type", "fn",
  "ok", "warn", "flagInk",
] as const;
/** Avatar lightness (0..1) and chroma (0..0.4) for agent colours, as numbers. */
export const THEME_NUMBERS = ["avL", "avC"] as const;
export type ThemeTokens = Record<(typeof THEME_TOKENS)[number], string> & Record<(typeof THEME_NUMBERS)[number], number>;

export interface ThemeContribution {
  id: string;
  label: string;
  light: boolean;
  /** Colours as #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla() or oklch(); nothing else (no url()). */
  tokens: ThemeTokens;
}

/**
 * Rules a user can attach to an agent. The edit area and protected paths only
 * narrow what it may do; the instructions are text its model reads, as
 * third-party guidance below the user's own, so the user reads them first.
 */
export interface RulePackContribution {
  id: string;
  label: string;
  description?: string;
  /** Given to the agent's model as third-party guidance, below the user's own instructions. */
  instructions?: string;
  /** .gitignore-style patterns; the agent may edit only where its own area AND every attached pack's area allow. */
  editArea?: string;
  /** .gitignore-style patterns whose edits always ask the user first. */
  protect?: string[];
}

export interface LayoutContribution {
  id: string;
  label: string;
  columns: Column[];
}

export interface CommandContribution {
  /** Local to the mod; the full id is `mod:<mod id>:<id>`. */
  id: string;
  title: string;
  /** Default key, like "Ctrl+Alt+O". Built-in keys win over a mod's. */
  key?: string;
}

export interface ViewContribution {
  /** Local to the mod; the view id is `mod:<mod id>:<id>`. */
  id: string;
  title: string;
  /** The mod's HTML file drawn in the view, relative to its folder. */
  entry: string;
  minWidth?: number;
}

/**
 * A small picture drawn in pixels, shown on the Mods page. Each row is a
 * string of colour keys, one character per pixel; "." or a space is empty.
 */
export interface PixelIcon {
  /** 8 to 32 rows, all the same length (8 to 32); 16 by 16 is the usual size. */
  pixels: string[];
  /** The colour of each key used in `pixels`, as #rgb, #rrggbb or #rrggbbaa; at most 16. */
  colors: Record<string, string>;
}

export interface Manifest {
  /** "author.name", lower case letters, digits, "-" and one ".", equal to the folder name. */
  id: string;
  name: string;
  /** Semver, e.g. "1.2.0". */
  version: string;
  /** The major API version it targets; must equal API_MAJOR. */
  api: number;
  author?: string;
  description?: string;
  /** Its picture on the Mods page; without one, the app draws one for what the mod adds. */
  icon?: PixelIcon;
  /** Code that runs sandboxed in a worker, relative to the folder. Absent for declarative mods. */
  main?: string;
  permissions?: Capability[];
  contributes?: {
    themes?: ThemeContribution[];
    rulePacks?: RulePackContribution[];
    layouts?: LayoutContribution[];
    commands?: CommandContribution[];
    views?: ViewContribution[];
  };
}

/** One installed mod as the core reports it. */
export interface ModRecord {
  id: string;
  /** Where its files are: the mods folder, or the author's own folder for a dev mod. */
  dir: string;
  /** Loaded in place from the author's folder; its files may change without re-approval. */
  dev: boolean;
  enabled: boolean;
  /** Capabilities the user granted when enabling it. */
  granted: Capability[];
  /** The manifest as read from disk, or null if it could not be read. */
  manifest: Manifest | null;
  /** Why it cannot run (bad manifest, wrong API version...), or null. */
  error: string | null;
  /** Its files changed since the user approved it, so it stays off until approved again. */
  changed: boolean;
  /** Built into the app; cannot be removed. */
  builtin?: boolean;
}

/** What the core reports about mods at start. */
export interface ModsState {
  mods: ModRecord[];
  /** Started with --no-mods: none run this session. */
  disabledByFlag: boolean;
  /** The last session ended uncleanly while mods ran: offer to start without them. */
  safeStartSuggested: boolean;
}

// ---- Messages between the host page and a mod's frames ----

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** From a mod frame to the host: a call to the host API. */
export interface CallMessage {
  t: "call";
  id: number;
  method: string;
  params: Json[];
}
/** From the host to a mod frame: the answer to a call. */
export interface ResultMessage {
  t: "result";
  id: number;
  ok: boolean;
  value?: Json;
  error?: string;
}
/** Either way: something happened (host to mod), or a view posts to its logic (mod to host). */
export interface EventMessage {
  t: "event";
  name: string;
  data: Json;
}
/** Host to mod: are you still running? Mod to host: yes. */
export interface PingMessage {
  t: "ping" | "pong";
  n: number;
}
export type ModMessage = CallMessage | ResultMessage | EventMessage | PingMessage;

/** Largest message either way, in bytes of JSON. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
