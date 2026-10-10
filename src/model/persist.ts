// Saving the open project: its agents, chats, tasks, shell tails and what the
// interface showed. Changes are gathered and written a little later, so a
// streaming reply rewrites one row instead of the whole chat; everything is
// written at once when the window loses focus, closes, or another project opens.
// The demo is never saved.

import { inTauri } from "./backend";
import { agentSave, agentsList, itemsDelete, itemsLoad, itemsPut, storeGet, storeSet, type Json } from "./core-api";
import { notify, setAgentTrust, useStore, type ProjectData, type ShellState } from "./store";
import { loadUsage } from "./usage";
import type { Agent, ChatItem, Project, ProjectUi, SavedAgent, Task } from "./types";

const CHAT_KEEP = 2000;
const TASK_KEEP = 5000;
/** How much of a shell's output is saved: its end, from a line start. */
const SHELL_SAVE = 200_000;

export const scopeOf = (projectId: string) => `project:${projectId}`;
export const chatList = (agentId: string) => `chat:${agentId}`;
export const shellKey = (agentId: string) => `shell:${agentId}`;
const asJson = (value: unknown) => value as Json;

type Kind = "chats" | "tasks" | "shells" | "ui";
const SAVE_KINDS: Kind[] = ["chats", "tasks", "shells", "ui"];
const DELAY: Record<Kind, number> = { chats: 750, tasks: 300, shells: 5000, ui: 1000 };

/** Where the open project is saved; null for the demo. */
let scope: string | null = null;
let projectId = "demo";
const chatDirty = new Map<string, Set<string>>();
const taskDirty = new Set<string>();
const taskGone = new Set<string>();
const shellDirty = new Set<string>();
let uiDirty = false;
const timers = new Map<Kind, ReturnType<typeof setTimeout>>();
/** Failed writes in a row, per kind: each retry waits longer, and after a few the rows wait for the next change. */
const failures: Record<Kind, number> = { chats: 0, tasks: 0, shells: 0, ui: 0 };
const RETRIES = 5;
/** Each agent as last saved, so only real changes (not its status) are written. */
const savedAgents = new Map<string, string>();
/** Writes run one after another, so a newer copy of a row always lands last. */
let queue: Promise<void> = Promise.resolve();

const agentJson = (agent: Agent) => JSON.stringify({ ...agent, status: "idle" });

let lastProblem = 0;
function report(e: unknown) {
  // One notice now and then, not one per failed write.
  if (Date.now() - lastProblem < 30_000) return;
  lastProblem = Date.now();
  notify(`Saving failed: ${e}`);
}

function enqueue(job: () => Promise<unknown>) {
  queue = queue.then(job).then(
    () => undefined,
    (e) => report(e),
  );
}

function later(kind: Kind, delay = DELAY[kind]) {
  if (!timers.has(kind)) {
    timers.set(
      kind,
      setTimeout(() => {
        timers.delete(kind);
        write(kind);
      }, delay),
    );
  }
}

/**
 * A write that failed (the database busy or full, say): its rows are marked
 * unsaved again and written later, unless another project opened meanwhile.
 */
function failed(kind: Kind, at: string, e: unknown, remark: () => void) {
  report(e);
  if (scope !== at) return;
  remark();
  failures[kind]++;
  if (failures[kind] <= RETRIES) later(kind, Math.min(60_000, 1000 * 2 ** failures[kind]));
}

/** Shell output to keep: its end, cut at a line start. */
function shellTail(data: string) {
  if (data.length <= SHELL_SAVE) return data;
  const cut = data.indexOf("\n", data.length - SHELL_SAVE);
  return data.slice(cut < 0 ? data.length - SHELL_SAVE : cut + 1);
}

// ---- Keeping rows small enough to save ----

/** The core stores at most 256 KB per item; what is sent stays under this. */
const ROW_BYTES = 200_000;
/** The longest text kept in a saved item, at each step of cutting harder. The chat on screen keeps it all. */
const TEXT_LIMITS = [64_000, 8_000, 1_000, 200];
const CUT_MARK = " [cut]";
/** How hard each row is cut, by list and id: raised when the core refuses it as too large. */
const squeeze = new Map<string, number>();
/** Rows left unsaved because nothing more could be cut, each reported once. */
const unsaveable = new Set<string>();
const rowKey = (list: string, id: string) => `${list}\n${id}`;
const encoder = new TextEncoder();

function cutText(text: string, limit: number) {
  if (text.length <= limit) return text;
  // Never between the two halves of one character.
  const end = /[\ud800-\udbff]/.test(text[limit - 1]) ? limit - 1 : limit;
  return text.slice(0, end) + CUT_MARK;
}

/** A copy with every text longer than `limit` cut; the value itself when nothing is. */
function cutLong(value: unknown, limit: number): unknown {
  if (typeof value === "string") return cutText(value, limit);
  if (Array.isArray(value)) {
    const next = value.map((v) => cutLong(v, limit));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (isObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = cutLong(v, limit);
      if (next[k] !== v) changed = true;
    }
    return changed ? next : value;
  }
  return value;
}

function fits(value: unknown) {
  const json = JSON.stringify(value);
  // A UTF-16 unit is at most 3 bytes in UTF-8, so most rows need no counting.
  return json.length * 3 <= ROW_BYTES || encoder.encode(json).length <= ROW_BYTES;
}

interface Row {
  id: string;
  value: Json;
}

/**
 * The rows to save for these items, long texts cut so that one huge item
 * (a long command, say) can never stop the rest from saving. An item that
 * is still too large once cut as far as it goes is left out, with a notice.
 */
function rowsOf(list: string, items: { id: string }[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    const key = rowKey(list, item.id);
    let value: unknown = null;
    for (let level = squeeze.get(key) ?? 0; level < TEXT_LIMITS.length; level++) {
      const cut = cutLong(item, TEXT_LIMITS[level]);
      if (fits(cut)) {
        value = cut;
        break;
      }
    }
    if (value !== null) rows.push({ id: item.id, value: asJson(value) });
    else tooLarge(list, item.id);
  }
  return rows;
}

function tooLarge(list: string, id: string) {
  const key = rowKey(list, id);
  if (unsaveable.has(key)) return;
  unsaveable.add(key);
  notify(`${list === "tasks" ? "A task" : "A chat entry"} was too long to save. It stays on screen until the project closes.`, 8000);
}

/** Rows the core refused as too large: cut harder and tried again, or left out once nothing more can be cut. */
function cutHarder(list: string, ids: string[]): string[] {
  const again: string[] = [];
  for (const id of ids) {
    const key = rowKey(list, id);
    const level = (squeeze.get(key) ?? 0) + 1;
    squeeze.set(key, level);
    if (level < TEXT_LIMITS.length) again.push(id);
    else tooLarge(list, id);
  }
  return again;
}

/** Saves rows; ones refused or not written are marked unsaved again (`remark`) and tried later. */
function putRows(kind: Kind, at: string, list: string, rows: Row[], keep: number, remark: (ids: string[]) => void) {
  enqueue(async () => {
    try {
      const { refused } = await itemsPut(at, list, rows, keep);
      failures[kind] = 0;
      const again = refused.length ? cutHarder(list, refused) : [];
      if (again.length && scope === at) {
        remark(again);
        later(kind);
      }
    } catch (e) {
      failed(kind, at, e, () => remark(rows.map((r) => r.id)));
    }
  });
}

function markChat(agentId: string, ids: string[]) {
  const set = chatDirty.get(agentId) ?? new Set<string>();
  ids.forEach((id) => set.add(id));
  chatDirty.set(agentId, set);
}

/** Starts the writes gathered so far, reading the rows as they are now. */
function write(kind: Kind) {
  const at = scope;
  if (!at) return;
  const s = useStore.getState();
  if (kind === "chats") {
    for (const [agentId, ids] of chatDirty) {
      const list = chatList(agentId);
      const rows = rowsOf(list, (s.chats[agentId] ?? []).filter((it) => ids.has(it.id)));
      if (rows.length) putRows(kind, at, list, rows, CHAT_KEEP, (again) => markChat(agentId, again));
    }
    chatDirty.clear();
  } else if (kind === "tasks") {
    const rows = rowsOf("tasks", s.tasks.filter((t) => taskDirty.has(t.id)));
    const gone = [...taskGone];
    taskDirty.clear();
    taskGone.clear();
    if (rows.length) putRows(kind, at, "tasks", rows, TASK_KEEP, (again) => again.forEach((id) => taskDirty.add(id)));
    if (gone.length) {
      enqueue(() =>
        itemsDelete(at, "tasks", gone).catch((e) => failed(kind, at, e, () => gone.forEach((id) => taskGone.add(id)))),
      );
    }
  } else if (kind === "shells") {
    for (const agentId of shellDirty) {
      const shell = s.shells[agentId];
      if (!shell) continue;
      enqueue(() =>
        storeSet(at, shellKey(agentId), { title: shell.title, data: shellTail(shell.data) }).then(
          () => void (failures.shells = 0),
          (e) => failed(kind, at, e, () => shellDirty.add(agentId)),
        ),
      );
    }
    shellDirty.clear();
  } else if (uiDirty) {
    uiDirty = false;
    const ui: ProjectUi = {
      v: 1,
      selectedId: s.selectedId,
      openTabs: s.openTabs,
      activePath: s.activePath,
      drafts: s.drafts,
      collapsed: s.collapsed,
    };
    enqueue(() =>
      storeSet(at, "ui", asJson(ui)).then(
        () => void (failures.ui = 0),
        (e) => failed(kind, at, e, () => (uiDirty = true)),
      ),
    );
  }
}

/** Writes everything still waiting (retries included), and resolves once it is saved. */
export async function flushSaves() {
  timers.forEach(clearTimeout);
  timers.clear();
  SAVE_KINDS.forEach(write);
  await queue;
}

/** Counts an agent as saved as it is now, so it is not written again unchanged. */
function markAgentSaved(agent: Agent) {
  savedAgents.set(agent.id, agentJson(agent));
}

/**
 * The core's answer to saving an agent. A record changed outside the app
 * stays distrusted until the user saves it from its form, so only that save
 * clears the warning (store.ts's saveAgent); any save may raise it.
 */
function noteTrust(at: string, agentId: string, saved: SavedAgent | null | undefined) {
  if (saved?.trust === "changed-outside" && projectId === at) setAgentTrust(agentId, "changed-outside");
}

/**
 * Saves an agent now, after the writes already waiting, so an older copy
 * never lands after it. `reviewed`: the user saved it from its form.
 */
export async function saveAgentNow(at: string, agent: Agent, reviewed: boolean): Promise<SavedAgent> {
  const json = agentJson(agent);
  const done = queue.then(() => agentSave(at, JSON.parse(json) as Agent, reviewed));
  queue = done.then(
    () => undefined,
    () => undefined,
  );
  const saved = await done;
  if (projectId === at) savedAgents.set(agent.id, json);
  if (!reviewed) noteTrust(at, agent.id, saved);
  return saved;
}

useStore.subscribe((s, prev) => {
  if (s.epoch !== prev.epoch) {
    // Another project opened: start afresh, with what was loaded counting as saved.
    timers.forEach(clearTimeout);
    timers.clear();
    chatDirty.clear();
    taskDirty.clear();
    taskGone.clear();
    shellDirty.clear();
    uiDirty = false;
    SAVE_KINDS.forEach((k) => (failures[k] = 0));
    squeeze.clear();
    unsaveable.clear();
    savedAgents.clear();
    s.agents.forEach(markAgentSaved);
    projectId = s.projectId;
    scope = s.projectId === "demo" ? null : scopeOf(s.projectId);
    return;
  }
  if (!scope) return;
  const at = projectId;

  if (s.agents !== prev.agents) {
    const before = new Map(prev.agents.map((a) => [a.id, a]));
    for (const agent of s.agents) {
      // Changes from anywhere but the agent's form (the connectors page,
      // "Always allow", a model the program reports) are saved as not
      // reviewed: a record changed outside the app stays distrusted.
      if (before.get(agent.id) === agent) continue;
      const json = agentJson(agent);
      if (savedAgents.get(agent.id) === json) continue;
      savedAgents.set(agent.id, json);
      enqueue(() =>
        agentSave(at, JSON.parse(json) as Agent).then(
          (saved) => noteTrust(at, agent.id, saved),
          (e) => {
            // Tried again with its next change; the user hears about each failure.
            if (savedAgents.get(agent.id) === json) savedAgents.delete(agent.id);
            notify(`${agent.name}'s settings could not be saved: ${e}`);
          },
        ),
      );
    }
  }

  if (s.chats !== prev.chats) {
    for (const [agentId, items] of Object.entries(s.chats)) {
      const old = prev.chats[agentId];
      if (items === old) continue;
      // Items are only added or changed in place, so comparing by position finds them.
      const ids = chatDirty.get(agentId) ?? new Set<string>();
      items.forEach((it, i) => {
        if (old?.[i] !== it) ids.add(it.id);
      });
      if (ids.size) chatDirty.set(agentId, ids);
    }
    if (chatDirty.size) later("chats");
  }

  if (s.tasks !== prev.tasks) {
    const before = new Map(prev.tasks.map((t) => [t.id, t]));
    for (const t of s.tasks) {
      if (before.get(t.id) !== t) taskDirty.add(t.id);
      before.delete(t.id);
    }
    for (const id of before.keys()) {
      taskGone.add(id);
      taskDirty.delete(id);
    }
    later("tasks");
  }

  if (s.shells !== prev.shells) {
    for (const id of Object.keys(s.shells)) if (s.shells[id] !== prev.shells[id]) shellDirty.add(id);
    later("shells");
  }

  if (
    s.selectedId !== prev.selectedId ||
    s.openTabs !== prev.openTabs ||
    s.activePath !== prev.activePath ||
    s.drafts !== prev.drafts ||
    s.collapsed !== prev.collapsed
  ) {
    uiDirty = true;
    later("ui");
  }
});

if (typeof window !== "undefined") {
  window.addEventListener("blur", () => void flushSaves());
  window.addEventListener("beforeunload", () => void flushSaves());
}

// Closing the window waits for what is still unsaved, at most a few seconds, so
// a stuck write can never keep the window open. Tauri then closes it.
if (inTauri) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested(() =>
      Promise.race([flushSaves().catch(() => undefined), new Promise((done) => setTimeout(done, 3000))]).then(() => undefined),
    ),
  );
}

// ---- Ending what was in flight ----

/**
 * What an agent was in the middle of when it stopped with the app (`quit`) or
 * with its project: open questions close (nobody can answer them any more),
 * replies stop streaming, live activity ends, and queued messages go back to
 * the message box unsent.
 */
export function settleChat(items: ChatItem[], quit: boolean): { items: ChatItem[]; changed: ChatItem[]; returned: string[] } {
  const changed: ChatItem[] = [];
  const returned: string[] = [];
  const next = items.map((it): ChatItem => {
    let fixed: ChatItem = it;
    if (it.kind === "permission" && it.state === "open") fixed = { ...it, state: "denied", ...(quit ? { closed: "quit" as const } : {}) };
    else if (it.kind === "agent" && it.streaming) fixed = { ...it, streaming: false };
    else if (it.kind === "user" && it.delivery === "queued") {
      fixed = { ...it, delivery: "returned" };
      returned.push(it.text);
    } else if (it.kind === "activity" && it.entries.some((e) => e.live)) {
      fixed = { ...it, entries: it.entries.map((e) => (e.live ? { ...e, live: false, result: "stopped" } : e)) };
    }
    if (fixed !== it) changed.push(fixed);
    return fixed;
  });
  return { items: next, changed, returned };
}

/** Puts messages that were never sent back in front of the draft. */
export const withReturned = (draft: string | undefined, returned: string[]) =>
  returned.length ? [...returned, ...(draft?.trim() ? [draft.trim()] : [])].join("\n\n") : (draft ?? "");

/** A task its agent was working on when it stopped: back to do, with why. */
export const settleTask = (t: Task, flag: "stopped" | "quit"): Task =>
  t.status === "doing" ? { ...t, status: "todo", flag, updated: Date.now() } : t;

/** Ends what the open project's agents were doing, before another project opens (they stop). */
export function settleOpenProject() {
  const s = useStore.getState();
  const chats: Record<string, ChatItem[]> = {};
  const drafts = { ...s.drafts };
  for (const [agentId, items] of Object.entries(s.chats)) {
    const settled = settleChat(items, false);
    chats[agentId] = settled.changed.length ? settled.items : items;
    if (settled.returned.length) drafts[agentId] = withReturned(drafts[agentId], settled.returned);
  }
  useStore.setState({ chats, drafts, tasks: s.tasks.map((t) => settleTask(t, "stopped")) });
}

// ---- Loading ----

const KINDS = new Set(["user", "agent", "activity", "handoff", "permission", "note"]);
const STATUSES = new Set(["todo", "doing", "check", "done"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Rows as the interface wrote them; anything else (edited outside the app) is left out rather than breaking the view. */
const isChatItem = (v: unknown): v is ChatItem =>
  isObject(v) && typeof v.id === "string" && KINDS.has(v.kind as string) && (v.kind !== "activity" || Array.isArray(v.entries));
const isTask = (v: unknown): v is Task =>
  isObject(v) && typeof v.id === "string" && typeof v.title === "string" && STATUSES.has(v.status as string);

interface SavedShell {
  title: string;
  data: string;
}

/**
 * Loads what was saved for a project, cleaning up after a quit (see
 * settleChat) and saving those fixes at once. A part that fails to load is
 * left empty and reported, so the project still opens.
 */
export async function loadProject(project: Project): Promise<ProjectData> {
  const at = scopeOf(project.id);
  const problems: string[] = [];
  const attempt = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      problems.push(`${what} (${e})`);
      return fallback;
    }
  };

  const saved = await attempt("its agents", () => agentsList(project.id), []);
  // One at today's spending limit says so from the start (the core marks it).
  const agents: Agent[] = saved.map((s) => ({ ...s.agent, status: s.agent.status === "limited" ? "limited" : "idle" }));
  const agentTrust: ProjectData["agentTrust"] = {};
  for (const s of saved) if (s.trust === "changed-outside") agentTrust[s.agent.id] = s.trust;

  const [ui, savedTasks, chatLists, shellDocs, usage] = await Promise.all([
    attempt("its layout", () => storeGet<Json>(at, "ui"), null),
    attempt("its tasks", () => itemsLoad<Json>(at, "tasks", TASK_KEEP), []),
    Promise.all(agents.map((a) => attempt(`${a.name}'s chat`, () => itemsLoad<Json>(at, chatList(a.id), CHAT_KEEP), []))),
    Promise.all(agents.map((a) => attempt(`${a.name}'s shell`, () => storeGet<Json>(at, shellKey(a.id)), null))),
    attempt("today's spending", () => loadUsage(project.id, agents.map((a) => a.id)), {}),
  ]);
  const view = (ui as unknown as ProjectUi | null)?.v === 1 ? (ui as unknown as ProjectUi) : null;
  const ids = new Set(agents.map((a) => a.id));

  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(view?.drafts ?? {})) if (ids.has(id) && typeof text === "string") drafts[id] = text;

  const chats: Record<string, ChatItem[]> = {};
  const shells: Record<string, ShellState> = {};
  const fixes: Promise<unknown>[] = [];
  agents.forEach((agent, i) => {
    const settled = settleChat((chatLists[i] as unknown[]).filter(isChatItem), true);
    chats[agent.id] = settled.items;
    if (settled.returned.length) drafts[agent.id] = withReturned(drafts[agent.id], settled.returned);
    const rows = rowsOf(chatList(agent.id), settled.changed);
    if (rows.length) fixes.push(itemsPut(at, chatList(agent.id), rows, CHAT_KEEP));
    const shell = shellDocs[i] as unknown as SavedShell | null;
    const data = typeof shell?.data === "string" ? shell.data : "";
    shells[agent.id] = { title: typeof shell?.title === "string" ? shell.title : "", data, total: data.length };
  });

  const valid = (savedTasks as unknown[]).filter(isTask).map((t) => {
    const { cost, ...task } = t;
    const counted = typeof cost === "number" && Number.isFinite(cost) && cost > 0;
    return { ...task, notes: typeof t.notes === "string" ? t.notes : "", ...(counted ? { cost } : {}) };
  });
  const tasks = valid.map((t) => settleTask(t, "quit"));
  const fixedTasks = tasks.filter((t, i) => t !== valid[i]);
  const taskRows = rowsOf("tasks", fixedTasks);
  if (taskRows.length) fixes.push(itemsPut(at, "tasks", taskRows, TASK_KEEP));
  if (fixes.length) await attempt("its clean-up", () => Promise.all(fixes), []);

  if (problems.length) notify(`Some of ${project.name} could not be loaded: ${problems.join(", ")}.`);

  const selectedId = view?.selectedId && ids.has(view.selectedId) ? view.selectedId : (agents[0]?.id ?? null);
  return {
    projectId: project.id,
    name: project.name,
    agents,
    agentTrust,
    chats,
    shells,
    tasks,
    usage,
    selectedId,
    following: null,
    drafts,
    collapsed: view?.collapsed ?? {},
    openTabs: Array.isArray(view?.openTabs) ? view.openTabs : [],
    activePath: view?.activePath ?? null,
  };
}

/** Deletes what the interface saved for an agent: its chat and shell. */
export async function forgetAgentData(agentId: string) {
  if (!scope) return;
  const at = scope;
  chatDirty.delete(agentId);
  shellDirty.delete(agentId);
  savedAgents.delete(agentId);
  enqueue(() => itemsDelete(at, chatList(agentId), null));
  enqueue(() => storeSet(at, shellKey(agentId), null));
  await queue;
}
