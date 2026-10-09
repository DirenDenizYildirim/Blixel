// The mods the app knows: the built-in ones, then those the core reports
// (installed and dev). Every manifest is checked here before anything in it
// is used, and the declarative parts of enabled mods (themes, rule packs,
// layouts) are offered from here. Code mods are started by the runtime, which
// asks runnableCodeMods() and reports failures back.

import { create } from "zustand";
import { setLayoutPresets } from "../layout/presets";
import type { LayoutPreset } from "../layout/types";
import { notify } from "../model/store";
import { BUILTIN_MODS } from "./builtin";
import { installMod, listMods, loadDevMod, setModEnabled, uninstallMod } from "./core";
import { contentHash } from "./hash";
import type { Capability, ModRecord, RulePackContribution, ThemeTokens } from "./types";
import { displayOnly, validateManifest } from "./validate";

export interface ModsStore {
  /** Built-in mods first, then installed and dev mods. */
  mods: ModRecord[];
  ready: boolean;
  disabledByFlag: boolean;
  safeStartSuggested: boolean;
  /** The user chose to start without mods this session: no code mod runs. */
  codeModsSuspended: boolean;
  /** Recent errors per mod id, newest last. */
  errors: Record<string, string[]>;
  /** Bumped to ask the runtime to restart a mod's code (e.g. "Reload" on a dev mod). */
  restarts: Record<string, number>;
}

// Built-in mods are compiled in, so their themes and layouts apply before the
// core has answered.
export const useMods = create<ModsStore>(() => ({
  mods: BUILTIN_MODS,
  ready: false,
  disabledByFlag: false,
  safeStartSuggested: false,
  codeModsSuspended: false,
  errors: {},
  restarts: {},
}));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether a mod's contributions apply: on, valid, and unchanged since the user approved it (dev mods may change). */
export function isActive(mod: ModRecord): boolean {
  return mod.enabled && !mod.error && mod.manifest !== null && (!mod.changed || mod.dev);
}

/** Checks a record from the core; a bad manifest keeps only what is safe to show, plus the reason. */
function checked(record: ModRecord): ModRecord {
  const base = { ...record, builtin: false };
  if (!record.manifest) return { ...base, error: record.error ?? "Its mod.json could not be read." };
  const result = validateManifest(record.manifest);
  if (!result.ok) return { ...base, manifest: displayOnly(record.manifest, record.id), error: record.error ?? result.error };
  if (result.manifest.id !== record.id) {
    return {
      ...base,
      manifest: displayOnly(record.manifest, record.id),
      error: record.error ?? `Its id "${result.manifest.id}" does not match its folder name "${record.id}".`,
    };
  }
  return { ...base, manifest: result.manifest };
}

const displayName = (m: ModRecord) => m.manifest?.name ?? m.id;

let loadSeq = 0;
let safeStartAnswered = false;
let safeStartNoticed = false;

/** Reads built-in mods and asks the core for installed ones. */
export async function loadMods(): Promise<void> {
  const seq = ++loadSeq;
  try {
    const state = await listMods();
    if (seq !== loadSeq) return;
    const builtinIds = new Set(BUILTIN_MODS.map((m) => m.id));
    const installed = state.mods
      .filter((m) => !builtinIds.has(m.id))
      .map(checked)
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
    // Only worth asking if some mod code would start; asked once per session.
    const wouldRun = installed.some((m) => isActive(m) && hasCode(m));
    if (!state.safeStartSuggested || state.disabledByFlag || !wouldRun) safeStartAnswered = true;
    const askSafeStart = !safeStartAnswered;
    if (askSafeStart && !safeStartNoticed) {
      safeStartNoticed = true;
      notify("The last session ended while mods were running. Their code waits until you choose on the Mods page.");
    }
    useMods.setState({
      mods: [...BUILTIN_MODS, ...installed],
      ready: true,
      disabledByFlag: state.disabledByFlag,
      safeStartSuggested: askSafeStart,
    });
  } catch (e) {
    if (seq !== loadSeq) return;
    useMods.setState({ ready: true });
    notify(`Installed mods could not be listed: ${message(e)}`);
  }
}

/**
 * Enabled mods with code (a `main` script or views) that may run now:
 * approved, unchanged, valid, not suspended. While the user has not yet answered the safe-start question,
 * none run, since the last session may have ended because of one of them.
 */
export function runnableCodeMods(): ModRecord[] {
  const s = useMods.getState();
  if (s.disabledByFlag || s.codeModsSuspended || s.safeStartSuggested) return [];
  return s.mods.filter((m) => !m.builtin && isActive(m) && hasCode(m));
}

/**
 * Whether a mod runs code: a `main` script, or views (pages with their own
 * scripts, which run on the window's thread, so they count for safe start too).
 */
export function hasCode(mod: ModRecord): boolean {
  return Boolean(mod.manifest?.main) || (mod.manifest?.contributes?.views?.length ?? 0) > 0;
}

// ---- Failures ----

const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURES_TO_TURN_OFF = 3;
const KEEP_ERRORS = 20;
const failures = new Map<string, number[]>();
const turningOff = new Set<string>();

/** A mod failed (error, hang, bad message). Three failures in ten minutes turn it off. */
export function reportModFailure(id: string, reason: string): void {
  const now = Date.now();
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const text = reason.length > 300 ? reason.slice(0, 300) + "…" : reason;
  const { errors } = useMods.getState();
  useMods.setState({ errors: { ...errors, [id]: [...(errors[id] ?? []), `${time} ${text}`].slice(-KEEP_ERRORS) } });

  const recent = [...(failures.get(id) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS), now];
  failures.set(id, recent);
  const mod = useMods.getState().mods.find((m) => m.id === id);
  if (recent.length < FAILURES_TO_TURN_OFF || !mod || mod.builtin || !mod.enabled || turningOff.has(id)) return;

  // Off here at once, so the runtime stops it before the core has answered.
  failures.delete(id);
  turningOff.add(id);
  const name = modName(id);
  useMods.setState({ mods: useMods.getState().mods.map((m) => (m.id === id ? { ...m, enabled: false } : m)) });
  setModEnabled(id, false, [])
    .then(
      () => notify(`${name} was turned off after failing three times in ten minutes.`),
      (e) => notify(`${name} keeps failing and could not be turned off: ${message(e)}`),
    )
    .finally(() => {
      turningOff.delete(id);
      void loadMods();
    });
}

// ---- Changes the Mods page makes; each one reloads the list ----

async function thenReload<T>(change: Promise<T>): Promise<T> {
  try {
    return await change;
  } finally {
    await loadMods();
  }
}

/** Turns a mod on with exactly the capabilities the user approved. */
export function turnOn(id: string, granted: Capability[]): Promise<ModRecord> {
  failures.delete(id);
  return thenReload(setModEnabled(id, true, granted));
}

export function turnOff(id: string): Promise<ModRecord> {
  return thenReload(setModEnabled(id, false, []));
}

const removing = new Set<string>();

/** Whether a mod is being removed with its storage, so its running code's last values are not written back. */
export const modBeingRemoved = (id: string) => removing.has(id);

export async function removeMod(id: string): Promise<void> {
  removing.add(id);
  try {
    await thenReload(uninstallMod(id));
  } finally {
    removing.delete(id);
  }
}

export function installFrom(path: string): Promise<ModRecord> {
  return thenReload(installMod(path));
}

export function loadDevFrom(path: string): Promise<ModRecord> {
  return thenReload(loadDevMod(path));
}

/** Re-reads a dev mod's manifest and asks the runtime to restart its code. */
export async function reloadDevMod(id: string): Promise<void> {
  await loadMods();
  const { restarts } = useMods.getState();
  useMods.setState({ restarts: { ...restarts, [id]: (restarts[id] ?? 0) + 1 } });
}

/** "Start without mod code this time": no code mod runs until the app starts again. */
export function startWithoutModCode() {
  safeStartAnswered = true;
  useMods.setState({ codeModsSuspended: true, safeStartSuggested: false });
}

/** "Keep them on": code mods start as usual. */
export function keepModsOn() {
  safeStartAnswered = true;
  useMods.setState({ safeStartSuggested: false });
}

// ---- Contributions of enabled mods ----

/** Derives a list from the mods array, recomputed only when the array changes (so selectors stay stable). */
function fromMods<T>(derive: (mods: ModRecord[]) => T): (mods: ModRecord[]) => T {
  let last: ModRecord[] | null = null;
  let value: T;
  return (mods) => {
    if (mods !== last) {
      last = mods;
      value = derive(mods);
    }
    return value;
  };
}

export interface AvailableRulePack {
  modId: string;
  modName: string;
  pack: RulePackContribution;
  /** contentHash(pack), to notice changes after attaching. */
  hash: string;
}

const rulePacksFor = fromMods((mods): AvailableRulePack[] =>
  mods.filter(isActive).flatMap((m) =>
    (m.manifest!.contributes?.rulePacks ?? []).map((pack) => ({ modId: m.id, modName: m.manifest!.name, pack, hash: contentHash(pack) })),
  ),
);

/** Rule packs from enabled mods. */
export function useRulePacks(): AvailableRulePack[] {
  return useMods((s) => rulePacksFor(s.mods));
}

/** The same, outside React. */
export function availableRulePacks(): AvailableRulePack[] {
  return rulePacksFor(useMods.getState().mods);
}

export interface AvailableTheme {
  /** `<mod id>:<theme id>`. */
  id: string;
  modId: string;
  modName: string;
  builtin: boolean;
  label: string;
  light: boolean;
  tokens: ThemeTokens;
}

const themesFor = fromMods((mods): AvailableTheme[] =>
  mods.filter(isActive).flatMap((m) =>
    (m.manifest!.contributes?.themes ?? []).map((t) => ({
      id: `${m.id}:${t.id}`,
      modId: m.id,
      modName: m.manifest!.name,
      builtin: Boolean(m.builtin),
      label: t.label,
      light: t.light,
      tokens: t.tokens,
    })),
  ),
);

/** Themes from enabled mods, built-in ones first. */
export function useThemes(): AvailableTheme[] {
  return useMods((s) => themesFor(s.mods));
}

export function availableThemes(): AvailableTheme[] {
  return themesFor(useMods.getState().mods);
}

export const findTheme = (id: string) => availableThemes().find((t) => t.id === id);

const presetsFor = fromMods((mods): LayoutPreset[] =>
  mods.filter(isActive).flatMap((m) =>
    (m.manifest!.contributes?.layouts ?? []).map((l) => ({ id: `${m.id}:${l.id}`, label: l.label, columns: l.columns })),
  ),
);

// Settings and the palette read presets from the layout's own list.
setLayoutPresets(presetsFor(useMods.getState().mods));
useMods.subscribe((s, prev) => {
  if (s.mods !== prev.mods) setLayoutPresets(presetsFor(s.mods));
});

/** A mod's display name, or its id. */
export function modName(id: string): string {
  return useMods.getState().mods.find((m) => m.id === id)?.manifest?.name ?? id;
}
