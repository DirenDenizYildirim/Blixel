// The connectors as the core reports them, with their states, and what the
// interface does with them. The core keeps the connectors, their secrets and
// the approved tool hashes; this only mirrors them. Outside the desktop app
// the list is empty and changes are refused with a calm reason.

import { create } from "zustand";
import { inTauri } from "../model/backend";
import {
  connectorApprove,
  connectorRemove,
  connectorSave,
  connectorSetSecret,
  connectorsList,
  connectorTest,
  storeGet,
  storeSet,
  type Json,
} from "../model/core-api";
import { updateAgent, useStore } from "../model/store";
import type { Agent, Connector, ConnectorState, ConnectorTool, ConnectorVar, Permission } from "../model/types";

export interface ConnectorEntry {
  connector: Connector;
  state: ConnectorState;
}

interface ConnectorsState {
  ready: boolean;
  entries: ConnectorEntry[];
  /** Why the list could not be read, if it could not. */
  error: string | null;
  /** The tools as they were when the user approved them, by connector id, to show what changed since. */
  approvedTools: Record<string, ConnectorTool[]>;
}

export const useConnectors = create<ConnectorsState>(() => ({ ready: false, entries: [], error: null, approvedTools: {} }));

const set = useConnectors.setState;
const get = useConnectors.getState;

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const NEEDS_APP = "Connectors run in the desktop app.";
export const connectorsAvailable = inTauri;

export const connectorById = (id: string) => get().entries.find((e) => e.connector.id === id);

/** A connector's name for display, such as in a permission question; the id if it is gone. */
export const connectorName = (id: string) => connectorById(id)?.connector.name ?? id;

const toolsKey = (id: string) => `connector-tools:${id}`;

let loading: Promise<void> | null = null;

/** Reads the list from the core. Concurrent calls share one read. */
export function loadConnectors(): Promise<void> {
  loading ??= (async () => {
    try {
      const entries = await connectorsList();
      const approved: Record<string, ConnectorTool[]> = {};
      await Promise.all(
        entries.map(async ({ connector }) => {
          const tools = await storeGet<Json>("app", toolsKey(connector.id)).catch(() => null);
          if (Array.isArray(tools)) approved[connector.id] = tools as unknown as ConnectorTool[];
        }),
      );
      set({ ready: true, entries, error: null, approvedTools: approved });
      void listenToStates();
    } catch (e) {
      set({ ready: true, error: message(e) });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function patchEntry(id: string, patch: Partial<ConnectorEntry>) {
  set({ entries: get().entries.map((e) => (e.connector.id === id ? { ...e, ...patch } : e)) });
}

let listening = false;

/**
 * Follows the core's reports of a connector's state (it checks, fails, needs
 * sign-in, or its tools change while an agent uses it), so cards stay current.
 */
async function listenToStates() {
  if (!inTauri || listening) return;
  listening = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ id: string; state: ConnectorState }>("connector://state", ({ payload }) => {
    if (connectorById(payload.id)) patchEntry(payload.id, { state: payload.state });
    else void loadConnectors();
  });
}

/** Adds or changes a connector and lists it. Its secrets are stored separately, with `storeSecrets`. */
export async function saveConnector(connector: Connector): Promise<Connector> {
  const saved = await connectorSave(connector);
  if (connectorById(saved.id)) patchEntry(saved.id, { connector: saved });
  else set({ entries: [...get().entries, { connector: saved, state: { kind: "unchecked" } }] });
  return saved;
}

/** Hands secrets typed by the user to the core, which keeps them in the keychain; they are never kept here. */
export async function storeSecrets(id: string, secrets: Record<string, string>): Promise<void> {
  const names = Object.keys(secrets);
  for (const name of names) await connectorSetSecret(id, name, secrets[name]);
  const entry = connectorById(id);
  // The core reports secrets only as set or not; mark these set without asking it again.
  if (entry && names.length) patchEntry(id, { connector: markSet(entry.connector, names) });
}

function markSet(c: Connector, names: string[]): Connector {
  const vars = (list: ConnectorVar[]) => list.map((v) => (v.secret && names.includes(v.name) ? { ...v, isSet: true } : v));
  const t = c.transport;
  return { ...c, transport: t.kind === "command" ? { ...t, env: vars(t.env) } : { ...t, headers: vars(t.headers) } };
}

/** Starts the connector and lists its tools; the card shows "checking" meanwhile. */
export async function testConnector(id: string): Promise<void> {
  patchEntry(id, { state: { kind: "checking" } });
  try {
    patchEntry(id, { state: await connectorTest(id) });
  } catch (e) {
    patchEntry(id, { state: { kind: "failed", reason: message(e), retriesLeft: 0 } });
  }
}

/** Approves the tools the connector offers now, so they stop asking on every call. */
export async function approveTools(id: string): Promise<void> {
  const entry = connectorById(id);
  if (entry?.state.kind !== "changed") return;
  const { tools, hash } = entry.state;
  const connector = await connectorApprove(id, hash);
  patchEntry(id, { connector, state: { kind: "ok", tools, hash } });
  set({ approvedTools: { ...get().approvedTools, [id]: tools } });
  storeSet("app", toolsKey(id), tools as unknown as Json).catch((e) => console.error(e));
}

/** Forgets the connector (the core deletes its secrets) and takes it off the agents here. */
export async function removeConnector(id: string): Promise<void> {
  await connectorRemove(id);
  const { [id]: _gone, ...approved } = get().approvedTools;
  set({ entries: get().entries.filter((e) => e.connector.id !== id), approvedTools: approved });
  storeSet("app", toolsKey(id), null).catch(() => undefined);
  for (const agent of useStore.getState().agents) if (id in agent.connectors) setAccess(agent, id, "off");
}

/** An agent's access to a connector; Off is stored as no entry. Saved like any change to the agent. */
export function setAccess(agent: Agent, connectorId: string, permission: Permission) {
  updateAgent(agent.id, { connectors: withAccess(agent.connectors, connectorId, permission) });
}

export function withAccess(connectors: Record<string, Permission>, id: string, permission: Permission) {
  const next = { ...connectors };
  if (permission === "off") delete next[id];
  else next[id] = permission;
  return next;
}

/** Whether the user should look at it: not checked, not working, or tools not approved. */
export function needsYou(state: ConnectorState): boolean {
  return state.kind === "unchecked" || state.kind === "changed" || state.kind === "failed" || state.kind === "sign-in";
}
