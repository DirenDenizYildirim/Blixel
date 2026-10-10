import fallbackModels from "./fallback-models.json";
import type { AvatarStyle } from "../avatars/generator";

export type Permission = "off" | "ask" | "allow";
export type ToolId = "read" | "edit" | "run" | "commit" | "push";
/** "limited": idle, and at its daily spending limit, so it starts nothing new until the limit is raised or the day ends. */
export type AgentStatus = "idle" | "working" | "waiting" | "queued" | "stopped" | "limited";
export type RunsOn = "hosted" | "api-key" | "self-hosted";
/** "stand-in": a test program that speaks ACP like Claude Code but follows a script; only debug builds of the core run it. */
export type Program = "claude-code" | "codex" | "opencode" | "stand-in";
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
  /** Its access to each connector, by connector id; a connector not listed is Off. */
  connectors: Record<string, Permission>;
  canMessage: boolean;
  takesTasks: boolean;
  canGiveTo: string[];
  /** Characters per second when its edits are replayed in the editor. */
  typingSpeed: number;
  /** Dollars a day, as a plain number ("5", "2.5"), or empty for no limit. The core enforces it. */
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

export type ActivityVerb = "READ" | "RUN" | "EDIT" | "WRITE" | "CALL" | "SEARCH" | "FETCH" | "TOOL";

export interface ActivityEntry {
  id: string;
  verb: ActivityVerb;
  target: string;
  result: string;
  live?: boolean;
  refused?: boolean;
  /** More about it, shown folded: a connector call's arguments, say. */
  detail?: string;
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
      /** The tool asked about, or `connector:<id>` for one of a connector's tools. */
      tool: ToolId | `connector:${string}`;
      title: string;
      detail: string;
      state: PermissionState;
      /** False where the answer is not remembered, so "Always allow" is not offered. */
      alwaysOffered: boolean;
      /** Set when it was still open as the app quit: nobody can answer it any more. */
      closed?: "quit";
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
  "stand-in": "Stand-in (testing)",
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
export const FALLBACK_MODELS: Record<Program, ModelChoice[]> = {
  ...fallbackModels,
  // The stand-in has no models; the core reports what it offers after its first session.
  "stand-in": [{ id: "stand-in", name: "Stand-in" }],
};

// ---- Projects, tasks, connectors and settings (saved by the core) ----

/** A folder the user works in, with its own agents, chats and tasks. The demo has the id "demo" and is never saved. */
export interface Project {
  id: string;
  name: string;
  folder: string;
  created: number;
  lastOpened: number;
  /** Its folder is gone or moved; "Locate…" points the project at it again. */
  missing?: boolean;
  /** "changed-outside": its saved record (its folder, say) was changed by something other than the app. */
  trust?: "ok" | "changed-outside";
}

/**
 * An agent as the core keeps it. "changed-outside" means its saved record was
 * changed by something other than the app (its keyed check failed), so every
 * Allow was lowered to Ask until the user reviews it.
 */
export interface SavedAgent {
  agent: Agent;
  trust: "ok" | "changed-outside";
}

export type TaskStatus = "todo" | "doing" | "check" | "done";

/**
 * Something to do, for one agent or for anyone (agentId null). Only the user
 * marks a task done: when an agent says it finished, the task waits in
 * "check" for the user.
 */
export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  agentId: string | null;
  createdBy: "user" | `agent:${string}`;
  created: number;
  updated: number;
  /** The chat item that sent it to its agent, if it was sent. */
  sentItemId: string | null;
  /** Why it needs a look: its agent stopped, was removed, or the app quit while it ran. */
  flag: null | "stopped" | "agent-removed" | "quit";
  /** Dollars its agent's turns spent on it so far; missing when nothing was. */
  cost?: number;
}

/** An environment variable or header of a connector. Secret values live in the keychain and never come back. */
export interface ConnectorVar {
  name: string;
  /** Empty for a secret; the core keeps its value. */
  value: string;
  secret: boolean;
  /** For a secret: whether a value is stored. */
  isSet?: boolean;
}

export type ConnectorTransport =
  | { kind: "command"; command: string; args: string[]; env: ConnectorVar[] }
  | { kind: "url"; url: string; headers: ConnectorVar[] };

/** An MCP server the user added, shared by every project. Agents reach it only through the app. */
export interface Connector {
  id: string;
  /** Fixed when it is created; its tools reach agents as `mcp__<slug>__<tool>`. */
  slug: string;
  name: string;
  /** The template it was made from, or null for a custom one. */
  template: string | null;
  created: number;
  transport: ConnectorTransport;
  /** The hash of its tool definitions when the user approved them. */
  approvedHash: string | null;
  trust: "ok" | "changed-outside";
}

export interface ConnectorTool {
  name: string;
  description: string;
  readOnly?: boolean;
  destructive?: boolean;
  /** What the tool takes, as a JSON schema (cleaned by the core). Approving the tools approves these too. */
  inputSchema?: unknown;
}

export type ConnectorState =
  | { kind: "unchecked" | "checking" }
  | { kind: "ok" | "changed"; tools: ConnectorTool[]; hash: string }
  | { kind: "failed"; reason: string; retriesLeft: number }
  | { kind: "sign-in"; reason: string };

export interface EditorSettings {
  fontSize: number;
  tabSize: 2 | 4 | 8;
  indent: "spaces" | "tabs";
  wordWrap: boolean;
  lineNumbers: boolean;
  activeLine: boolean;
  ligatures: boolean;
  /** How agents' edits show in the editor: typed out at their speed, or at once. */
  agentEdits: "typed" | "instant";
}

/** What a new agent starts with. */
export interface NewAgentDefaults {
  permissions: Record<ToolId, Permission>;
  model: string;
  effort: Effort;
  typingSpeed: number;
  whenIdle: "wait" | "pick-up";
  readNotes: boolean;
  instructions: string;
}

export interface AppSettings {
  v: 1;
  editor: EditorSettings;
  newAgent: NewAgentDefaults;
}

/** What the interface remembers per project. */
export interface ProjectUi {
  v: 1;
  selectedId: string | null;
  openTabs: string[];
  activePath: string | null;
  drafts: Record<string, string>;
  collapsed: Record<string, boolean>;
}

export const DEFAULT_EDITOR: EditorSettings = {
  fontSize: 14,
  tabSize: 2,
  indent: "spaces",
  wordWrap: false,
  lineNumbers: true,
  activeLine: true,
  ligatures: true,
  agentEdits: "typed",
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  v: 1,
  editor: DEFAULT_EDITOR,
  newAgent: {
    permissions: { read: "allow", edit: "allow", run: "ask", commit: "ask", push: "ask" },
    model: FALLBACK_MODELS["claude-code"][0].id,
    effort: "medium",
    typingSpeed: 12,
    whenIdle: "wait",
    readNotes: true,
    instructions: "",
  },
};
