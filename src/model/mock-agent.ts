// Scripted placeholder agents. They exercise the real permission checks, path
// limits, activity log, shells and typing replay, but only ever in the demo
// project. Real agents will replace this file's scripts, not its rules.

import { expectEdit, hideCaret, showAgentEdit, showReading } from "../editor/sessions";
import { isProtected, mayEdit } from "./paths";
import {
  agentById,
  getBackend,
  logActivity,
  onWorkspaceChange,
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
import { notSent } from "./real-agent";
import { addHandedTask, followDemoTask, linkTaskMessage, taskEnded, taskStarted } from "./tasks";
import type { ActivityVerb, Agent, ChatItem, PermissionState, ToolId } from "./types";
import { formatUsd, limitOf, reportUsage, turnStarted } from "./usage";

type Answer = Exclude<PermissionState, "open">;

const waiting = new Map<string, (answer: Answer) => void>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The user's answer to a permission request shown in chat. */
export function answerPermission(agentId: string, itemId: string, answer: Answer) {
  const item = useStore.getState().chats[agentId]?.find((it) => it.id === itemId);
  if (item?.kind !== "permission" || item.state !== "open") return;
  patchChat(agentId, itemId, { state: answer });
  const agent = agentById(agentId);
  if (answer === "always" && agent) {
    const tool = item.tool;
    if (tool.startsWith("connector:")) updateAgent(agentId, { connectors: { ...agent.connectors, [tool.slice(10)]: "allow" } });
    else updateAgent(agentId, { permissions: { ...agent.permissions, [tool as ToolId]: "allow" } });
  }
  waiting.get(itemId)?.(answer);
  waiting.delete(itemId);
}

/** Thrown inside a script whose project closed, to end it quietly. */
class Stopped extends Error {}

// Another project opened: scripts waiting on the user give up, and their queues start empty.
onWorkspaceChange(() => {
  waiting.forEach((resolve) => resolve("denied"));
  waiting.clear();
  queues.clear();
});

class Script {
  /** The last file the agent typed in, where its cursor still shows. */
  private lastPath: string | null = null;
  /** The project the script runs in; its files, even if another project has opened since. */
  private readonly epoch = useStore.getState().epoch;
  private readonly backend = getBackend();

  /** The script's own project files. */
  get files() {
    return this.backend;
  }

  constructor(readonly agentId: string) {}

  get agent() {
    this.check();
    const agent = agentById(this.agentId);
    if (!agent) throw new Stopped();
    return agent;
  }

  /** Ends the script once its project is no longer open. */
  check() {
    if (useStore.getState().epoch !== this.epoch) throw new Stopped();
  }

  status(status: Parameters<typeof setStatus>[1]) {
    this.check();
    setStatus(this.agentId, status);
  }

  async pause(ms: number) {
    await sleep(ms);
    this.check();
  }

  /** A made-up cost for a step, so the demo shows spending. Placeholders cost nothing anywhere else. */
  charge(usd: number) {
    this.check();
    if (useStore.getState().projectId !== "demo") return;
    const usage = useStore.getState().usage[this.agentId] ?? { today: 0, turn: 0 };
    reportUsage(this.agentId, usage.today + usd, usage.turn + usd);
  }

  /** The start of a turn: its cost counts from zero. */
  beginTurn() {
    this.check();
    turnStarted(this.agentId);
  }

  /** Streams a reply into the agent's chat. */
  async say(text: string, to: string = this.agentId) {
    this.check();
    const id = uid("m");
    pushChat(to, { kind: "agent", id, agentId: this.agentId, text: "", streaming: true });
    for (let i = 0; i < text.length; i += 3) {
      this.check();
      patchChat(to, id, { text: text.slice(0, i + 3) } as Partial<ChatItem>);
      await sleep(18);
    }
    patchChat(to, id, { text, streaming: false } as Partial<ChatItem>);
    this.charge(0.006 + text.length * 0.0001);
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
    this.check();
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
    this.check();
    await showReading(this.agentId, path, fromLine, toLine);
    await this.pause(1600);
    hideCaret(this.agentId, path);
    setPresence(this.agentId, null);
    patchActivity(this.agentId, entry, { result: "done", live: false });
    this.charge(0.011);
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

    this.check();
    const backend = this.backend;
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
    this.charge(0.024);
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
      await this.pause(140);
      writeShell(this.agentId, line + "\r\n");
    }
    patchActivity(this.agentId, entry, { result, live: false });
    this.charge(0.009);
    return true;
  }

  /** Hands a task to another agent; returns the hand-off's id in that agent's chat. */
  handoff(toId: string, task: string, note: string) {
    this.check();
    const item = { kind: "handoff" as const, from: this.agentId, to: toId, task, note };
    const theirs = uid("h");
    pushChat(this.agentId, { ...item, id: uid("h") });
    pushChat(toId, { ...item, id: theirs });
    addHandedTask(this.agentId, toId, task, theirs);
    return theirs;
  }

  /** The turn ends; at its daily limit the agent rests until the limit is raised (as the core does for real agents). */
  done() {
    this.check();
    if (this.lastPath) hideCaret(this.agentId, this.lastPath);
    setPresence(this.agentId, null);
    this.status(atLimit(this.agent) ? "limited" : "idle");
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

/** Whether a placeholder has spent its daily limit (only the demo's ever spend anything). */
function atLimit(agent: Agent) {
  const limit = limitOf(agent);
  return limit !== null && (useStore.getState().usage[agent.id]?.today ?? 0) >= limit;
}

/** The note a refused message gets, worded as the core words it for real agents. */
function limitNote(agent: Agent) {
  const spent = useStore.getState().usage[agent.id]?.today ?? 0;
  return `${agent.name} reached today's limit of ${formatUsd(limitOf(agent) ?? 0)} (${formatUsd(spent)} spent). Raise the limit in its settings, or it can work again tomorrow.`;
}

/** After the user changed a placeholder's limit: one no longer at it is idle again. */
export function recheckLimit(agentId: string) {
  const agent = agentById(agentId);
  if (!agent?.placeholder) return;
  if (agent.status === "limited" && !atLimit(agent)) setStatus(agentId, "idle");
  else if (agent.status === "idle" && atLimit(agent)) setStatus(agentId, "limited");
}

/** Runs a job after everything the agent is already doing. */
function enqueue(agentId: string, job: () => Promise<void>) {
  const prev = queues.get(agentId) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => {
    if (!(e instanceof Stopped)) console.error(e);
  });
  queues.set(agentId, next);
  void next.then(() => {
    if (queues.get(agentId) === next) queues.delete(agentId);
  });
}

/** The moment the main screen design shows, played live: Kestrel finishing the delegation check. Plays each time the demo opens. */
export function playOpeningScene() {
  if (useStore.getState().workspace.kind !== "demo") return;
  followDemoTask(OPENING_TASK);
  enqueue("kestrel", async () => {
    try {
      await openingScene();
    } finally {
      taskEnded(OPENING_TASK);
    }
  });
}

/** The chat item of the task Kestrel works on in the opening scene. */
const OPENING_TASK = "k1";

async function openingScene() {
  const kestrel = new Script("kestrel");
  const moth = new Script("moth");
  await kestrel.pause(1200);

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

  const handed = kestrel.handoff(
    "moth",
    "Update docs/permissions.md to describe delegation rules once router.ts lands.",
    "Moth accepted. Queued until the tests pass.",
  );
  await kestrel.pause(600);
  const passed = await kestrel.run("npm test -- router", PASSING, "3 passed");
  if (passed) {
    enqueue("moth", async () => {
      moth.beginTurn();
      taskStarted(handed);
      try {
        await mothWritesDocs(moth);
      } finally {
        taskEnded(handed);
      }
    });
  }

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
  await moth.pause(800);
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

/**
 * Sends the user's message to a placeholder agent, queued behind anything it
 * is doing. As a task, it becomes one (or is linked to `taskId`). Returns the
 * message's id.
 */
export function sendToAgent(agentId: string, text: string, asTask: boolean, taskId?: string): string {
  const id = uid("u");
  pushChat(agentId, { kind: "user", id, text, asTask });
  const linked = asTask ? linkTaskMessage(agentId, id, text, taskId) : null;
  const agent = agentById(agentId);
  if (agent && atLimit(agent) && !queues.has(agentId)) {
    // Refused like a real agent at its limit: nothing starts, the message goes back.
    pushChat(agentId, { kind: "note", id: uid("n"), text: limitNote(agent) });
    notSent(agentId, id, text, linked !== null && linked !== taskId ? linked : null);
    if (agent.status !== "limited") setStatus(agentId, "limited");
    return id;
  }
  if (queues.has(agentId)) {
    pushChat(agentId, { kind: "note", id: uid("n"), text: `Queued until ${agentById(agentId)?.name} finishes.` });
  }
  enqueue(agentId, async () => {
    let worked = false;
    try {
      worked = await respond(agentId, text, asTask, id);
    } finally {
      taskEnded(id, worked);
    }
  });
  return id;
}

/** Plays out a message; false when the placeholder did nothing with it. */
async function respond(agentId: string, text: string, asTask: boolean, messageId: string): Promise<boolean> {
  const s = new Script(agentId);
  // A message queued behind the turn that reached the limit is not started: it goes back, as the core does.
  if (atLimit(s.agent)) {
    pushChat(agentId, { kind: "note", id: uid("n"), text: limitNote(s.agent) });
    notSent(agentId, messageId, text, null);
    s.status("limited");
    return false;
  }
  s.beginTurn();
  s.status("working");
  await s.pause(500);
  if (useStore.getState().workspace.kind !== "demo") {
    await s.say(
      "I'm a placeholder agent, so I won't touch a real project. Open the demo project to watch me work.",
    );
    s.done();
    return false;
  }
  if (!asTask) {
    await s.say(
      "I'm a placeholder, so I can only act out a scripted task. Send this as a Task to watch me read, edit and run commands under the settings you gave me.",
    );
    s.done();
    return false;
  }
  taskStarted(messageId);

  const notes = "docs/notes.md";
  await s.say(`On it. I'll note "${text.slice(0, 80)}" in ${notes} and run the tests.`);
  await s.read("README.md", 1, 4);
  let existing = "";
  try {
    existing = await s.files.read(notes);
  } catch {
    existing = "";
  }
  const line = `- ${s.agent.name}: ${text.replace(/\s+/g, " ").trim()}\n`;
  const edited = existing
    ? await s.edit(notes, existing, existing + line)
    : await s.edit(notes, "", `# Notes\n\n${line}`);
  if (!edited) {
    await s.say(`I couldn't edit ${notes}. The activity log above says why.`);
    s.done();
    return true;
  }
  const tested = await s.run("npm test", PASSING, "3 passed");
  await s.say(
    tested
      ? `Done. I added a line to ${notes} and the tests still pass.`
      : `I added a line to ${notes}, but I wasn't allowed to run the tests.`,
  );
  s.done();
  return true;
}
