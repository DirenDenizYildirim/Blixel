// Spending: what each agent of the open project spent today and in its
// current turn, and what each task cost. The core counts it from what the
// agent's program reports and enforces the daily limit; this file keeps the
// numbers for the interface. The demo's scripted agents make up small costs.

import { inTauri } from "./backend";
import { usageToday } from "./core-api";
import { useStore, type AgentUsage } from "./store";
import type { Agent } from "./types";

const get = useStore.getState;
const set = useStore.setState;

// ---- The daily limit, as the user writes it ----

/**
 * A daily limit as typed: dollars, with or without "$" or "USD", rounded to
 * cents. Read as the core reads it: a comma is the decimal mark ("5,50")
 * unless there is a point too ("1,250.50"). Null for an empty field (no
 * limit); undefined when it is not an amount.
 */
export function parseLimit(text: string): number | null | undefined {
  let typed = text.trim().toLowerCase();
  if (!typed) return null;
  const before = ["us$", "$", "usd"].find((mark) => typed.startsWith(mark));
  if (before) typed = typed.slice(before.length).trim();
  const after = ["usd", "$"].find((mark) => typed.endsWith(mark));
  if (after) typed = typed.slice(0, -after.length).trim();
  const number = typed.includes(".") ? typed.replace(/,/g, "") : typed.replace(/,/g, ".");
  if (!/^\d*\.?\d*$/.test(number) || !/\d/.test(number)) return undefined;
  const usd = Math.round(Number(number) * 100) / 100;
  return Number.isFinite(usd) ? usd : undefined;
}

export const LIMIT_PROBLEM = "Write the daily limit in dollars, like 5 or 2.50, or leave it empty for no limit.";

/** How a limit is saved: a plain number the core reads ("5", "2.5"), or empty. */
export const limitText = (usd: number | null) => (usd === null ? "" : String(usd));

/** The agent's limit in dollars, or null for none (or one that cannot be read). */
export const limitOf = (agent: Pick<Agent, "dailyLimit">) => parseLimit(agent.dailyLimit) ?? null;

/** "$0.42", "$1,250.00"; "<$0.01" for less than a cent. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How close an agent is to its limit: "near" from 80%, "at" once reached (or when the core says so). */
export type SpendLevel = "ok" | "near" | "at";

export function spendLevel(agent: Pick<Agent, "dailyLimit" | "status">, today: number): SpendLevel {
  if (agent.status === "limited") return "at";
  const limit = limitOf(agent);
  if (limit === null) return "ok";
  return today >= limit ? "at" : today >= limit * 0.8 ? "near" : "ok";
}

const NONE: AgentUsage = { today: 0, turn: 0 };

/** An agent's spending as shown; nothing yet when it has spent nothing. */
export const useUsage = (agentId: string | null | undefined) => useStore((s) => (agentId ? s.usage[agentId] : undefined) ?? NONE);

/** Whether an agent's spending is worth showing: it can cost money, or the demo made some up. */
export const showsSpending = (agent: Pick<Agent, "placeholder" | "dailyLimit">, usage: AgentUsage) =>
  !agent.placeholder || usage.today > 0 || limitOf(agent) !== null;

// ---- What turns spend, and on which task ----

/**
 * The task each agent's current turn works on, and what the task had cost
 * before this turn's spending so far: the turn's cost is added to it.
 */
const turnTasks = new Map<string, { taskId: string; before: number }>();

useStore.subscribe((s, prev) => {
  if (s.epoch !== prev.epoch) turnTasks.clear();
});

const known = (agentId: string) => get().agents.some((a) => a.id === agentId);

function patchUsage(agentId: string, next: AgentUsage) {
  const usage = get().usage;
  const old = usage[agentId];
  if (old && old.today === next.today && old.turn === next.turn) return;
  set({ usage: { ...usage, [agentId]: next } });
}

function setTaskCost(taskId: string, cost: number) {
  const tasks = get().tasks;
  if (!tasks.some((t) => t.id === taskId && t.cost !== cost)) return;
  // Not counted as an edit of the task: `updated` stays as it was.
  set({ tasks: tasks.map((t) => (t.id === taskId ? { ...t, cost } : t)) });
}

/** A new turn begins for the agent: its cost starts at zero and belongs to no task until one starts. */
export function turnStarted(agentId: string) {
  turnTasks.delete(agentId);
  const usage = get().usage[agentId];
  if (usage?.turn) patchUsage(agentId, { ...usage, turn: 0 });
}

/** One of the agent's tasks is now being worked on: what the turn spends from here is added to it. */
export function taskJoinsTurn(agentId: string, taskId: string) {
  const task = get().tasks.find((t) => t.id === taskId);
  if (!task) return;
  turnTasks.set(agentId, { taskId, before: (task.cost ?? 0) - (get().usage[agentId]?.turn ?? 0) });
}

/** A cost report from the core (or a demo script): today's total and the current turn's so far, in dollars. */
export function reportUsage(agentId: string, todayUsd: number, turnUsd: number) {
  if (!known(agentId) || !Number.isFinite(todayUsd) || !Number.isFinite(turnUsd)) return;
  const prev = get().usage[agentId];
  const turnTask = turnTasks.get(agentId);
  if (prev && turnUsd < prev.turn && turnTask) {
    // A turn began that was not seen starting: the task keeps counting only if it is still being worked on.
    const task = get().tasks.find((t) => t.id === turnTask.taskId);
    if (task?.status === "doing") turnTasks.set(agentId, { taskId: task.id, before: task.cost ?? 0 });
    else turnTasks.delete(agentId);
  }
  patchUsage(agentId, { today: Math.max(0, todayUsd), turn: Math.max(0, turnUsd) });
  const charged = turnTasks.get(agentId);
  // To a millionth of a dollar, so sums of reports do not save as 0.09409999999999999.
  if (charged) setTaskCost(charged.taskId, Math.max(0, Math.round((charged.before + turnUsd) * 1e6) / 1e6));
}

// ---- Loading ----

/** Today's spending of a project's agents, as the core counted it. */
export async function loadUsage(projectId: string, agentIds: string[]): Promise<Record<string, AgentUsage>> {
  const today = await usageToday(projectId);
  const usage: Record<string, AgentUsage> = {};
  for (const id of agentIds) {
    const usd = today[id];
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) usage[id] = { today: usd, turn: 0 };
  }
  return usage;
}

/** Agents with a cost report since the last reload began: their numbers are newer than the reload's. */
const reportedSince = new Set<string>();
let lastLoad = Date.now();
let lastDay = new Date().toDateString();

/**
 * Reads today's numbers again, for a new day or a window that comes back
 * after a while. Reports that arrive meanwhile win over the answer.
 */
export async function reloadUsage() {
  const { projectId, epoch, agents } = get();
  if (projectId === "demo") return;
  reportedSince.clear();
  lastLoad = Date.now();
  lastDay = new Date().toDateString();
  let fresh: Record<string, AgentUsage>;
  try {
    fresh = await loadUsage(projectId, agents.map((a) => a.id));
  } catch {
    return;
  }
  if (get().epoch !== epoch) return;
  const usage = { ...get().usage };
  for (const a of get().agents) {
    if (reportedSince.has(a.id)) continue;
    usage[a.id] = { today: fresh[a.id]?.today ?? 0, turn: usage[a.id]?.turn ?? 0 };
  }
  set({ usage });
}

useStore.subscribe((s, prev) => {
  if (s.usage === prev.usage) return;
  for (const id of Object.keys(s.usage)) if (s.usage[id] !== prev.usage[id]) reportedSince.add(id);
});

if (inTauri) {
  // A new day starts from zero; a window back after a while may have missed a change of day.
  window.addEventListener("focus", () => {
    if (new Date().toDateString() !== lastDay || Date.now() - lastLoad > 5 * 60_000) void reloadUsage();
  });
  const atMidnight = () => {
    const next = new Date();
    next.setHours(24, 0, 5, 0);
    setTimeout(() => {
      void reloadUsage();
      atMidnight();
    }, next.getTime() - Date.now());
  };
  atMidnight();
}
