// Projects: a folder with its own agents, chats and tasks, one open at a time.
// The core keeps them; the demo (in memory, with scripted agents) is not one.

import { demoBackend, folderBackend, inTauri, pickFolder } from "./backend";
import {
  agentSave,
  agentsList,
  filesCopyIn,
  projectClose,
  projectCreate,
  projectForFolder,
  projectOpen,
  projectRemove,
  projectsList,
  projectUpdate,
  storeGet,
  storeSet,
  storeStatus,
} from "./core-api";
import { setEditorOpen } from "./layout";
import { playOpeningScene } from "./mock-agent";
import { flushSaves, loadProject, settleOpenProject } from "./persist";
import { demoProject, PLACEHOLDER_AGENTS } from "./placeholders";
import { ask, notify, setWorkspaceName, showView, switchWorkspace, uid, useStore } from "./store";
import type { Agent, Project, SavedAgent } from "./types";

/** What the New pop-up asks for. */
export interface NewProject {
  name: string;
  folder: string;
  makeFolder: boolean;
  /** Agents to copy in, from other projects. */
  agents: { projectId: string; agentId: string }[];
  /** Files and folders to copy into the new project's folder. */
  files: string[];
}

const get = useStore.getState;
const set = useStore.setState;
const NEEDS_APP = "Projects work in the desktop app.";

export async function refreshProjects(): Promise<void> {
  if (!inTauri) return;
  try {
    set({ projects: await projectsList() });
  } catch (e) {
    notify(`The project list could not be read: ${e}`);
  }
}

const names = (list: string[]) => (list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

/**
 * Leaving a project stops its agents and closes its files. When that would
 * cut something short, the user decides. The demo keeps nothing, so it never asks.
 */
async function mayLeave(): Promise<boolean> {
  const { projectId, agents, dirty } = get();
  if (projectId === "demo") return true;
  const busy = agents.filter((a) => a.status === "working" || a.status === "waiting").map((a) => a.name);
  const unsaved = Object.keys(dirty).filter((p) => dirty[p]);
  if (!busy.length && !unsaved.length) return true;
  const parts: string[] = [];
  if (busy.length) parts.push(`${names(busy)} ${busy.length === 1 ? "is" : "are"} still working and will stop.`);
  if (unsaved.length === 1) parts.push(`Unsaved changes in ${unsaved[0].split("/").pop()} will be lost.`);
  else if (unsaved.length) parts.push(`Unsaved changes in ${unsaved.length} files will be lost.`);
  return ask({ title: "Leave this project?", detail: parts.join(" "), yes: "Leave", no: "Stay" });
}

let switching = false;

/** One switch at a time; a second request while one runs is ignored. */
async function exclusive(run: () => Promise<void>) {
  if (switching) return;
  switching = true;
  try {
    await run();
  } finally {
    switching = false;
  }
}

async function showDemo() {
  await switchWorkspace(demoBackend(), demoProject());
  setEditorOpen(true);
  playOpeningScene();
}

export async function openProject(id: string, opts: { asked?: boolean; reopen?: boolean } = {}): Promise<void> {
  if (id === "demo") return openDemo();
  if (!inTauri) return notify(NEEDS_APP);
  if (get().projectId === id && !opts.reopen) {
    showView({ kind: "main" });
    return;
  }
  if (!opts.asked && !(await mayLeave())) return;
  await exclusive(async () => {
    // Save what is pending first; nothing changes on screen if the project cannot open.
    await flushSaves();
    let opened: Project;
    try {
      opened = (await projectOpen(id)).project;
    } catch (e) {
      const project = get().projects.find((p) => p.id === id);
      notify(project ? `${project.name} could not be opened: ${e}` : String(e));
      void refreshProjects();
      return;
    }
    // The core has stopped the old project's agents.
    settleOpenProject();
    try {
      const data = await loadProject(opened);
      await flushSaves();
      await switchWorkspace(folderBackend(opened.name), data);
    } catch (e) {
      // The core has the project open but it cannot be shown: close it rather than show the old one over it.
      notify(`${opened.name} could not be shown: ${e}`);
      await projectClose().catch(() => undefined);
      await flushSaves();
      await showDemo();
      return;
    }
    void storeSet("app", "lastProject", opened.id).catch(() => undefined);
  });
  void refreshProjects();
}

export async function openDemo(opts: { asked?: boolean } = {}): Promise<void> {
  if (get().projectId === "demo" && get().ready) {
    showView({ kind: "main" });
    return;
  }
  if (!opts.asked && !(await mayLeave())) return;
  await exclusive(async () => {
    await projectClose().catch((e) => notify(String(e)));
    settleOpenProject();
    await flushSaves();
    await showDemo();
    if (inTauri) void storeSet("app", "lastProject", "demo").catch(() => undefined);
  });
}

export async function openFolderAsProject(): Promise<void> {
  if (!inTauri) return notify("Opening a folder works in the desktop app.");
  const path = await pickFolder();
  if (!path) return;
  try {
    const project = await projectForFolder(path);
    await openProject(project.id);
  } catch (e) {
    notify(String(e));
  }
}

/**
 * The agents of a project with whether their saved settings were changed
 * outside the app, for "Bring agents": the open one's as they are now,
 * another's as saved.
 */
export async function savedAgentsOf(projectId: string): Promise<SavedAgent[]> {
  const s = get();
  if (projectId === s.projectId) return s.agents.map((agent) => ({ agent, trust: s.agentTrust[agent.id] ?? "ok" }));
  if (projectId === "demo") return PLACEHOLDER_AGENTS.map((agent) => ({ agent, trust: "ok" }));
  return agentsList(projectId);
}

export const agentsOf = async (projectId: string): Promise<Agent[]> => (await savedAgentsOf(projectId)).map((s) => s.agent);

/** A name not yet taken: "Kestrel", else "Kestrel 2", "Kestrel 3"… */
export function freeName(name: string, taken: string[]) {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const base = name.replace(/ \d+$/, "");
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/**
 * Makes a project: its folder, copies of the chosen agents' settings (not
 * their chats), the chosen files, and then opens it. If the user would rather
 * stay where they are, it is made but not opened.
 */
export async function createProject(p: NewProject): Promise<Project> {
  if (!inTauri) throw new Error(NEEDS_APP);
  const project = await projectCreate(p.name.trim(), p.folder, p.makeFolder);

  // New ids for the copies; who may hand tasks to whom carries over between them.
  const key = (projectId: string, agentId: string) => `${projectId}\n${agentId}`;
  const sources = new Map<string, SavedAgent[]>();
  const picked: { from: string; agent: Agent }[] = [];
  const ids = new Map<string, string>();
  // Agents whose saved settings were changed outside the app stay behind until the user reviews them.
  const unreviewed: string[] = [];
  for (const { projectId, agentId } of p.agents) {
    if (!sources.has(projectId)) sources.set(projectId, await savedAgentsOf(projectId));
    const saved = sources.get(projectId)!.find((s) => s.agent.id === agentId);
    if (!saved || ids.has(key(projectId, agentId))) continue;
    if (saved.trust !== "ok") {
      unreviewed.push(saved.agent.name);
      continue;
    }
    picked.push({ from: projectId, agent: saved.agent });
    ids.set(key(projectId, agentId), uid("agent"));
  }

  const taken: string[] = [];
  const problems: string[] = [];
  for (const { from, agent } of picked) {
    const name = freeName(agent.name, taken);
    taken.push(name);
    const copy: Agent = {
      ...agent,
      id: ids.get(key(from, agent.id))!,
      name,
      status: "idle",
      canGiveTo: agent.canGiveTo.map((to) => ids.get(key(from, to))).filter((to): to is string => Boolean(to)),
    };
    try {
      await agentSave(project.id, copy);
    } catch (e) {
      problems.push(`${agent.name} (${e})`);
    }
  }
  const notes: string[] = [];
  if (unreviewed.length === 1) {
    notes.push(`${unreviewed[0]} was not copied: its saved settings were changed outside the app. Review them in its project first.`);
  } else if (unreviewed.length) {
    notes.push(`${names(unreviewed)} were not copied: their saved settings were changed outside the app. Review them in their project first.`);
  }
  if (problems.length) notes.push(`Not every agent could be copied: ${problems.join(", ")}.`);

  if (p.files.length) {
    try {
      const copied = await filesCopyIn(project.id, p.files, "");
      const parts = [
        copied.renamed ? `${copied.renamed} got a new name because the name was taken` : "",
        copied.skipped ? `${copied.skipped} could not be copied (links or unreadable)` : "",
      ].filter(Boolean);
      if (parts.length) notes.push(`Copied ${copied.copied} files; ${parts.join(", ")}.`);
    } catch (e) {
      notes.push(`The files could not be copied: ${e}`);
    }
  }
  // One notice for all of it, so none hides another.
  if (notes.length) notify(notes.join(" "), 8000);

  await refreshProjects();
  if (await mayLeave()) await openProject(project.id, { asked: true });
  else notify(`${project.name} is ready. Open it from the project list when you are done here.`);
  return project;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const project = await projectUpdate(id, { name: clean });
  if (get().projectId === id) setWorkspaceName(project.name);
  await refreshProjects();
}

/** Points a project at its folder again, after it was moved. */
export async function locateProject(id: string): Promise<void> {
  const project = get().projects.find((p) => p.id === id);
  const folder = await pickFolder(project ? `Where is ${project.name}?` : "Locate the project's folder");
  if (!folder) return;
  await projectUpdate(id, { folder });
  await refreshProjects();
  // The open project's agents and files move to the new place.
  if (get().projectId === id) await openProject(id, { reopen: true });
}

/**
 * Forgets a project and what was saved for it (the caller has asked); its
 * folder is never touched. The open one gives way to the demo first.
 */
/** Forgets a project once the user agrees. Its folder and files are never touched. */
export async function removeProject(id: string): Promise<void> {
  const project = get().projects.find((p) => p.id === id);
  if (!project) return;
  const sure = await ask({
    title: `Remove ${project.name}?`,
    detail: "Its saved agents, chats and tasks are removed. The folder and its files stay as they are.",
    yes: "Remove",
    no: "Keep",
    danger: true,
  });
  if (!sure) return;
  if (get().projectId === id) await openDemo({ asked: true });
  try {
    await projectRemove(id);
    if ((await storeGet<string>("app", "lastProject").catch(() => null)) === id) void storeSet("app", "lastProject", "demo");
  } finally {
    await refreshProjects();
  }
}

const RECOVERY_SHOWN = "recoveryShown";

/**
 * Tells the user, once, when the saved data could not be read at start and
 * the core set it aside for a fresh copy: their projects would seem gone.
 */
async function noticeRecovery() {
  try {
    const { recovered, unsaved } = await storeStatus();
    // Another copy of the app holds the database: this one keeps nothing, so say so plainly, not in a passing notice.
    if (unsaved) void ask({ title: "Nothing will be saved this time", detail: unsaved, yes: "I understand" });
    if (!recovered || (await storeGet<string>("app", RECOVERY_SHOWN).catch(() => null)) === recovered) return;
    notify(
      `Your saved projects and chats could not be read, so this started with a fresh copy. The old file was kept at ${recovered}.`,
      15_000,
    );
    void storeSet("app", RECOVERY_SHOWN, recovered).catch(() => undefined);
  } catch {
    // A core without this report has nothing to tell.
  }
}
let started = false;

/** At start: the last project, or the demo on the first run (and always outside the desktop app). */
export async function startProjects(): Promise<void> {
  if (started) return;
  started = true;
  try {
    if (inTauri) {
      await refreshProjects();
      const last = await storeGet<string>("app", "lastProject").catch(() => null);
      const project = get().projects.find((p) => p.id === last);
      if (project?.missing) notify(`${project.name}'s folder is missing. Locate it from the project list.`);
      else if (project) await openProject(project.id, { asked: true, reopen: true });
    }
    if (get().epoch === 0) await showDemo();
  } catch (e) {
    notify(String(e));
    if (get().epoch === 0) await showDemo().catch(() => undefined);
  } finally {
    set({ ready: true });
    if (inTauri) void noticeRecovery();
  }
}
