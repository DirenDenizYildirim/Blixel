// Tasks: things to do, for one agent or for anyone. A message sent as a Task
// becomes one; it is "doing" while its agent's turn runs and waits in "check"
// when the agent says it finished. Only the user marks a task done.

import { isOpen, openView, useLayout } from "./layout";
import { sendToAgent } from "./mock-agent";
import { sendToRealAgent } from "./real-agent";
import { storeGet, storeSet } from "./core-api";
import { agentById, uid, useStore } from "./store";
import type { AgentStatus, ChatItem, Task, TaskStatus } from "./types";
import { taskJoinsTurn } from "./usage";

const get = useStore.getState;

/** Tasks whose current send is being followed through the agent's turn (not saved: a quit flags them instead). */
const tracked = new Set<string>();
/** Tracked tasks whose message waited for the agent's turn to end. */
const waited = new Set<string>();

useStore.subscribe((s, prev) => {
  if (s.epoch !== prev.epoch) {
    tracked.clear();
    waited.clear();
  }
});

function patchTask(id: string, patch: Partial<Task>) {
  useStore.setState({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...patch, updated: Date.now() } : t)) });
}

/** Its agent starts on it: the task is "doing", and what the agent's turn spends from now on goes to it. */
function startDoing(task: Task) {
  patchTask(task.id, { status: "doing" });
  if (task.agentId) taskJoinsTurn(task.agentId, task.id);
}

function addTask(t: Pick<Task, "title" | "notes" | "agentId"> & Partial<Task>): Task {
  const now = Date.now();
  const task: Task = { status: "todo", createdBy: "user", sentItemId: null, flag: null, ...t, id: uid("t"), created: now, updated: now };
  useStore.setState({ tasks: [...get().tasks, task] });
  return task;
}

/** A task's title and notes from a message: its first line (shortened), and the rest. */
export function splitMessage(text: string): { title: string; notes: string } {
  const body = text.trim();
  const [first, ...rest] = body.split("\n");
  const line = first.trim();
  if (line.length <= 80) return { title: line, notes: rest.join("\n").trim() };
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return { title: `${space > 40 ? cut.slice(0, space) : cut}…`, notes: body };
}

// ---- What the user does ----

/** Adds a task without sending it; `agentId` null leaves it for anyone. giveTask sends it. */
export async function createTask(t: { title: string; notes?: string; agentId: string | null }): Promise<Task | null> {
  const title = t.title.trim();
  if (!title) return null;
  return addTask({ title, notes: t.notes?.trim() ?? "", agentId: t.agentId });
}

/** Sends a task to an agent as a task message, as the message box's Task mode does. */
export async function giveTask(taskId: string, agentId: string) {
  const task = get().tasks.find((t) => t.id === taskId);
  const agent = agentById(agentId);
  if (!task || !agent) return;
  patchTask(taskId, { agentId, status: "todo", flag: null });
  const text = task.notes.trim() ? `${task.title}\n\n${task.notes.trim()}` : task.title;
  if (agent.placeholder) sendToAgent(agentId, text, true, taskId);
  else await sendToRealAgent(agentId, text, true, taskId);
}

export function setTaskStatus(taskId: string, status: TaskStatus) {
  // The user's word ends following the agent's turn for it.
  tracked.delete(taskId);
  waited.delete(taskId);
  patchTask(taskId, { status, flag: null });
}

export function editTask(taskId: string, patch: { title?: string; notes?: string }) {
  const title = patch.title?.trim();
  patchTask(taskId, { ...patch, ...(title !== undefined ? { title: title || "Untitled task" } : {}) });
}

export function removeTask(taskId: string) {
  tracked.delete(taskId);
  waited.delete(taskId);
  useStore.setState({ tasks: get().tasks.filter((t) => t.id !== taskId) });
}

/** Its agent was removed: its tasks stay, for anyone, with a note why. */
export function releaseTasksOf(agentId: string) {
  const now = Date.now();
  useStore.setState({
    tasks: get().tasks.map((t) => {
      if (t.agentId !== agentId) return t;
      tracked.delete(t.id);
      waited.delete(t.id);
      const open = t.status !== "done";
      return { ...t, agentId: null, status: open ? "todo" : t.status, flag: open ? "agent-removed" : t.flag, updated: now };
    }),
  });
}

/** Open tasks (not done) of one agent, for counts. */
export const useOpenTaskCount = (agentId: string | null | undefined) =>
  useStore((s) => (agentId ? s.tasks.filter((t) => t.agentId === agentId && t.status !== "done").length : 0));

/** Whether the Tasks view is open. */
export const useTasksOpen = () => useLayout((l) => isOpen(l, "tasks"));

// ---- What the agents report (called by mock-agent.ts and real-agent.ts) ----

/** The first message sent as a Task opens the Tasks view, once. */
async function revealTasksOnce() {
  if (isOpen(useLayout.getState(), "tasks")) return;
  try {
    if (await storeGet("app", "tasksShown")) return;
    await storeSet("app", "tasksShown", true);
  } catch {
    // Without the saved flag, showing the view is still right.
  }
  openView("tasks");
}

/**
 * A message was sent to an agent as a task: links it to `taskId`, or makes a
 * task of it. Returns the task's id.
 */
export function linkTaskMessage(agentId: string, messageId: string, text: string, taskId?: string): string {
  let id = taskId;
  if (id && get().tasks.some((t) => t.id === id)) {
    patchTask(id, { agentId, sentItemId: messageId, status: "todo", flag: null });
  } else {
    id = addTask({ ...splitMessage(text), agentId, sentItemId: messageId }).id;
    void revealTasksOnce();
  }
  tracked.add(id);
  return id;
}

/** The message never reached the agent: the task stays to do, unsent. */
export function taskNotSent(messageId: string) {
  const task = get().tasks.find((t) => t.sentItemId === messageId);
  if (!task) return;
  tracked.delete(task.id);
  patchTask(task.id, { status: "todo", sentItemId: null });
}

const trackedBy = (messageId: string) => get().tasks.find((t) => t.sentItemId === messageId && tracked.has(t.id));

/** A placeholder agent began the turn for this message. */
export function taskStarted(messageId: string) {
  const task = trackedBy(messageId);
  if (task && task.status !== "doing") startDoing(task);
}

/** A placeholder agent's turn for this message ended; `worked` false when it did nothing with it. */
export function taskEnded(messageId: string, worked = true) {
  const task = trackedBy(messageId);
  if (!task) return;
  tracked.delete(task.id);
  if (task.status === "doing" || !worked) patchTask(task.id, { status: worked ? "check" : "todo" });
}

const userItem = (agentId: string, id: string | null) =>
  (get().chats[agentId] ?? []).find((it): it is Extract<ChatItem, { kind: "user" }> => it.kind === "user" && it.id === id);

/**
 * A real agent's status or queue changed. A task's message may wait for the
 * turn to end ("queued"), come back unsent ("returned"), or be sent; the
 * agent's status then says whether its turn runs, ended, or stopped. The core
 * sends waiting messages only once a turn ends, so one going out means the
 * tasks before it are finished.
 */
export function followRealAgent(agentId: string, status?: AgentStatus) {
  const agent = agentById(agentId);
  if (!agent) return;
  const mine = get().tasks.filter((t) => t.agentId === agentId && tracked.has(t.id));
  const released = mine.filter((t) => waited.has(t.id) && userItem(agentId, t.sentItemId)?.delivery === undefined);
  for (const task of mine) {
    const item = userItem(agentId, task.sentItemId);
    if (!item) continue;
    if (item.delivery === "returned") {
      tracked.delete(task.id);
      waited.delete(task.id);
      patchTask(task.id, { status: "todo", sentItemId: null, flag: "stopped" });
    } else if (item.delivery === "queued") {
      waited.add(task.id);
    } else if (released.length && !released.includes(task) && task.status === "doing") {
      tracked.delete(task.id);
      patchTask(task.id, { status: "check" });
    } else {
      waited.delete(task.id);
      const s = status ?? agent.status;
      // At its limit the agent is idle too: the turn that reached the limit finished.
      if ((s === "working" || s === "waiting") && task.status === "todo") startDoing(task);
      else if ((s === "idle" || s === "limited") && task.status === "doing") {
        tracked.delete(task.id);
        patchTask(task.id, { status: "check" });
      } else if (s === "stopped" && task.status === "doing") {
        tracked.delete(task.id);
        patchTask(task.id, { status: "todo", flag: "stopped" });
      }
    }
  }
}

/** The user stopped the agent's turn: what it was doing is not done. */
export function stopTasksOf(agentId: string) {
  for (const task of get().tasks) {
    if (task.agentId !== agentId || !tracked.has(task.id) || task.status !== "doing") continue;
    tracked.delete(task.id);
    patchTask(task.id, { status: "todo", flag: "stopped" });
  }
}

/** Tasks an agent hands another (the demo's hand-off), sent through its chat item. */
export function addHandedTask(fromId: string, toId: string, title: string, itemId: string) {
  const task = addTask({ ...splitMessage(title), agentId: toId, createdBy: `agent:${fromId}`, sentItemId: itemId });
  tracked.add(task.id);
}

/** The demo's opening task, which Kestrel is already working on. */
export function followDemoTask(messageId: string) {
  const task = get().tasks.find((t) => t.sentItemId === messageId);
  if (!task) return;
  tracked.add(task.id);
  if (task.agentId) taskJoinsTurn(task.agentId, task.id);
}
