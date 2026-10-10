import { create } from "zustand";
import { nameHue } from "../avatars/generator";
import { FALLBACK_THEME_ID, saveThemeId, type ThemeId } from "../theme/theme";
import { demoBackend, inTauri, type Backend } from "./backend";
import { setChatOpen, setEditorOpen } from "./layout";
import { demoProject } from "./placeholders";
import {
  FALLBACK_MODELS,
  type ActivityEntry,
  type Agent,
  type AgentStatus,
  type ChatItem,
  type ModelChoice,
  type Presence,
  type Program,
  type Project,
  type SavedAgent,
  type Task,
  type TreeEntry,
} from "./types";

/** The full-window pages: the main layout, an agent's settings, the mods, the app's settings, or the connectors. */
export type View =
  | { kind: "main" }
  | { kind: "agent-form"; editingId: string | null }
  | { kind: "mods" }
  | { kind: "settings" }
  | { kind: "connectors" };

export interface ShellState {
  title: string;
  /** The latest output, with terminal colour codes, at most SHELL_KEEP characters. */
  data: string;
  /** Characters ever written, so a view can tell what is new after old output is dropped. */
  total: number;
}

/** How much of each agent's shell output is kept; older lines are dropped. */
const SHELL_KEEP = 1_000_000;

/** Everything that belongs to one project, as loaded from the core or as the demo starts. */
export interface ProjectData {
  projectId: string;
  name: string;
  agents: Agent[];
  /** Agents whose saved record was changed outside the app, until the user saves them again. */
  agentTrust: Record<string, Exclude<SavedAgent["trust"], "ok">>;
  chats: Record<string, ChatItem[]>;
  shells: Record<string, ShellState>;
  tasks: Task[];
  selectedId: string | null;
  following: string | null;
  drafts: Record<string, string>;
  collapsed: Record<string, boolean>;
  openTabs: string[];
  activePath: string | null;
}

/** A question the app needs answered before it goes on, shown as a small card. */
export interface Ask {
  title: string;
  detail?: string;
  yes: string;
  no?: string;
  /** For answers that remove something: the safe answer gets the focus. */
  danger?: boolean;
}

interface State {
  /** The theme on screen, `<mod id>:<theme id>`; theme/active.ts applies it. */
  theme: ThemeId;
  view: View;
  /** False until the app knows which project to show, so another one never flashes up first. */
  ready: boolean;
  /** Every saved project; the demo is not one of them. */
  projects: Project[];
  /** The open project, or "demo". */
  projectId: string;
  /** Goes up whenever another project (or a fresh demo) replaces the open one. */
  epoch: number;
  agents: Agent[];
  /** Agents whose saved record was changed outside the app: every Allow became Ask until the user reviews them. */
  agentTrust: Record<string, "changed-outside">;
  tasks: Task[];
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
  asking: Ask | null;
}

let backend: Backend = demoBackend();
export const getBackend = () => backend;

// The demo until the projects say otherwise (in the desktop app, nothing shows until then).
const demo = demoProject();

export const useStore = create<State>(() => ({
  theme: FALLBACK_THEME_ID,
  view: { kind: "main" },
  ready: !inTauri,
  projects: [],
  projectId: demo.projectId,
  epoch: 0,
  agents: demo.agents,
  agentTrust: demo.agentTrust,
  tasks: demo.tasks,
  models: FALLBACK_MODELS,
  selectedId: demo.selectedId,
  chats: demo.chats,
  shells: demo.shells,
  composerMode: "task",
  drafts: demo.drafts,
  workspace: { kind: backend.kind, name: backend.name },
  tree: [],
  filesOpen: true,
  collapsed: demo.collapsed,
  openTabs: [],
  activePath: null,
  dirty: {},
  conflicts: {},
  presence: {},
  following: demo.following,
  cursor: { line: 1, col: 1 },
  notice: null,
  asking: null,
}));

const set = useStore.setState;
const get = useStore.getState;

let nextId = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;

export const agentById = (id: string | null | undefined) =>
  id ? get().agents.find((a) => a.id === id) : undefined;

/**
 * Whether an agent belongs to the open project. Reports about any other agent
 * (a late event from the core, a demo script still winding down) are dropped,
 * so they never land in another project's chats.
 */
const known = (agentId: string) => get().agents.some((a) => a.id === agentId);

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

/** Marks an agent's saved record as changed outside the app, or (null) as the user's again. */
export function setAgentTrust(id: string, trust: "changed-outside" | null) {
  const agentTrust = get().agentTrust;
  if ((agentTrust[id] ?? null) === trust || (trust && !known(id))) return;
  const next = { ...agentTrust };
  if (trust) next[id] = trust;
  else delete next[id];
  set({ agentTrust: next });
}

/**
 * Shows an agent saved from its settings page (real-agent.ts's syncAgent has
 * saved it, as reviewed). The user has now reviewed it, so a record that was
 * changed outside the app counts as theirs again.
 */
export function saveAgent(agent: Agent) {
  const exists = get().agents.some((a) => a.id === agent.id);
  const agentTrust = { ...get().agentTrust };
  delete agentTrust[agent.id];
  set({
    agents: exists ? get().agents.map((a) => (a.id === agent.id ? agent : a)) : [...get().agents, agent],
    agentTrust,
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
  if (!known(agentId)) return;
  const chats = get().chats;
  set({ chats: { ...chats, [agentId]: [...(chats[agentId] ?? []), item] } });
}

export function patchChat(agentId: string, itemId: string, patch: Partial<ChatItem>) {
  const chats = get().chats;
  if (!chats[agentId]?.some((it) => it.id === itemId)) return;
  set({
    chats: {
      ...chats,
      [agentId]: (chats[agentId] ?? []).map((it) => (it.id === itemId ? ({ ...it, ...patch } as ChatItem) : it)),
    },
  });
}

/**
 * Entries in one log block. A long run of activity starts a new block after
 * this many, so no one chat item (saved as one row) grows without end.
 */
const ACTIVITY_BLOCK = 200;

/** Adds an entry to the latest log block if it is the chat's last item and has room, else to a new block. */
function appendActivity(agentId: string, entry: ActivityEntry) {
  const items = get().chats[agentId] ?? [];
  const last = items[items.length - 1];
  if (last?.kind === "activity" && last.entries.length < ACTIVITY_BLOCK) {
    patchChat(agentId, last.id, { entries: [...last.entries, entry] });
  } else {
    pushChat(agentId, { kind: "activity", id: uid("a"), entries: [entry] });
  }
}

/** Adds a line to the agent's activity log, joining the log block if it is the latest item. */
export function logActivity(agentId: string, entry: Omit<ActivityEntry, "id">): string {
  const id = uid("e");
  appendActivity(agentId, { ...entry, id });
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
  appendActivity(agentId, { verb: entry.verb, target: entry.target ?? "", result: entry.result ?? "", ...entry });
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
  if (!known(agentId)) return;
  const shells = get().shells;
  const prev = shells[agentId] ?? { title: "", data: "", total: 0 };
  set({ shells: { ...shells, [agentId]: { ...prev, title } } });
}

export function writeShell(agentId: string, data: string) {
  if (!known(agentId)) return;
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
  const from = backend;
  const tree = await from.list();
  // A list that arrives after another project opened belongs to the old one.
  if (from === backend) set({ tree });
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
  if (presence && !known(agentId)) return;
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
/** Shows a short notice at the foot of the window for a few seconds (`ms`). */
export function notify(text: string, ms = 4000) {
  clearTimeout(noticeTimer);
  set({ notice: text });
  noticeTimer = setTimeout(() => set({ notice: null }), ms);
}

/** Switching projects closes every file; the editor drops its buffers on this event. */
type Listener = () => void;
const workspaceListeners = new Set<Listener>();
export const onWorkspaceChange = (fn: Listener) => {
  workspaceListeners.add(fn);
  return () => workspaceListeners.delete(fn);
};

/**
 * Shows another project (or a fresh demo) in place of the open one. Saving
 * what was open is the caller's part (projects.ts), before this.
 */
export async function switchWorkspace(next: Backend, data: ProjectData) {
  backend = next;
  const { name, openTabs, activePath, ...rest } = data;
  set({
    ...rest,
    epoch: get().epoch + 1,
    workspace: { kind: next.kind, name },
    view: { kind: "main" },
    tree: [],
    openTabs: [],
    activePath: null,
    dirty: {},
    conflicts: {},
    presence: {},
  });
  workspaceListeners.forEach((fn) => fn());
  try {
    await refreshTree();
  } catch (e) {
    notify(`The project's files could not be listed: ${e}`);
  }
  // Tabs come back only for files that are still there.
  const files = new Set(get().tree.filter((e) => !e.dir).map((e) => e.path));
  const tabs = openTabs.filter((p) => files.has(p));
  if (backend === next) {
    set({ openTabs: tabs, activePath: activePath && tabs.includes(activePath) ? activePath : (tabs[tabs.length - 1] ?? null) });
  }
}

/** Renames the open project on screen (the core keeps the name). */
export function setWorkspaceName(name: string) {
  set({ workspace: { ...get().workspace, name } });
}

// ---- Questions ----

let answerAsk: ((yes: boolean) => void) | null = null;

/** Asks the user a yes-or-no question in a small card; a newer question answers the older one with no. */
export function ask(question: Ask): Promise<boolean> {
  answerAsk?.(false);
  set({ asking: question });
  return new Promise((resolve) => {
    const answer = (yes: boolean) => {
      if (answerAsk !== answer) return;
      answerAsk = null;
      set({ asking: null });
      resolve(yes);
    };
    answerAsk = answer;
  });
}

export function answerAsking(yes: boolean) {
  answerAsk?.(yes);
}

// ---- Theme ----

/** Shows a theme from an enabled mod and remembers it for the next start. */
export function setTheme(theme: ThemeId) {
  saveThemeId(theme);
  set({ theme });
}
