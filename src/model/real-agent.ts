// Real agents: the core runs them and reports what it observes; this file turns
// those reports into chat, activity, editor and shell updates, and sends the
// user's messages, answers and settings back.

import { checkDisk, expectEdit, hideCaret, showAgentEdit, type AgentEdit } from "../editor/sessions";
import { inTauri } from "./backend";
import {
  agentById,
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
import type { ActivityVerb, Agent, AgentStatus, ChatItem, ModelChoice, Permission, ToolId } from "./types";

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

/** Sends the agent's settings to the core, which enforces them from then on. */
export function syncAgent(agent: Agent) {
  if (agent.placeholder) return Promise.resolve();
  return invoke<void>("upsert_agent", {
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
}

export async function sendToRealAgent(agentId: string, text: string, asTask: boolean) {
  const messageId = uid("u");
  pushChat(agentId, { kind: "user", id: messageId, text, asTask });
  try {
    await invoke<void>("send_prompt", { agentId, messageId, text: asTask ? text : `(Chat message, not a task.) ${text}` });
  } catch (e) {
    pushChat(agentId, { kind: "note", id: uid("n"), text: String(e) });
  }
}

export function cancelTurn(agentId: string) {
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
  const { listen } = await import("@tauri-apps/api/event");

  await listen<{ agentId: string; status: AgentStatus }>("agent://status", ({ payload }) => {
    setStatus(payload.agentId, payload.status);
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
    upsertActivity(a.agentId, { id: a.entryId, verb: a.verb, target: a.target, result: a.result, live: a.live, refused: a.refused });
  });

  await listen<EditEvent>("agent://edit", ({ payload }) => queueReplay(payload));

  await listen<{ agentId: string; title: string | null; data: string }>("agent://shell", ({ payload }) => {
    if (payload.title !== null) startShell(payload.agentId, payload.title);
    writeShell(payload.agentId, payload.data);
  });

  await listen<{ agentId: string; requestId: string; tool: ToolId; title: string; detail: string; alwaysOffered: boolean }>(
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

  await listen<{ agentId: string; permissions: Record<ToolId, Permission> }>("agent://settings", ({ payload }) => {
    if (agentById(payload.agentId)) updateAgent(payload.agentId, { permissions: payload.permissions });
  });

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
  });

  await listen<{ agentId: string; text: string }>("agent://note", ({ payload }) => {
    pushChat(payload.agentId, { kind: "note", id: uid("n"), text: payload.text });
  });

  // A command may have changed files: refresh the list and bring open buffers up to date.
  await listen("workspace://changed", () => {
    void refreshTree();
    void checkDisk();
  });
}
