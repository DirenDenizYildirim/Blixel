// Scripted placeholder agents. They exercise the real permission checks, path
// limits, activity log, shells and typing replay, but only ever in the demo
// project. Real agents will replace this file's scripts, not its rules.

import { expectEdit, hideCaret, showAgentEdit, showReading } from "../editor/sessions";
import { isProtected, mayEdit } from "./paths";
import {
  agentById,
  getBackend,
  logActivity,
  patchActivity,
  patchChat,
  pushChat,
  refreshTree,
  setPresence,
  setStatus,
  startShell,
  uid,
  updateAgent,
  useStore,
  writeShell,
} from "./store";
import type { ActivityVerb, ChatItem, PermissionState, ToolId } from "./types";

type Answer = Exclude<PermissionState, "open">;

const waiting = new Map<string, (answer: Answer) => void>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The user's answer to a permission request shown in chat. */
export function answerPermission(agentId: string, itemId: string, answer: Answer) {
  const item = useStore.getState().chats[agentId]?.find((it) => it.id === itemId);
  if (item?.kind !== "permission" || item.state !== "open") return;
  patchChat(agentId, itemId, { state: answer });
  if (answer === "always") {
    const agent = agentById(agentId);
    if (agent) updateAgent(agentId, { permissions: { ...agent.permissions, [item.tool]: "allow" } });
  }
  waiting.get(itemId)?.(answer);
  waiting.delete(itemId);
}

class Script {
  /** The last file the agent typed in, where its cursor still shows. */
  private lastPath: string | null = null;

  constructor(readonly agentId: string) {}

  get agent() {
    return agentById(this.agentId)!;
  }

  status(status: Parameters<typeof setStatus>[1]) {
    setStatus(this.agentId, status);
  }

  pause(ms: number) {
    return sleep(ms);
  }

  /** Streams a reply into the agent's chat. */
  async say(text: string, to: string = this.agentId) {
    const id = uid("m");
    pushChat(to, { kind: "agent", id, agentId: this.agentId, text: "", streaming: true });
    for (let i = 0; i < text.length; i += 3) {
      patchChat(to, id, { text: text.slice(0, i + 3) } as Partial<ChatItem>);
      await sleep(18);
    }
    patchChat(to, id, { text, streaming: false } as Partial<ChatItem>);
  }

  log(verb: ActivityVerb, target: string, result: string, live = false, refused = false) {
    return logActivity(this.agentId, { verb, target, result, live, refused });
  }

  /** Applies the agent's setting for a tool. Ask shows a request and waits for the user. */
  async gate(tool: ToolId, title: string, detail: string, forceAsk = false): Promise<boolean> {
    const setting = this.agent.permissions[tool];
    if (setting === "off" && !forceAsk) return false;
    if (setting === "allow" && !forceAsk) return true;
    const id = uid("p");
    // A forced question (agent settings files) is asked every time, so "Always allow" is not offered.
    pushChat(this.agentId, { kind: "permission", id, agentId: this.agentId, tool, title, detail, state: "open", alwaysOffered: !forceAsk });
    this.status("waiting");
    const answer = await new Promise<Answer>((resolve) => waiting.set(id, resolve));
    this.status("working");
    return answer !== "denied";
  }

  async read(path: string, fromLine = 1, toLine = 1) {
    if (!(await this.gate("read", `${this.agent.name} is asking to read a file`, path))) {
      this.log("READ", path, "not allowed", false, true);
      return false;
    }
    const entry = this.log("READ", path, "reading", true);
    setPresence(this.agentId, { agentId: this.agentId, path, mode: "reading" });
    await showReading(this.agentId, path, fromLine, toLine);
    await sleep(1600);
    hideCaret(this.agentId, path);
    setPresence(this.agentId, null);
    patchActivity(this.agentId, entry, { result: "done", live: false });
    return true;
  }

  /** Replaces `find` with `replace` in a file, creating the file when `find` is empty. */
  async edit(path: string, find: string, replace: string): Promise<boolean> {
    const name = this.agent.name;
    // Its own area and every attached rule pack's must allow the edit, as in the core.
    const packs = this.agent.rulePacks;
    if (!mayEdit(path, this.agent.editPaths) || packs.some((p) => p.editArea.trim() && !mayEdit(path, p.editArea))) {
      this.log("EDIT", path, "outside its area", false, true);
      return false;
    }
    const packProtects = packs.some((p) => p.protect.length > 0 && mayEdit(path, p.protect.join("\n")));
    if (this.agent.permissions.edit === "off") {
      this.log("EDIT", path, "not allowed", false, true);
      return false;
    }
    const allowed = isProtected(path)
      ? await this.gate("edit", `${name} wants to change an agent settings file`, path, true)
      : packProtects
        ? await this.gate("edit", `${name} wants to change a file its rules protect`, path, true)
        : await this.gate("edit", `${name} is asking to edit a file`, path);
    if (!allowed) {
      this.log("EDIT", path, "not allowed", false, true);
      return false;
    }

    const backend = getBackend();
    let disk = "";
    try {
      disk = await backend.read(path);
    } catch {
      if (find) {
        this.log("EDIT", path, "file not found", false, true);
        return false;
      }
    }
    const at = disk.indexOf(find);
    if (at < 0) {
      this.log("EDIT", path, "text not found", false, true);
      return false;
    }
    // The file on disk changes at once; the editor replays it as typing.
    const next = disk.slice(0, at) + replace + disk.slice(at + find.length);
    expectEdit(path);
    await backend.write(path, next);
    if (!disk) await refreshTree();

    let pre = 0;
    while (pre < find.length && pre < replace.length && find[pre] === replace[pre]) pre++;
    // Report the first line with new text, not a blank line before it.
    const lead = replace.slice(pre).match(/^\n*/)![0].length;
    const line = next.slice(0, at + pre + lead).split("\n").length;
    const entry = this.log("EDIT", `${path.split("/").pop()}, line ${line}`, "typing", true);
    setPresence(this.agentId, { agentId: this.agentId, path, mode: "typing" });
    this.lastPath = path;
    await showAgentEdit({ agentId: this.agentId, path, before: disk, find, replace, replaceAll: false });
    patchActivity(this.agentId, entry, { result: "done", live: false });
    return true;
  }

  async run(command: string, output: string[], result: string, tool: ToolId = "run") {
    if (!(await this.gate(tool, `${this.agent.name} is asking to run a command`, command))) {
      this.log("RUN", command, "not allowed", false, true);
      return false;
    }
    const entry = this.log("RUN", command, "running", true);
    startShell(this.agentId, command);
    writeShell(this.agentId, `\x1b[90m$ ${command}\x1b[0m\r\n`);
    for (const line of output) {
      await sleep(140);
      writeShell(this.agentId, line + "\r\n");
    }
    patchActivity(this.agentId, entry, { result, live: false });
    return true;
  }

  handoff(toId: string, task: string, note: string) {
    const item = { kind: "handoff" as const, from: this.agentId, to: toId, task, note };
    pushChat(this.agentId, { ...item, id: uid("h") });
    pushChat(toId, { ...item, id: uid("h") });
  }

  done() {
    if (this.lastPath) hideCaret(this.agentId, this.lastPath);
    setPresence(this.agentId, null);
    this.status("idle");
  }
}

// ---- Scenes ----

const ROUTER = "src/agents/router.ts";
const DOCS = "docs/permissions.md";

const PASSING = [
  "\x1b[42;30;1m PASS \x1b[0m src/agents/router.test.ts",
  "  \x1b[32mpass\x1b[0m blocks agents without the message permission",
  "  \x1b[32mpass\x1b[0m queues delegated tasks with assignedBy",
  "  \x1b[32mpass\x1b[0m rejects delegation when no rule matches",
  "\x1b[90mTests: 3 passed, 3 total\x1b[0m",
];

const queues = new Map<string, Promise<void>>();

/** Runs a job after everything the agent is already doing. */
function enqueue(agentId: string, job: () => Promise<void>) {
  const prev = queues.get(agentId) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => console.error(e));
  queues.set(agentId, next);
  void next.then(() => {
    if (queues.get(agentId) === next) queues.delete(agentId);
  });
}

let opened = false;

/** The moment the main screen design shows, played live: Kestrel finishing the delegation check. */
export function playOpeningScene() {
  if (opened || useStore.getState().workspace.kind !== "demo") return;
  opened = true;
  enqueue("kestrel", openingScene);
}

async function openingScene() {
  const kestrel = new Script("kestrel");
  const moth = new Script("moth");
  await sleep(1200);

  const mothReads = moth.read(ROUTER, 15, 16);
  await kestrel.edit(
    ROUTER,
    "  return to.inbox.deliver(msg);\n}\n",
    "  return to.inbox.deliver(msg);\n}\n\nfunction assertCanDelegate(from: Agent, to: Agent) {\n" +
      "  const rule = workspace.rules.find((r) => r.from === from.id && r.to === to.id);\n" +
      "  if (!rule) {\n    throw new PermissionError(`${from.name} may not hand tasks to ${to.name}`);\n  }\n}\n",
  );
  await mothReads;
  moth.status("queued");

  kestrel.handoff(
    "moth",
    "Update docs/permissions.md to describe delegation rules once router.ts lands.",
    "Moth accepted. Queued until the tests pass.",
  );
  await kestrel.pause(600);
  const passed = await kestrel.run("npm test -- router", PASSING, "3 passed");
  if (passed) enqueue("moth", () => mothWritesDocs(moth));

  await kestrel.say("The check is in and all three router tests pass. I'd like to commit it.");
  const committed = await kestrel.run(
    'git commit -m "Add delegation check"',
    ["[main 4f2a9c1] Add delegation check", " 1 file changed, 7 insertions(+)"],
    "committed",
    "commit",
  );
  await kestrel.say(
    committed
      ? "Committed. Moth is updating the docs to match."
      : "Okay, I left it uncommitted. The change is saved in router.ts for you to review.",
  );
  kestrel.done();
}

async function mothWritesDocs(moth: Script) {
  await sleep(800);
  moth.status("working");
  await moth.say("Kestrel's tests pass, so I'm starting on the delegation docs.");
  await moth.read(DOCS, 7, 9);
  const ok = await moth.edit(
    DOCS,
    "the MessageAgents permission.\n",
    "the MessageAgents permission.\n\n## Delegation\n\n" +
      "An agent may hand a task to another agent only when a workspace rule\nallows that pair. Without a matching rule, route() refuses the task.\n",
  );
  await moth.say(ok ? "Done. docs/permissions.md now explains delegation rules." : "I couldn't edit the docs.");
  moth.done();
}

// ---- Messages from the user ----

/** Sends the user's message to a placeholder agent, queued behind anything it is doing. */
export function sendToAgent(agentId: string, text: string, asTask: boolean) {
  pushChat(agentId, { kind: "user", id: uid("u"), text, asTask });
  if (queues.has(agentId)) {
    pushChat(agentId, { kind: "note", id: uid("n"), text: `Queued until ${agentById(agentId)?.name} finishes.` });
  }
  enqueue(agentId, () => respond(agentId, text, asTask));
}

async function respond(agentId: string, text: string, asTask: boolean) {
  const s = new Script(agentId);
  s.status("working");
  await sleep(500);
  if (useStore.getState().workspace.kind !== "demo") {
    await s.say(
      "I'm a placeholder agent, so I won't touch a real project. Open the demo project to watch me work.",
    );
    return s.done();
  }
  if (!asTask) {
    await s.say(
      "I'm a placeholder, so I can only act out a scripted task. Send this as a Task to watch me read, edit and run commands under the settings you gave me.",
    );
    return s.done();
  }

  const notes = "docs/notes.md";
  await s.say(`On it. I'll note "${text.slice(0, 80)}" in ${notes} and run the tests.`);
  await s.read("README.md", 1, 4);
  let existing = "";
  try {
    existing = await getBackend().read(notes);
  } catch {
    existing = "";
  }
  const line = `- ${s.agent.name}: ${text.replace(/\s+/g, " ").trim()}\n`;
  const edited = existing
    ? await s.edit(notes, existing, existing + line)
    : await s.edit(notes, "", `# Notes\n\n${line}`);
  if (!edited) {
    await s.say(`I couldn't edit ${notes}. The activity log above says why.`);
    return s.done();
  }
  const tested = await s.run("npm test", PASSING, "3 passed");
  await s.say(
    tested
      ? `Done. I added a line to ${notes} and the tests still pass.`
      : `I added a line to ${notes}, but I wasn't allowed to run the tests.`,
  );
  s.done();
}
