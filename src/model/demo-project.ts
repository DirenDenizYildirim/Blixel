// The sample project the placeholder agents work in. It lives in memory, so
// nothing on disk is touched until real agents arrive.

export const DEMO_NAME = "demo project";

export const DEMO_FILES: Record<string, string> = {
  "README.md": `# Agent router

A tiny message router for a multi-agent workspace. Agents may only message
each other, or hand each other tasks, when the workspace allows it.
`,
  "package.json": `{
  "name": "agent-router",
  "private": true,
  "scripts": {
    "test": "vitest run"
  }
}
`,
  "src/agents/router.ts": `import { Agent, Message, Permission } from "./types";
import { bus } from "../bus";
import { workspace } from "../workspace";

/**
 * Routes a message from one agent to another.
 * Agents only talk to each other when the workspace allows it.
 */
export async function route(from: Agent, to: Agent, msg: Message) {
  if (!from.permissions.includes(Permission.MessageAgents)) {
    throw new PermissionError(\`\${from.name} may not message other agents\`);
  }

  if (msg.kind === "task") {
    await assertCanDelegate(from, to);
    to.queue.push({ ...msg, assignedBy: from.id });
  }

  bus.emit("message", { from: from.id, to: to.id, msg });
  return to.inbox.deliver(msg);
}
`,
  "src/agents/router.test.ts": `import { describe, expect, it } from "vitest";
import { route } from "./router";
import { makeAgent, makeTask } from "./fixtures";

describe("route", () => {
  it("blocks agents without the message permission", async () => {
    const from = makeAgent({ permissions: [] });
    await expect(route(from, makeAgent(), makeTask())).rejects.toThrow();
  });

  it("queues delegated tasks with assignedBy", async () => {
    const from = makeAgent();
    const to = makeAgent();
    await route(from, to, makeTask());
    expect(to.queue[0].assignedBy).toBe(from.id);
  });

  it("rejects delegation when no rule matches", async () => {
    const from = makeAgent({ rules: [] });
    await expect(route(from, makeAgent(), makeTask())).rejects.toThrow();
  });
});
`,
  "src/agents/types.ts": `export enum Permission {
  MessageAgents = "message-agents",
  GiveTasks = "give-tasks",
}

export interface Agent {
  id: string;
  name: string;
  permissions: Permission[];
  queue: Message[];
  inbox: { deliver(msg: Message): Promise<void> };
}

export interface Message {
  kind: "chat" | "task";
  body: string;
  assignedBy?: string;
}
`,
  "docs/permissions.md": `# Permissions

Each agent has its own settings for what it may do. Ask means the agent
stops and waits for the user.

## Messages

An agent may message another agent only with the MessageAgents permission.
`,
};
