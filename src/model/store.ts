import { create } from "zustand";
import { nameHue } from "../avatars/generator";
import { FALLBACK_THEME_ID, saveThemeId, type ThemeId } from "../theme/theme";
import { demoBackend, folderBackend, pickFolder, type Backend } from "./backend";
import { setChatOpen, setEditorOpen } from "./layout";
import { PLACEHOLDER_AGENTS, PLACEHOLDER_CHATS, PLACEHOLDER_SHELLS } from "./placeholders";
import {
  FALLBACK_MODELS,
  type ActivityEntry,
  type Agent,
  type AgentStatus,
  type ChatItem,
  type ModelChoice,
  type Presence,
  type Program,
  type TreeEntry,
} from "./types";

/** The full-window pages: the main layout, an agent's settings, the mods, or the app's settings. */
export type View =
  | { kind: "main" }
  | { kind: "agent-form"; editingId: string | null }
  | { kind: "mods" }
  | { kind: "settings" };

export interface ShellState {
  title: string;
  /** The latest output, with terminal colour codes, at most SHELL_KEEP characters. */
  data: string;
  /** Characters ever written, so a view can tell what is new after old output is dropped. */
  total: number;
}

/** How much of each agent's shell output is kept; older lines are dropped. */
const SHELL_KEEP = 1_000_000;

const shellsFrom = (init: Record<string, { title: string; data: string }>) =>
  Object.fromEntries(Object.entries(init).map(([id, s]) => [id, { ...s, total: s.data.length }]));

interface State {
  /** The theme on screen, `<mod id>:<theme id>`; theme/active.ts applies it. */
  theme: ThemeId;
  view: View;
  agents: Agent[];
  /** The models each program offers: reported by a running agent, or the fallback list. */
  models: Record<Program, ModelChoice[]>;
  selectedId: string | null;
  chats: Record<string, ChatItem[]>;
  shells: Record<string, ShellState>;
  composerMode: "chat" | "task";
  /** What the user has typed but not sent, per agent. */
  drafts: Record<string, string>;
  workspace: { kind: Backend["kind"]; name: string };
  tree: TreeEntry[];
  filesOpen: boolean;
  collapsed: Record<string, boolean>;
  openTabs: string[];
  activePath: string | null;
  dirty: Record<string, boolean>;
  /**
   * Files that changed on disk while the user had unsaved changes in them, by
   * path, with the agent that changed them (null: a command or unknown).
   */
  conflicts: Record<string, { agentId: string | null }>;
  /** Where each agent is, by agent id. */
  presence: Record<string, Presence>;
  following: string | null;
  cursor: { line: number; col: number };
  notice: string | null;
}

let backend: Backend = demoBackend();
export const getBackend = () => backend;

export const useStore = create<State>(() => ({
  theme: FALLBACK_THEME_ID,
  view: { kind: "main" },
  agents: PLACEHOLDER_AGENTS,
  models: FALLBACK_MODELS,
  selectedId: "kestrel",
  chats: PLACEHOLDER_CHATS,
  shells: shellsFrom(PLACEHOLDER_SHELLS),
  composerMode: "task",
  drafts: {},
  workspace: { kind: backend.kind, name: backend.name },
  tree: [],
  filesOpen: true,
  collapsed: {},
  openTabs: [],
  activePath: null,
  dirty: {},
  conflicts: {},
  presence: {},
  following: "kestrel",
  cursor: { line: 1, col: 1 },
  notice: null,
}));

const set = useStore.setState;
const get = useStore.getState;

let nextId = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;

export const agentById = (id: string | null | undefined) =>
  id ? get().agents.find((a) => a.id === id) : undefined;

export const hueOf = (agent: Pick<Agent, "hue" | "name">) => agent.hue ?? nameHue(agent.name);

// ---- Agents ----

export function selectAgent(id: string) {
  set({ selectedId: id, view: { kind: "main" } });
  setChatOpen(true);
}

export function setStatus(id: string, status: AgentStatus) {
  set({ agents: get().agents.map((a) => (a.id === id ? { ...a, status } : a)) });
}

export function updateAgent(id: string, patch: Partial<Agent>) {
  set({ agents: get().agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
}

export function saveAgent(agent: Agent) {
  const exists = get().agents.some((a) => a.id === agent.id);
  set({
    agents: exists ? get().agents.map((a) => (a.id === agent.id ? agent : a)) : [...get().agents, agent],
    chats: exists ? get().chats : { ...get().chats, [agent.id]: [] },
    shells: exists ? get().shells : { ...get().shells, [agent.id]: { title: "", data: "", total: 0 } },
    selectedId: agent.id,
    view: { kind: "main" },
  });
}

export function setModels(program: Program, models: ModelChoice[]) {
  if (models.length) set({ models: { ...get().models, [program]: models } });
}

/** A model's name for display; the id itself if the program has not named it. */
export const modelName = (program: Program, id: string) =>
  get().models[program].find((m) => m.id === id)?.name ?? id;

export function showView(view: View) {
  set({ view });
}

// ---- Chat ----

export function pushChat(agentId: string, item: ChatItem) {
  const chats = get().chats;
  set({ chats: { ...chats, [agentId]: [...(chats[agentId] ?? []), item] } });
}

export function patchChat(agentId: string, itemId: string, patch: Partial<ChatItem>) {
  const chats = get().chats;
  set({
    chats: {
      ...chats,
      [agentId]: (chats[agentId] ?? []).map((it) => (it.id === itemId ? ({ ...it, ...patch } as ChatItem) : it)),
    },
  });
}

/** Adds a line to the agent's activity log, joining the log block if it is the latest item. */
export function logActivity(agentId: string, entry: Omit<ActivityEntry, "id">): string {
  const id = uid("e");
  const items = get().chats[agentId] ?? [];
  const last = items[items.length - 1];
  if (last?.kind === "activity") {
    patchChat(agentId, last.id, { entries: [...last.entries, { ...entry, id }] });
  } else {
    pushChat(agentId, { kind: "activity", id: uid("a"), entries: [{ ...entry, id }] });
  }
  return id;
}

/** Adds a log line with a known id, or updates it if it is already there. */
export function upsertActivity(agentId: string, entry: Partial<ActivityEntry> & { id: string }) {
  const items = get().chats[agentId] ?? [];
  const block = items.find((it) => it.kind === "activity" && it.entries.some((e) => e.id === entry.id));
  if (block?.kind === "activity") {
    patchChat(agentId, block.id, { entries: block.entries.map((e) => (e.id === entry.id ? { ...e, ...entry } : e)) });
    return;
  }
  if (!entry.verb) return;
  const full: ActivityEntry = { verb: entry.verb, target: entry.target ?? "", result: entry.result ?? "", ...entry };
  const last = items[items.length - 1];
  if (last?.kind === "activity") patchChat(agentId, last.id, { entries: [...last.entries, full] });
  else pushChat(agentId, { kind: "activity", id: uid("a"), entries: [full] });
}

export function patchActivity(agentId: string, entryId: string, patch: Partial<ActivityEntry>) {
  const items = get().chats[agentId] ?? [];
  const block = items.find((it) => it.kind === "activity" && it.entries.some((e) => e.id === entryId));
  if (block?.kind !== "activity") return;
  patchChat(agentId, block.id, {
    entries: block.entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e)),
  });
}

export function setDraft(agentId: string, text: string) {
  set({ drafts: { ...get().drafts, [agentId]: text } });
}

export function setComposerMode(mode: "chat" | "task") {
  set({ composerMode: mode });
}

// ---- Shells ----

export function startShell(agentId: string, title: string) {
  const shells = get().shells;
  const prev = shells[agentId] ?? { title: "", data: "", total: 0 };
  set({ shells: { ...shells, [agentId]: { ...prev, title } } });
}

export function writeShell(agentId: string, data: string) {
  const shells = get().shells;
  const prev = shells[agentId] ?? { title: "", data: "", total: 0 };
  let next = prev.data + data;
  if (next.length > SHELL_KEEP) {
    // Drop whole lines from the start, so the kept output never begins mid-line.
    const cut = next.indexOf("\n", next.length - SHELL_KEEP);
    next = next.slice(cut < 0 ? next.length - SHELL_KEEP : cut + 1);
  }
  set({ shells: { ...shells, [agentId]: { ...prev, data: next, total: prev.total + data.length } } });
}

// ---- Files and editor ----

export async function refreshTree() {
  set({ tree: await backend.list() });
}

export function openFile(path: string) {
  const { openTabs } = get();
  set({ openTabs: openTabs.includes(path) ? openTabs : [...openTabs, path], activePath: path, view: { kind: "main" } });
  setEditorOpen(true);
}

export function closeTab(path: string) {
  const { openTabs, activePath } = get();
  const i = openTabs.indexOf(path);
  const rest = openTabs.filter((p) => p !== path);
  set({ openTabs: rest, activePath: activePath === path ? (rest[Math.max(0, i - 1)] ?? null) : activePath });
}

export function setDirty(path: string, dirty: boolean) {
  if (Boolean(get().dirty[path]) !== dirty) set({ dirty: { ...get().dirty, [path]: dirty } });
}

export function setConflict(path: string, conflict: { agentId: string | null } | null) {
  const next = { ...get().conflicts };
  if (conflict) next[path] = conflict;
  else if (next[path]) delete next[path];
  else return;
  set({ conflicts: next });
}

export function toggleFolder(path: string) {
  set({ collapsed: { ...get().collapsed, [path]: !get().collapsed[path] } });
}

export function toggleFiles() {
  set({ filesOpen: !get().filesOpen });
}

export function setPresence(agentId: string, presence: Presence | null) {
  const next = { ...get().presence };
  if (presence) next[agentId] = presence;
  else delete next[agentId];
  set({ presence: next });
}

export function setFollowing(agentId: string | null) {
  set({ following: agentId });
}

export function setCursor(line: number, col: number) {
  const c = get().cursor;
  if (c.line !== line || c.col !== col) set({ cursor: { line, col } });
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string) {
  clearTimeout(noticeTimer);
  set({ notice: text });
  noticeTimer = setTimeout(() => set({ notice: null }), 4000);
}

/** Switching projects closes every file; the editor drops its buffers on this event. */
type Listener = () => void;
const workspaceListeners = new Set<Listener>();
export const onWorkspaceChange = (fn: Listener) => {
  workspaceListeners.add(fn);
  return () => workspaceListeners.delete(fn);
};

async function useBackend(next: Backend) {
  backend = next;
  workspaceListeners.forEach((fn) => fn());
  set({ workspace: { kind: next.kind, name: next.name }, openTabs: [], activePath: null, dirty: {}, conflicts: {}, presence: {} });
  await refreshTree();
}

export async function openFolder() {
  const path = await pickFolder();
  if (!path) {
    notify("Opening a folder works in the desktop app.");
    return;
  }
  try {
    await useBackend(await folderBackend(path));
  } catch (e) {
    notify(String(e));
  }
}

export async function openDemo() {
  await useBackend(demoBackend());
}

// ---- Theme ----

/** Shows a theme from an enabled mod and remembers it for the next start. */
export function setTheme(theme: ThemeId) {
  saveThemeId(theme);
  set({ theme });
}
