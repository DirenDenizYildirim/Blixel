// The core's commands for saved data: the database (settings, chats, tasks),
// projects, file copies, agents and connectors. Outside the desktop app
// (npm run dev) there is no core: data lives in memory for the session, and
// what needs the core (projects on disk, connectors) says so.

import { inTauri } from "./backend";
import type { Agent, Connector, ConnectorState, Project, SavedAgent } from "./types";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const NEEDS_APP = "This needs the desktop app.";
const memoryDocs = new Map<string, Json>();
const memoryItems = new Map<string, Map<string, Json>>();
const listKey = (scope: string, list: string) => `${scope}\n${list}`;

// ---- Documents: one value per key, in a scope ("app" or "project:<id>") ----

export function storeGet<T extends Json>(scope: string, key: string): Promise<T | null> {
  if (!inTauri) return Promise.resolve((memoryDocs.get(`${scope}\n${key}`) as T | undefined) ?? null);
  return invoke<T | null>("store_get", { scope, key });
}

/** Stores a value; null removes it. */
export function storeSet(scope: string, key: string, value: Json | null): Promise<void> {
  if (!inTauri) {
    if (value === null) memoryDocs.delete(`${scope}\n${key}`);
    else memoryDocs.set(`${scope}\n${key}`, value);
    return Promise.resolve();
  }
  return invoke<void>("store_set", { scope, key, value });
}

// ---- Item lists: chats ("chat:<agentId>") and tasks ("tasks"), one row per item ----

/** The newest `limit` items of a list, oldest first. */
export function itemsLoad<T extends Json>(scope: string, list: string, limit: number): Promise<T[]> {
  if (!inTauri) return Promise.resolve([...(memoryItems.get(listKey(scope, list))?.values() ?? [])].slice(-limit) as T[]);
  return invoke<T[]>("items_load", { scope, list, limit });
}

/**
 * Adds or replaces items by id, keeping their first position; then keeps only
 * the newest `keep`. `refused` names the items too large to store: the rest
 * are stored all the same.
 */
export async function itemsPut(scope: string, list: string, items: { id: string; value: Json }[], keep: number): Promise<{ refused: string[] }> {
  if (!inTauri) {
    const rows = memoryItems.get(listKey(scope, list)) ?? new Map<string, Json>();
    for (const it of items) rows.set(it.id, it.value);
    while (rows.size > keep) rows.delete(rows.keys().next().value!);
    memoryItems.set(listKey(scope, list), rows);
    return { refused: [] };
  }
  // An older core answers with nothing: then nothing was refused.
  const out = await invoke<{ refused?: unknown } | null>("items_put", { scope, list, items, keep });
  const refused = Array.isArray(out?.refused) ? out.refused.filter((id): id is string => typeof id === "string") : [];
  return { refused };
}

/** Removes the given items, or the whole list when `ids` is null. */
export function itemsDelete(scope: string, list: string, ids: string[] | null): Promise<void> {
  if (!inTauri) {
    if (ids === null) memoryItems.delete(listKey(scope, list));
    else ids.forEach((id) => memoryItems.get(listKey(scope, list))?.delete(id));
    return Promise.resolve();
  }
  return invoke<void>("items_delete", { scope, list, ids });
}

/**
 * Whether the database could not be read at start and was set aside for a
 * fresh one: where the old file was kept, or null.
 */
export async function storeStatus(): Promise<{ recovered: string | null; unsaved: string | null }> {
  if (!inTauri) return { recovered: null, unsaved: null };
  const out = await invoke<{ recovered?: unknown; unsaved?: unknown } | null>("store_status");
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { recovered: text(out?.recovered), unsaved: text(out?.unsaved) };
}

// ---- Projects ----

export function projectsList(): Promise<Project[]> {
  if (!inTauri) return Promise.resolve([]);
  return invoke<Project[]>("projects_list");
}

/** Makes a project of `folder` (creating it first when `makeFolder`). */
export function projectCreate(name: string, folder: string, makeFolder: boolean): Promise<Project> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<Project>("project_create", { name, folder, makeFolder });
}

/** The project for a folder, made on the spot if the folder isn't one yet. */
export function projectForFolder(path: string): Promise<Project> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<Project>("project_for_folder", { path });
}

/**
 * Opens a project: its folder becomes the workspace, every running agent
 * stops, and the core loads this project's agents. `name` is the folder's.
 */
export function projectOpen(id: string): Promise<{ project: Project; name: string }> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<{ project: Project; name: string }>("project_open", { id });
}

/** Closes the open project (for the demo): agents stop and no folder is open. */
export function projectClose(): Promise<void> {
  if (!inTauri) return Promise.resolve();
  return invoke<void>("project_close");
}

export function projectUpdate(id: string, patch: { name?: string; folder?: string }): Promise<Project> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<Project>("project_update", { id, patch });
}

/** Forgets a project and everything saved for it. Its folder is never touched. */
export function projectRemove(id: string): Promise<void> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<void>("project_remove", { id });
}

// ---- Bringing files into a project ----

export interface Measured {
  files: number;
  /** Folders count toward the copy's limit too. */
  folders?: number;
  bytes: number;
  /** Links and unreadable entries, which are not copied. */
  skipped: number;
}

export function filesMeasure(paths: string[]): Promise<Measured> {
  if (!inTauri) return Promise.resolve({ files: 0, bytes: 0, skipped: 0 });
  return invoke<Measured>("files_measure", { paths });
}

export interface Copied {
  copied: number;
  /** Copied under a new name ("name (2)") because the name was taken: nothing is overwritten. */
  renamed: number;
  skipped: number;
}

/** Copies files and folders into the project's folder (`into` is relative to it; "" is its top). */
export function filesCopyIn(projectId: string, paths: string[], into: string): Promise<Copied> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<Copied>("files_copy_in", { projectId, paths, into });
}

// ---- Agents (the core keeps the copy it enforces) ----

/**
 * Saves an agent's settings. `reviewed` only when the user saved them from
 * the agent's form: a record changed outside the app stays distrusted (it
 * does not run) until then, whatever else saves it.
 */
export function agentSave(projectId: string, agent: Agent, reviewed = false): Promise<SavedAgent> {
  if (!inTauri) return Promise.resolve({ agent, trust: "ok" });
  return invoke<SavedAgent>("agent_save", { projectId, agent, reviewed });
}

export function agentsList(projectId: string): Promise<SavedAgent[]> {
  if (!inTauri) return Promise.resolve([]);
  return invoke<SavedAgent[]>("agents_list", { projectId });
}

/** Stops the agent, deletes its record and its program's own folder. */
export function agentRemove(projectId: string, agentId: string): Promise<void> {
  if (!inTauri) return Promise.resolve();
  return invoke<void>("agent_remove", { projectId, agentId });
}

// ---- Connectors ----

export function connectorsList(): Promise<{ connector: Connector; state: ConnectorState }[]> {
  if (!inTauri) return Promise.resolve([]);
  return invoke<{ connector: Connector; state: ConnectorState }[]>("connectors_list");
}

/** Adds or changes a connector. Secret values are set separately and never returned. */
export function connectorSave(connector: Connector): Promise<Connector> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<Connector>("connector_save", { connector });
}

export function connectorRemove(id: string): Promise<void> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<void>("connector_remove", { id });
}

/** Stores a secret value (an API token, say) in the keychain; null removes it. */
export function connectorSetSecret(id: string, name: string, value: string | null): Promise<void> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<void>("connector_set_secret", { id, name, value });
}

/** Starts the connector, lists its tools and reports its state. */
export function connectorTest(id: string): Promise<ConnectorState> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<ConnectorState>("connector_test", { id });
}

/** Approves the tool definitions with this hash, so its tools no longer always ask. */
export function connectorApprove(id: string, hash: string): Promise<Connector> {
  if (!inTauri) return Promise.reject(NEEDS_APP);
  return invoke<Connector>("connector_approve", { id, hash });
}
