// The app's own settings: how the editor looks and behaves, and what a new
// agent starts with. Kept in the app scope of the core's database (in memory
// outside the desktop app). Every change applies at once; saving waits a
// moment so dragging a slider writes once, not on every step.

import { create } from "zustand";
import { storeGet, storeSet, type Json } from "./core-api";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type EditorSettings,
  type Effort,
  type NewAgentDefaults,
  type Permission,
  type ToolId,
} from "./types";

export const useSettings = create<AppSettings>(() => DEFAULT_APP_SETTINGS);

export const FONT_SIZES = { min: 12, max: 20 } as const;
export const TYPING_SPEEDS = { min: 2, max: 40 } as const;

/** The line height for a font size, keeping the 14 px / 22 px ratio of the designs. */
export const lineHeightFor = (fontSize: number) => Math.round((fontSize * 11) / 7);

const SAVE_DELAY = 400;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let unsaved = false;
/** Changes made before the saved settings arrived win over them. */
let touched = false;

/** Reads the saved settings. Call once at startup; until it resolves the defaults apply. */
export async function loadSettings(): Promise<void> {
  try {
    const saved = await storeGet<Json>("app", "settings");
    if (saved !== null && !touched) useSettings.setState(sanitize(saved), true);
  } catch (e) {
    console.error("Could not read the settings", e);
  }
}

/** A change to some settings; inside `editor` and `newAgent`, only the fields given change. */
export interface SettingsPatch {
  editor?: Partial<EditorSettings>;
  newAgent?: Partial<NewAgentDefaults>;
}

export function updateSettings(patch: SettingsPatch | Partial<AppSettings>): void {
  const now = useSettings.getState();
  const next = sanitize({
    ...now,
    editor: { ...now.editor, ...patch.editor },
    newAgent: { ...now.newAgent, ...patch.newAgent },
  } as unknown as Json);
  touched = true;
  // A part left alone keeps its object, so what follows only the editor's settings is not disturbed.
  useSettings.setState(
    { v: 1, editor: patch.editor ? next.editor : now.editor, newAgent: patch.newAgent ? next.newAgent : now.newAgent },
    true,
  );
  unsaved = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

export const updateEditor = (patch: Partial<EditorSettings>) => updateSettings({ editor: patch });
export const updateNewAgent = (patch: Partial<NewAgentDefaults>) => updateSettings({ newAgent: patch });

function flush() {
  clearTimeout(saveTimer);
  if (!unsaved) return;
  unsaved = false;
  storeSet("app", "settings", useSettings.getState() as unknown as Json).catch((e) =>
    console.error("Could not save the settings", e),
  );
}

// A change made just before the window closes is still written.
if (typeof window !== "undefined") window.addEventListener("pagehide", flush);

// ---- Reading saved values: anything missing, old or out of range falls back to the default ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const int = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

const PERMISSIONS: Permission[] = ["off", "ask", "allow"];
const TOOLS: ToolId[] = ["read", "edit", "run", "commit", "push"];
const EFFORTS: Effort[] = ["low", "medium", "high"];
const MAX_INSTRUCTIONS = 20_000;

function sanitize(raw: Json): AppSettings {
  const d = DEFAULT_APP_SETTINGS;
  const all = isObj(raw) ? raw : {};
  const e = isObj(all.editor) ? all.editor : {};
  const n = isObj(all.newAgent) ? all.newAgent : {};
  const p = isObj(n.permissions) ? n.permissions : {};
  return {
    v: 1,
    editor: {
      fontSize: int(e.fontSize, FONT_SIZES.min, FONT_SIZES.max, d.editor.fontSize),
      tabSize: oneOf(e.tabSize, [2, 4, 8] as const, d.editor.tabSize),
      indent: oneOf(e.indent, ["spaces", "tabs"] as const, d.editor.indent),
      wordWrap: bool(e.wordWrap, d.editor.wordWrap),
      lineNumbers: bool(e.lineNumbers, d.editor.lineNumbers),
      activeLine: bool(e.activeLine, d.editor.activeLine),
      ligatures: bool(e.ligatures, d.editor.ligatures),
      agentEdits: oneOf(e.agentEdits, ["typed", "instant"] as const, d.editor.agentEdits),
    },
    newAgent: {
      permissions: Object.fromEntries(
        TOOLS.map((t) => [t, oneOf(p[t], PERMISSIONS, d.newAgent.permissions[t])]),
      ) as Record<ToolId, Permission>,
      model: typeof n.model === "string" && n.model ? n.model : d.newAgent.model,
      effort: oneOf(n.effort, EFFORTS, d.newAgent.effort),
      typingSpeed: int(n.typingSpeed, TYPING_SPEEDS.min, TYPING_SPEEDS.max, d.newAgent.typingSpeed),
      whenIdle: oneOf(n.whenIdle, ["wait", "pick-up"] as const, d.newAgent.whenIdle),
      readNotes: bool(n.readNotes, d.newAgent.readNotes),
      instructions: typeof n.instructions === "string" ? n.instructions.slice(0, MAX_INSTRUCTIONS) : d.newAgent.instructions,
    },
  };
}
