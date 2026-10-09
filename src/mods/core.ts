// The core's side of mods: installed folders, what the user approved, file
// hashes and each mod's storage. Outside the desktop app (npm run dev) there
// is no core, so only built-in mods exist.

import { inTauri } from "../model/backend";
import type { Capability, Json, ModRecord, ModsState } from "./types";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Every installed mod, plus how this session started. */
export function listMods(): Promise<ModsState> {
  if (!inTauri) return Promise.resolve({ mods: [], disabledByFlag: false, safeStartSuggested: false });
  return invoke<ModsState>("mods_list");
}

/** Copies a mod folder into the mods folder. It starts disabled. */
export function installMod(path: string): Promise<ModRecord> {
  return invoke<ModRecord>("mods_install", { path });
}

/** Loads a mod in place from the author's folder, for development. It starts disabled. */
export function loadDevMod(path: string): Promise<ModRecord> {
  return invoke<ModRecord>("mods_dev_load", { path });
}

/** Removes an installed mod's folder (or forgets a dev mod) and its storage. */
export function uninstallMod(id: string): Promise<void> {
  return invoke<void>("mods_uninstall", { id });
}

/**
 * Turns a mod on, granting exactly `granted` (what the user approved), and
 * records the hash of its files; or turns it off.
 */
export function setModEnabled(id: string, enabled: boolean, granted: Capability[]): Promise<ModRecord> {
  return invoke<ModRecord>("mods_set_enabled", { id, enabled, granted });
}

/** A mod's stored value, or null. */
export function storageGet(id: string, key: string): Promise<Json | null> {
  if (!inTauri) return Promise.resolve(memory.get(`${id}\n${key}`) ?? null);
  return invoke<Json | null>("mod_storage_get", { id, key });
}

/** Stores a value for a mod (null removes it). Each mod's storage is capped at 1 MB. */
export function storageSet(id: string, key: string, value: Json | null): Promise<void> {
  if (!inTauri) {
    if (value === null) memory.delete(`${id}\n${key}`);
    else memory.set(`${id}\n${key}`, value);
    return Promise.resolve();
  }
  return invoke<void>("mod_storage_set", { id, key, value });
}

const memory = new Map<string, Json>();

/**
 * Tells the core the window is alive. It keeps its "mods were running" mark
 * on exit when these stop coming (a frozen window or a crashed page), so the
 * next start can offer to leave mod code off.
 */
export function heartbeat(): Promise<void> {
  if (!inTauri) return Promise.resolve();
  return invoke<void>("mods_heartbeat");
}

/** Asks the user for a folder. Null when cancelled or outside the desktop app. */
export { pickFolder } from "../model/backend";
