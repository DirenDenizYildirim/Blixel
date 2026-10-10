import { DEMO_NAME } from "./demo-project";
import type { ProjectData } from "./store";
import type { Agent, ChatItem, Task } from "./types";

const base: Omit<Agent, "id" | "name" | "role" | "program" | "runsOn" | "model" | "status"> = {
  avatarStyle: "pixelblob",
  hue: null,
  effort: "medium",
  instructions: "",
  readNotes: true,
  permissions: { read: "allow", edit: "allow", run: "allow", commit: "ask", push: "ask" },
  editPaths: "",
  rulePacks: [],
  connectors: {},
  canMessage: true,
  takesTasks: true,
  canGiveTo: [],
  typingSpeed: 12,
  dailyLimit: "",
  whenIdle: "pick-up",
  placeholder: true,
};

export const PLACEHOLDER_AGENTS: Agent[] = [
  {
    ...base,
    id: "kestrel",
    name: "Kestrel",
    role: "Builds the agent router",
    program: "claude-code",
    runsOn: "api-key",
    model: "sonnet",
    status: "working",
    canGiveTo: ["moth"],
    instructions: "You own src/agents. Keep changes small and covered by tests.",
  },
  {
    ...base,
    id: "moth",
    name: "Moth",
    role: "Keeps the docs in step with the code",
    program: "codex",
    runsOn: "hosted",
    model: "gpt-5.6",
    status: "queued",
    avatarStyle: "goo",
    editPaths: "docs/**",
    instructions: "You write and maintain the docs. Only edit files in docs/.",
  },
  {
    ...base,
    id: "juno",
    name: "Juno",
    role: "Reviews changes before they land",
    program: "opencode",
    runsOn: "self-hosted",
    model: "qwen3-coder",
    status: "idle",
    avatarStyle: "blob",
    permissions: { read: "allow", edit: "ask", run: "ask", commit: "off", push: "off" },
  },
];

export const PLACEHOLDER_CHATS: Record<string, ChatItem[]> = {
  kestrel: [
    {
      kind: "user",
      id: "k1",
      asTask: true,
      text: "Agents should only hand tasks to each other when a workspace rule allows it. Add the check and a test.",
    },
    {
      kind: "agent",
      id: "k2",
      agentId: "kestrel",
      text: "On it. I'll add assertCanDelegate to router.ts and cover the no-rule case in the tests.",
    },
    {
      kind: "activity",
      id: "k3",
      entries: [
        { id: "k3a", verb: "READ", target: "router.ts, types.ts", result: "done" },
        { id: "k3b", verb: "RUN", target: "npm test -- router", result: "1 failed" },
      ],
    },
  ],
  moth: [
    {
      kind: "note",
      id: "m1",
      text: "Moth is waiting for a task from Kestrel.",
    },
  ],
  juno: [],
};

/** Shell output each placeholder agent starts with. */
export const PLACEHOLDER_SHELLS: Record<string, { title: string; data: string }> = {
  kestrel: {
    title: "npm test -- router",
    data:
      "\x1b[41;30;1m FAIL \x1b[0m src/agents/router.test.ts\r\n" +
      "  \x1b[32mpass\x1b[0m blocks agents without the message permission\r\n" +
      "  \x1b[32mpass\x1b[0m queues delegated tasks with assignedBy\r\n" +
      "  \x1b[91mfail\x1b[0m rejects delegation when no rule matches\r\n" +
      "\x1b[90mTests: 1 failed, 2 passed, 3 total\x1b[0m\r\n",
  },
  moth: { title: "", data: "" },
  juno: { title: "", data: "" },
};

const started = Date.now();

/** Tasks in the demo: Kestrel's, which it finishes in the opening scene, and one for anyone. */
export const PLACEHOLDER_TASKS: Task[] = [
  {
    id: "t-kestrel",
    title: "Agents should only hand tasks to each other when a workspace rule allows it.",
    notes: "Add the check and a test.",
    status: "doing",
    agentId: "kestrel",
    createdBy: "user",
    created: started,
    updated: started,
    sentItemId: "k1",
    flag: null,
  },
  {
    id: "t-review",
    title: "Review the delegation check before it is pushed",
    notes: "",
    status: "todo",
    agentId: null,
    createdBy: "user",
    created: started,
    updated: started,
    sentItemId: null,
    flag: null,
  },
];

/** The demo as it starts, every time it opens. Nothing in it is saved. */
export function demoProject(): ProjectData {
  return {
    projectId: "demo",
    name: DEMO_NAME,
    agents: PLACEHOLDER_AGENTS,
    agentTrust: {},
    chats: PLACEHOLDER_CHATS,
    shells: Object.fromEntries(Object.entries(PLACEHOLDER_SHELLS).map(([id, s]) => [id, { ...s, total: s.data.length }])),
    tasks: PLACEHOLDER_TASKS,
    selectedId: "kestrel",
    following: "kestrel",
    drafts: {},
    collapsed: {},
    openTabs: ["src/agents/router.ts"],
    activePath: "src/agents/router.ts",
  };
}
