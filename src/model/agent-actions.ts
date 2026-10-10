// What the agents' "⋯" menu does: remove, duplicate, copy to another project.
// Removing asks first, here, so every way to it does; these throw on failure.

import { agentRemove, agentSave } from "./core-api";
import { forgetAgentData } from "./persist";
import { agentsOf, freeName } from "./projects";
import { syncAgent } from "./real-agent";
import { agentById, ask, notify, uid, useStore } from "./store";
import { releaseTasksOf } from "./tasks";
import type { Agent } from "./types";

const get = useStore.getState;
const set = useStore.setState;

/** Removes an agent once the user agrees: it stops, its settings, chat and shell go, its tasks stay for anyone. */
export async function removeAgent(id: string): Promise<void> {
  const agent = agentById(id);
  if (!agent) return;
  const sure = await ask({
    title: `Remove ${agent.name}?`,
    detail: "It stops, and its settings and chat are deleted. Its tasks stay, unassigned. Files it changed stay as they are.",
    yes: "Remove",
    no: "Keep",
    danger: true,
  });
  if (!sure || !agentById(id)) return;
  const { projectId } = get();
  // The core stops it and deletes its record. Nothing of the demo is saved there.
  if (projectId !== "demo") await agentRemove(projectId, id);
  if (get().projectId !== projectId) return;
  releaseTasksOf(id);
  const s = get();
  const rest = s.agents.filter((a) => a.id !== id).map((a) => (a.canGiveTo.includes(id) ? { ...a, canGiveTo: a.canGiveTo.filter((x) => x !== id) } : a));
  const without = <T>(map: Record<string, T>) => {
    const next = { ...map };
    delete next[id];
    return next;
  };
  set({
    agents: rest,
    agentTrust: without(s.agentTrust),
    chats: without(s.chats),
    shells: without(s.shells),
    drafts: without(s.drafts),
    presence: without(s.presence),
    usage: without(s.usage),
    selectedId: s.selectedId === id ? (rest[0]?.id ?? null) : s.selectedId,
    following: s.following === id ? null : s.following,
    view: s.view.kind === "agent-form" && s.view.editingId === id ? { kind: "main" } : s.view,
  });
  await forgetAgentData(id);
}

/**
 * An agent whose saved settings were changed outside the app is not copied:
 * the copy would start trusted, with whatever was changed, before the user
 * has looked at it.
 */
export function refuseUnreviewed(agent: Agent) {
  if (get().agentTrust[agent.id]) {
    throw new Error(`${agent.name}'s saved settings were changed outside the app. Review them in its settings before copying it.`);
  }
}

/** A copy with a new id and a free name, settings only. */
function copyOf(agent: Agent, taken: string[]): Agent {
  return { ...agent, id: uid("agent"), name: freeName(`${agent.name.replace(/ \d+$/, "")} 2`, taken), status: "idle" };
}

export async function duplicateAgent(id: string): Promise<void> {
  const agent = agentById(id);
  if (!agent) return;
  refuseUnreviewed(agent);
  const copy = copyOf(agent, get().agents.map((a) => a.name));
  const { projectId } = get();
  // A real agent's copy must be known to the core before it can run; in a
  // project this also saves it (persist.ts then sees it as saved).
  await syncAgent(copy);
  if (get().projectId !== projectId) return;
  const s = get();
  set({
    agents: [...s.agents, copy],
    chats: { ...s.chats, [copy.id]: [] },
    shells: { ...s.shells, [copy.id]: { title: "", data: "", total: 0 } },
    selectedId: copy.id,
    view: { kind: "main" },
  });
  notify(`${copy.name} is a copy of ${agent.name}'s settings, without its chat.`);
}

export async function copyAgentToProject(id: string, projectId: string): Promise<void> {
  const agent = agentById(id);
  if (!agent) return;
  refuseUnreviewed(agent);
  if (projectId === get().projectId) return duplicateAgent(id);
  if (projectId === "demo" || !get().projects.some((p) => p.id === projectId)) {
    throw new Error("Agents can be copied only into saved projects.");
  }
  const there = await agentsOf(projectId);
  const name = freeName(agent.name, there.map((a) => a.name));
  // Who it may hand tasks to means agents of this project, so it starts empty there.
  await agentSave(projectId, { ...agent, id: uid("agent"), name, status: "idle", canGiveTo: [] });
}
