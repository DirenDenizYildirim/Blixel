// Real agents: the core runs them and reports what it observes; this file turns
// those reports into chat, activity, editor and shell updates, and sends the
// user's messages, answers and settings back.

import { checkDisk, expectEdit, hideCaret, showAgentEdit, type AgentEdit } from "../editor/sessions";
import { inTauri } from "./backend";
import { saveAgentNow } from "./persist";
import {
  agentById,
  notify,
  patchChat,
  pushChat,
  refreshTree,
  setDraft,
  setModels,
  setPresence,
  setStatus,
  startShell,
  uid,
  updateAgent,
  upsertActivity,
  useStore,
  writeShell,
} from "./store";
import { followRealAgent, linkTaskMessage, stopTasksOf, taskNotSent } from "./tasks";
import type { ActivityVerb, Agent, AgentStatus, ChatItem, ModelChoice, Permission, SavedAgent, ToolId } from "./types";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Whether an agent created now with these settings would be a real one. */
export function canRunForReal(agent: Pick<Agent, "runsOn" | "program">) {
  return inTauri && agent.runsOn === "api-key" && agent.program === "claude-code";
}

export async function hasApiKey(provider = "anthropic"): Promise<boolean> {
  if (!inTauri) return false;
  try {
    return await invoke<boolean>("has_api_key", { provider });
  } catch {
    return false;
  }
}

export function saveApiKey(key: string, provider = "anthropic") {
  return invoke<void>("set_api_key", { provider, key });
}

/**
 * Sends the agent's settings to the core, which enforces them from then on.
 * In a project the core also saves them (placeholders too); the demo's agents
 * are never saved. `reviewed` only for a save from the agent's form: it is
 * what makes a record changed outside the app trusted again.
 */
export async function syncAgent(agent: Agent, reviewed = false): Promise<SavedAgent | null> {
  const { projectId } = useStore.getState();
  if (projectId !== "demo") return saveAgentNow(projectId, { ...agent, status: "idle" }, reviewed);
  if (agent.placeholder) return null;
  // The demo's real agents are never saved: the core only takes their settings.
  synced.set(agent.id, settingsOf(agent));
  await invoke<void>("upsert_agent", {
    config: {
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      readNotes: agent.readNotes,
      permissions: agent.permissions,
      editPaths: agent.editPaths,
      // The copies attached to the agent, not what the mods hold now: a mod's
      // update reaches the agent only once the user reviews it.
      rulePacks: agent.rulePacks.map(({ label, instructions, editArea, protect }) => ({ label, instructions, editArea, protect })),
      model: agent.model,
      effort: agent.effort,
    },
  });
  return null;
}

// In the demo nothing is saved, but the core still needs a real agent's
// settings when something other than its form changes them (connector access,
// say). In a project, saving them (persist.ts) updates the core's copy.
const synced = new Map<string, string>();
const settingsOf = (agent: Agent) => JSON.stringify({ ...agent, status: "idle" });
useStore.subscribe((s, prev) => {
  if (s.epoch !== prev.epoch) synced.clear();
  if (s.projectId !== "demo" || s.agents === prev.agents || s.epoch !== prev.epoch) return;
  const before = new Map(prev.agents.map((a) => [a.id, a]));
  for (const agent of s.agents) {
    const old = before.get(agent.id);
    if (agent.placeholder || !old || old === agent) continue;
    const json = settingsOf(agent);
    if (json === (synced.get(agent.id) ?? settingsOf(old))) continue;
    synced.set(agent.id, json);
    syncAgent(agent).catch((e) => notify(`${agent.name}'s settings did not reach it: ${e}`));
  }
});

/** Sends the user's message; as a task, it becomes one (or is linked to `taskId`). Returns the message's id. */
export async function sendToRealAgent(agentId: string, text: string, asTask: boolean, taskId?: string): Promise<string> {
  const messageId = uid("u");
  pushChat(agentId, { kind: "user", id: messageId, text, asTask });
  if (asTask) linkTaskMessage(agentId, messageId, text, taskId);
  try {
    await invoke<void>("send_prompt", { agentId, messageId, text: asTask ? text : `(Chat message, not a task.) ${text}` });
  } catch (e) {
    pushChat(agentId, { kind: "note", id: uid("n"), text: String(e) });
    taskNotSent(messageId);
  }
  return messageId;
}

export function cancelTurn(agentId: string) {
  stopTasksOf(agentId);
  return invoke<void>("cancel_turn", { agentId }).catch((e) => pushChat(agentId, { kind: "note", id: uid("n"), text: String(e) }));
}

export function answerRealPermission(agentId: string, requestId: string, answer: "allowed" | "always" | "denied") {
  patchChat(agentId, requestId, { state: answer } as Partial<ChatItem>);
  void invoke<boolean>("answer_permission", { requestId, answer }).then((open) => {
    if (!open) pushChat(agentId, { kind: "note", id: uid("n"), text: "That request had already closed." });
  });
}

// ---- Events from the core ----

interface Activity {
  agentId: string;
  entryId: string;
  verb: ActivityVerb;
  target: string;
  result: string;
  live: boolean;
  refused: boolean;
  detail?: string | null;
}

interface EditEvent extends AgentEdit {
  entryId: string;
}

const lastPath = new Map<string, string>();
const replays = new Map<string, Promise<void>>();

/** Edits replay one after another per agent, so its cursor never jumps between two at once. */
function queueReplay(e: EditEvent) {
  // The edit is already on disk: from now on a save of this file waits for it.
  expectEdit(e.path);
  const prev = replays.get(e.agentId) ?? Promise.resolve();
  const next = prev.then(async () => {
    upsertActivity(e.agentId, { id: e.entryId, live: true, result: "typing" });
    setPresence(e.agentId, { agentId: e.agentId, path: e.path, mode: "typing" });
    lastPath.set(e.agentId, e.path);
    try {
      await showAgentEdit(e);
    } finally {
      upsertActivity(e.agentId, { id: e.entryId, live: false, result: "done" });
    }
  });
  replays.set(e.agentId, next.catch(() => undefined));
}

let started = false;

export async function listenToCore() {
  if (!inTauri || started) return;
  started = true;
  const events = await import("@tauri-apps/api/event");
  // Reports about an agent outside the open project (a late one, after
  // another project opened) are dropped, so they never land in its chats.
  const listen = <T extends { agentId: string }>(name: string, handle: (e: { payload: T }) => void) =>
    events.listen<T>(name, (e) => {
      if (agentById(e.payload.agentId)) handle(e);
    });

  await listen<{ agentId: string; status: AgentStatus }>("agent://status", ({ payload }) => {
    setStatus(payload.agentId, payload.status);
    followRealAgent(payload.agentId, payload.status);
    if (payload.status === "idle" || payload.status === "stopped") {
      const path = lastPath.get(payload.agentId);
      void (replays.get(payload.agentId) ?? Promise.resolve()).then(() => {
        if (path) hideCaret(payload.agentId, path);
        setPresence(payload.agentId, null);
      });
    }
  });

  await listen<{ agentId: string; messageId: string; text: string; done: boolean }>("agent://message", ({ payload }) => {
    const items = useStore.getState().chats[payload.agentId] ?? [];
    const existing = items.find((it) => it.id === payload.messageId);
    if (existing?.kind === "agent") {
      patchChat(payload.agentId, payload.messageId, { text: existing.text + payload.text, streaming: !payload.done } as Partial<ChatItem>);
    } else if (payload.text || !payload.done) {
      pushChat(payload.agentId, {
        kind: "agent",
        id: payload.messageId,
        agentId: payload.agentId,
        text: payload.text,
        streaming: !payload.done,
      });
    }
  });

  await listen<Activity>("agent://activity", ({ payload: a }) => {
    upsertActivity(a.agentId, {
      id: a.entryId,
      verb: a.verb,
      target: a.target,
      result: a.result,
      live: a.live,
      refused: a.refused,
      ...(a.detail ? { detail: a.detail } : {}),
    });
  });

  await listen<EditEvent>("agent://edit", ({ payload }) => queueReplay(payload));

  await listen<{ agentId: string; title: string | null; data: string }>("agent://shell", ({ payload }) => {
    if (payload.title !== null) startShell(payload.agentId, payload.title);
    writeShell(payload.agentId, payload.data);
  });

  await listen<{ agentId: string; requestId: string; tool: ToolId | `connector:${string}`; title: string; detail: string; alwaysOffered: boolean }>(
    "agent://permission",
    ({ payload: p }) => {
      pushChat(p.agentId, {
        kind: "permission",
        id: p.requestId,
        agentId: p.agentId,
        tool: p.tool,
        title: p.title,
        detail: p.detail,
        state: "open",
        alwaysOffered: p.alwaysOffered,
      });
    },
  );

  await listen<{ agentId: string; requestId: string }>("agent://permission-closed", ({ payload }) => {
    patchChat(payload.agentId, payload.requestId, { state: "denied" } as Partial<ChatItem>);
  });

  // "Always allow" changed a setting in the core: a tool's, or a connector's. Saving goes as for any change (persist.ts).
  await listen<{ agentId: string; permissions: Record<ToolId, Permission>; connectors?: Record<string, Permission> | null }>(
    "agent://settings",
    ({ payload }) => {
      updateAgent(payload.agentId, { permissions: payload.permissions, ...(payload.connectors ? { connectors: payload.connectors } : {}) });
    },
  );

  // What the program offers replaces the fallback list; the agent's model is
  // shown under the id the program uses for it.
  await listen<{ agentId: string; current: string; models: ModelChoice[] }>("agent://models", ({ payload }) => {
    const agent = agentById(payload.agentId);
    if (!agent) return;
    setModels(agent.program, payload.models);
    if (payload.current && payload.current !== agent.model) updateAgent(agent.id, { model: payload.current });
  });

  // Messages sent while the agent was busy wait for its turn to end.
  await listen<{ agentId: string; queued: string[] }>("agent://queue", ({ payload }) => {
    const queued = new Set(payload.queued);
    for (const item of useStore.getState().chats[payload.agentId] ?? []) {
      if (item.kind !== "user" || item.delivery === "returned") continue;
      const delivery = queued.has(item.id) ? "queued" : undefined;
      if (item.delivery !== delivery) patchChat(payload.agentId, item.id, { delivery } as Partial<ChatItem>);
    }
    followRealAgent(payload.agentId);
  });

  // Stopped before they went out: they go back to the message box, as typed.
  await listen<{ agentId: string; ids: string[] }>("agent://unqueued", ({ payload }) => {
    const items = useStore.getState().chats[payload.agentId] ?? [];
    const texts: string[] = [];
    for (const id of payload.ids) {
      const item = items.find((it) => it.id === id);
      if (item?.kind !== "user") continue;
      texts.push(item.text);
      patchChat(payload.agentId, id, { delivery: "returned" } as Partial<ChatItem>);
    }
    const draft = useStore.getState().drafts[payload.agentId]?.trim();
    if (texts.length) setDraft(payload.agentId, [...texts, ...(draft ? [draft] : [])].join("\n\n"));
    followRealAgent(payload.agentId);
  });

  await listen<{ agentId: string; text: string }>("agent://note", ({ payload }) => {
    pushChat(payload.agentId, { kind: "note", id: uid("n"), text: payload.text });
  });

  // A command may have changed files: refresh the list and bring open buffers up to date.
  await events.listen("workspace://changed", () => {
    void refreshTree();
    void checkDisk();
  });
}
