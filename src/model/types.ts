import fallbackModels from "./fallback-models.json";
import type { AvatarStyle } from "../avatars/generator";

export type Permission = "off" | "ask" | "allow";
export type ToolId = "read" | "edit" | "run" | "commit" | "push";
export type AgentStatus = "idle" | "working" | "waiting" | "queued" | "stopped";
export type RunsOn = "hosted" | "api-key" | "self-hosted";
export type Program = "claude-code" | "codex" | "opencode";
export type Effort = "low" | "medium" | "high";

export interface Agent {
  id: string;
  name: string;
  /** What it's for, in the user's words. */
  role: string;
  avatarStyle: AvatarStyle;
  /** Colour override; null means the colour comes from the name. */
  hue: number | null;
  runsOn: RunsOn;
  program: Program;
  /** The model id the program knows it by. */
  model: string;
  effort: Effort;
  instructions: string;
  readNotes: boolean;
  permissions: Record<ToolId, Permission>;
  /** Where it may edit, as .gitignore-style patterns. Empty means the whole project. */
  editPaths: string;
  /**
   * Rule packs from mods that the user attached to this agent. Their content
   * is copied in when attached, so updating a mod never changes an agent's
   * rules without the user reviewing it.
   */
  rulePacks: AttachedRulePack[];
  canMessage: boolean;
  takesTasks: boolean;
  canGiveTo: string[];
  /** Characters per second when its edits are replayed in the editor. */
  typingSpeed: number;
  dailyLimit: string;
  whenIdle: "wait" | "pick-up";
  status: AgentStatus;
  /** Placeholder agents are scripted; they never touch a real project. */
  placeholder: boolean;
}

export interface AttachedRulePack {
  modId: string;
  packId: string;
  label: string;
  instructions: string;
  editArea: string;
  protect: string[];
  /** Of the pack's content when it was attached, to notice when the mod changes it. */
  hash: string;
}

export type ActivityVerb = "READ" | "RUN" | "EDIT" | "WRITE";

export interface ActivityEntry {
  id: string;
  verb: ActivityVerb;
  target: string;
  result: string;
  live?: boolean;
  refused?: boolean;
}

export type PermissionState = "open" | "allowed" | "always" | "denied";

export type ChatItem =
  | {
      kind: "user";
      id: string;
      text: string;
      asTask: boolean;
      /** Waiting for the agent's current turn to end, or handed back to the message box unsent. */
      delivery?: "queued" | "returned";
    }
  | { kind: "agent"; id: string; agentId: string; text: string; streaming?: boolean }
  | { kind: "activity"; id: string; entries: ActivityEntry[] }
  | { kind: "handoff"; id: string; from: string; to: string; task: string; note: string }
  | {
      kind: "permission";
      id: string;
      agentId: string;
      tool: ToolId;
      title: string;
      detail: string;
      state: PermissionState;
      /** False where the answer is not remembered, so "Always allow" is not offered. */
      alwaysOffered: boolean;
    }
  | { kind: "note"; id: string; text: string };

export interface TreeEntry {
  path: string;
  dir: boolean;
}

/** Where an agent is in a file: typing at a position, or reading a line range. */
export interface Presence {
  agentId: string;
  path: string;
  mode: "typing" | "reading";
}

export const TOOL_LABELS: Record<ToolId, { name: string; hint: string; short: string }> = {
  read: { name: "Read files", hint: "Anything in the project folder", short: "read files" },
  edit: { name: "Edit files", hint: "Changes appear live in the editor", short: "edit files" },
  run: { name: "Run commands", hint: "Tests, builds and scripts", short: "run commands" },
  commit: { name: "Commit", hint: "Source control", short: "commit" },
  push: { name: "Push and open pull requests", hint: "Source control", short: "push and pull requests" },
};

export const PROGRAM_LABELS: Record<Program, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export interface ModelChoice {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * Models offered before the program has said which it has, under the ids the
 * program takes. Once a Claude Code session runs, the list it reports replaces
 * this one; `cargo test -- --ignored` checks these ids against the pinned adapter.
 */
export const FALLBACK_MODELS: Record<Program, ModelChoice[]> = fallbackModels;
