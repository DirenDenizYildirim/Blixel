// The New pop-up (a project or a task, with a link to the agent form), and
// what the sidebar's other pop-ups share with it: a card anchored to its
// button, and reading the projects from the store.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { Avatar } from "../avatars/Avatar";
import { inTauri } from "../model/backend";
import { filesMeasure, storeGet, storeSet, type Measured } from "../model/core-api";
import { createProject, savedAgentsOf } from "../model/projects";
import { hueOf, notify, showView, useStore } from "../model/store";
import { createTask } from "../model/tasks";
import type { Project, SavedAgent } from "../model/types";
import { agentColor } from "../theme/theme";
import { ChevronDown, CloseIcon, WarnIcon } from "./icons";
import "./sidebar.css";

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- Projects as the store has them ----

export const useProjects = () => useStore((s) => s.projects);
export const useProjectId = () => useStore((s) => s.projectId);
export const projectsNow = () => useStore.getState().projects;
export const currentProjectId = () => useStore.getState().projectId;

export const DEMO_LABEL = "Demo project";

/** The open project's name, as the switcher shows it. */
export function useProjectName(): string {
  const projects = useProjects();
  const id = useProjectId();
  const folderName = useStore((s) => s.workspace.name);
  if (id === "demo") return DEMO_LABEL;
  return projects.find((p) => p.id === id)?.name ?? folderName;
}

/** Most recently opened first. */
export const byRecent = (projects: Project[]) => [...projects].sort((a, b) => b.lastOpened - a.lastOpened);

// ---- Paths ----

const trimEnd = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);
const sepOf = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
export const baseName = (path: string) => trimEnd(path).split(/[\\/]/).pop() || path;
const parentOf = (path: string) => trimEnd(path).replace(/[\\/][^\\/]*$/, "") || sepOf(path);
const joinPath = (dir: string, name: string) => `${trimEnd(dir)}${dir.endsWith(sepOf(dir)) ? "" : sepOf(dir)}${name}`;

let home = "";
let homeLoad: Promise<string> | null = null;
const loadHome = () =>
  (homeLoad ??= import("@tauri-apps/api/path")
    .then((p) => p.homeDir())
    .then((h) => (home = trimEnd(h)))
    .catch(() => ""));

/** The home folder, to write paths as ~/...; empty outside the desktop app. */
export function useHome(): string {
  const [value, setValue] = useState(home);
  useEffect(() => {
    if (!inTauri || home) return;
    let live = true;
    void loadHome().then((h) => live && setValue(h));
    return () => {
      live = false;
    };
  }, []);
  return value;
}

export function shortPath(path: string, homeDir: string): string {
  if (homeDir && (path === homeDir || path.startsWith(homeDir + sepOf(homeDir)))) return "~" + path.slice(homeDir.length);
  return path;
}

// ---- A card anchored to a button ----

export type Place = "below-start" | "below-end" | "above-start" | "beside";

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]")].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/** Puts the card by its anchor, inside the window: "beside" means beside the sidebar's edge, as for the rail. */
function placeCard(card: HTMLElement, anchor: HTMLElement | null, place: Place) {
  const { innerWidth: vw, innerHeight: vh } = window;
  const { offsetWidth: w, offsetHeight: h } = card;
  let left = (vw - w) / 2;
  let top = vh * 0.12;
  if (anchor?.isConnected) {
    const a = anchor.getBoundingClientRect();
    const edge = (anchor.closest("nav") ?? anchor).getBoundingClientRect();
    if (place === "beside") {
      left = edge.right + 8;
      top = a.top - 6;
      if (left + w > vw - 8) left = edge.left - w - 8;
    } else if (place === "above-start") {
      left = a.left;
      top = a.top - h - 6;
      if (top < 8) top = a.bottom + 6;
    } else {
      left = place === "below-end" ? a.right - w : a.left;
      top = a.bottom + 4;
      if (top + h > vh - 8 && a.top - h - 4 >= 8) top = a.top - h - 4;
    }
  }
  card.style.left = `${clamp(left, 8, Math.max(8, vw - w - 8))}px`;
  card.style.top = `${clamp(top, 8, Math.max(8, vh - h - 8))}px`;
}

/**
 * A small card floating by its button. It takes focus (the element marked
 * `data-autofocus`, or the first it can), closes on Escape (giving focus back
 * to the button) and on a click elsewhere. A dialog keeps Tab inside; a menu
 * closes on Tab, back to its button. Menus (and dialogs with `arrows`) move
 * between their buttons with the arrow keys.
 */
export function Popover(props: {
  anchor: () => HTMLElement | null;
  label: string;
  place: Place;
  role: "dialog" | "menu";
  arrows?: boolean;
  className?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const place = () => placeCard(card, latest.current.anchor(), latest.current.place);
    place();
    // Tabs and chips change its height; it stays inside the window.
    const resized = new ResizeObserver(place);
    resized.observe(card);
    window.addEventListener("resize", place);
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", place);
    };
  }, []);

  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const marked = [...card.querySelectorAll<HTMLElement>("[data-autofocus]")].find((el) => el.getClientRects().length > 0);
    (marked ?? focusables(card)[0] ?? card).focus();

    const close = () => latest.current.onClose();
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!card.contains(t) && !latest.current.anchor()?.contains(t)) close();
    };
    // A click into a mod's frame never reaches this page; its focus does. A native file dialog takes neither.
    const blur = () => setTimeout(() => document.activeElement instanceof HTMLIFrameElement && close());
    const escape = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && close();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const card = e.currentTarget;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      props.anchor()?.focus();
      return;
    }
    if (e.key === "Tab") {
      if (props.role === "menu") {
        e.preventDefault();
        props.onClose();
        props.anchor()?.focus();
        return;
      }
      const list = focusables(card);
      if (!list.length) return;
      const at = document.activeElement;
      if (e.shiftKey && (at === list[0] || at === card)) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && at === list[list.length - 1]) {
        e.preventDefault();
        list[0].focus();
      }
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (!(props.arrows ?? props.role === "menu") || typing || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = focusables(card).filter((el) => el.tagName === "BUTTON");
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (j: number) => items[(j + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") go(0);
    else go(-1);
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      role={props.role}
      aria-label={props.label}
      tabIndex={-1}
      className={`pop ${props.className ?? ""}`}
      onKeyDown={onKeyDown}
    >
      {props.children}
    </div>,
    document.body,
  );
}

// ---- The New pop-up ----

export type NewTab = "project" | "task";

/** `asked` counts the times it was asked for, so a second ask moves focus to the tab's first field. */
export const useNewPopover = create<{ open: boolean; tab: NewTab; asked: number }>(() => ({ open: false, tab: "project", asked: 0 }));

/** Opens the New pop-up by the sidebar's New button (or near the top, when the sidebar is hidden). */
export function openNew(tab?: NewTab) {
  mountNewPopover();
  const s = useNewPopover.getState();
  useNewPopover.setState({ open: true, tab: tab ?? s.tab, asked: s.asked + 1 });
}

export function closeNew() {
  if (useNewPopover.getState().open) useNewPopover.setState({ open: false });
}

export function toggleNew() {
  if (useNewPopover.getState().open) closeNew();
  else openNew();
}

const newAnchor = () => document.querySelector<HTMLElement>("[data-new-anchor]");

// Its own root, like the palette, so the palette can open it while the sidebar is hidden.
let mounted = false;
function mountNewPopover() {
  if (mounted) return;
  mounted = true;
  const host = document.createElement("div");
  host.id = "new-popover-root";
  document.body.appendChild(host);
  createRoot(host).render(<NewHost />);
}

function NewHost() {
  const open = useNewPopover((s) => s.open);
  return open ? <NewCard /> : null;
}

function NewCard() {
  const tab = useNewPopover((s) => s.tab);
  const asked = useNewPopover((s) => s.asked);
  const body = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Asked again (from the palette, say): the tab's first field gets focus.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const marked = [...(body.current?.querySelectorAll<HTMLElement>("[data-autofocus]") ?? [])];
    marked.find((el) => el.getClientRects().length > 0)?.focus();
  }, [asked]);

  const choose = (next: NewTab) => useNewPopover.setState({ tab: next });
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = tab === "project" ? "task" : "project";
    choose(next);
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <Popover anchor={newAnchor} label="New" place="beside" role="dialog" className="new-pop" onClose={closeNew}>
      <div className="new-head">
        <div ref={tabs} role="tablist" aria-label="What to make" className="seg new-tabs" onKeyDown={onTabKey}>
          {(["project", "task"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`new-tab-${t}`}
              data-tab={t}
              aria-selected={tab === t}
              aria-controls={`new-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => choose(t)}
            >
              {t === "project" ? "Project" : "Task"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="link-btn new-agent-link"
          onClick={() => {
            closeNew();
            showView({ kind: "agent-form", editingId: null });
          }}
        >
          Agent →
        </button>
      </div>
      <div ref={body} className="new-panels">
        {/* Both stay mounted, so switching tabs keeps what was typed. */}
        <div role="tabpanel" id="new-panel-project" aria-labelledby="new-tab-project" hidden={tab !== "project"} className="new-panel">
          {inTauri ? <ProjectForm /> : <ProjectNeedsApp />}
        </div>
        <div role="tabpanel" id="new-panel-task" aria-labelledby="new-tab-task" hidden={tab !== "task"} className="new-panel">
          <TaskForm />
        </div>
      </div>
    </Popover>
  );
}

function ProjectNeedsApp() {
  return (
    <div className="new-body">
      <p className="new-note">
        A project is a folder on your computer with its own agents, chats and tasks, saved between sessions. Projects need
        the desktop app; here in the browser only the demo project runs.
      </p>
      <p className="new-note">You can still add a task, or a new agent to the demo.</p>
    </div>
  );
}

const PARENT_KEY = "new-project.parent";
const agentKey = (projectId: string, agentId: string) => `${projectId}\n${agentId}`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function measuredText(m: Measured): string {
  const files = `${m.files} ${m.files === 1 ? "file" : "files"}, ${formatSize(m.bytes)}`;
  return m.skipped ? `${files}; ${m.skipped} ${m.skipped === 1 ? "link" : "links"} or unreadable left out` : files;
}

async function pickPaths(directory: boolean, multiple: boolean, title: string, defaultPath?: string): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory, multiple, title, defaultPath });
  return Array.isArray(picked) ? picked : picked ? [picked] : [];
}

function ProjectForm() {
  const homeDir = useHome();
  const projects = useProjects();
  const [name, setName] = useState("");
  const [where, setWhere] = useState<"new" | "existing">("new");
  const [parent, setParent] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [groups, setGroups] = useState<{ project: Project; agents: SavedAgent[] }[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where new folders go: the last place used, else beside the open project, else the home folder.
  useEffect(() => {
    let live = true;
    void (async () => {
      const saved = await storeGet<string>("app", PARENT_KEY).catch(() => null);
      const open = projectsNow().find((p) => p.id === currentProjectId());
      const next = saved || (open ? parentOf(open.folder) : await loadHome());
      if (live && next) setParent((p) => p ?? next);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Agents to bring: the open project's first, then the others by when they were last opened.
  useEffect(() => {
    let live = true;
    const id = currentProjectId();
    const list = byRecent(projects).sort((a, b) => Number(b.id === id) - Number(a.id === id));
    void Promise.all(list.map(async (project) => ({ project, agents: await savedAgentsOf(project.id).catch(() => [] as SavedAgent[]) }))).then(
      (all) => live && setGroups(all.filter((g) => g.agents.length > 0)),
    );
    return () => {
      live = false;
    };
  }, [projects]);

  useEffect(() => {
    if (!files.length) {
      setMeasured(null);
      return;
    }
    let live = true;
    filesMeasure(files)
      .then((m) => live && setMeasured(m))
      .catch(() => live && setMeasured(null));
    return () => {
      live = false;
    };
  }, [files]);

  const projectName = name.trim() || (where === "existing" && existing ? baseName(existing) : "");
  const folder = where === "new" ? (parent && name.trim() ? joinPath(parent, name.trim()) : null) : existing;
  const problem =
    where === "new"
      ? !name.trim()
        ? "Name the project."
        : /[\\/]/.test(name) || /^\.+$/.test(name.trim())
          ? "The name becomes a folder, so it can't contain / or \\."
          : !parent
            ? "Choose where to make its folder."
            : null
      : !existing
        ? "Choose its folder."
        : null;

  const allAgents = useMemo(
    () => new Map((groups ?? []).flatMap((g) => g.agents.map(({ agent: a }) => [agentKey(g.project.id, a.id), a] as const))),
    [groups],
  );
  const toggleAgent = (key: string) =>
    setPicked((list) => {
      if (list.includes(key)) return list.filter((k) => k !== key);
      // Names are unique in a project, so a second agent of the same name takes the first one's place.
      const name = allAgents.get(key)?.name.trim().toLowerCase();
      return [...list.filter((k) => allAgents.get(k)?.name.trim().toLowerCase() !== name), key];
    });

  const chooseParent = async () => {
    const [dir] = await pickPaths(true, false, "Where to make the project's folder", parent ?? undefined);
    if (dir) {
      setParent(dir);
      setWhere("new");
    }
  };
  const chooseExisting = async () => {
    const [dir] = await pickPaths(true, false, "The project's folder", parent ?? undefined);
    if (dir) {
      setExisting(dir);
      setWhere("existing");
    }
  };
  const addFiles = async (directory: boolean) => {
    const list = await pickPaths(directory, true, directory ? "Folders to copy into the project" : "Files to copy into the project");
    setFiles((f) => [...f, ...list.filter((p) => !f.includes(p))]);
  };

  const create = async () => {
    if (problem || busy || !folder) return;
    setBusy(true);
    setError(null);
    try {
      // It also opens the new project, asking first if leaving this one would cut something short.
      await createProject({
        name: projectName,
        folder,
        makeFolder: where === "new",
        agents: picked.map((key) => {
          const [projectId, agentId] = key.split("\n");
          return { projectId, agentId };
        }),
        files,
      });
      if (where === "new" && parent) void storeSet("app", PARENT_KEY, parent).catch(() => {});
      closeNew();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="new-body"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label className="field">
        <span className="label">Name</span>
        <input
          className="input strong"
          data-autofocus
          value={name}
          maxLength={60}
          placeholder={where === "existing" && existing ? baseName(existing) : "my-project"}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <fieldset className="new-field">
        <legend className="label">Where</legend>
        <div className="where-row">
          <label className="where-choice">
            <input type="radio" name="new-where" checked={where === "new"} onChange={() => setWhere("new")} />
            <span>New folder in</span>
          </label>
          <button
            type="button"
            className="where-btn"
            title={parent ?? undefined}
            aria-label={`Folder to make it in: ${parent ? shortPath(parent, homeDir) : "not chosen"}. Change`}
            onClick={() => void chooseParent()}
          >
            <span className="ellipsis">{parent ? shortPath(parent, homeDir) : "Choose…"}</span>
            <ChevronDown />
          </button>
        </div>
        <div className="where-row">
          <label className="where-choice">
            <input type="radio" name="new-where" checked={where === "existing"} onChange={() => setWhere("existing")} />
            <span>Existing folder</span>
          </label>
          <button
            type="button"
            className="where-btn"
            title={existing ?? undefined}
            aria-label={`Existing folder: ${existing ? shortPath(existing, homeDir) : "not chosen"}. Choose`}
            onClick={() => void chooseExisting()}
          >
            <span className="ellipsis">{existing ? shortPath(existing, homeDir) : "Choose…"}</span>
          </button>
        </div>
        {folder && (
          <div className="where-result label" title={folder}>
            {where === "new" ? "Makes " : "Uses "}
            <span className="strong">{shortPath(folder, homeDir)}</span>
          </div>
        )}
      </fieldset>

      <div role="group" aria-labelledby="bring-agents" className="new-field">
        <span className="label" id="bring-agents">
          Bring agents <span className="label-aside">their settings, not their chats</span>
        </span>
        {groups === null && <span className="new-note">Looking for agents…</span>}
        {groups?.length === 0 && <span className="new-note">Agents from your other projects show here.</span>}
        {groups?.map((g) => (
          <div key={g.project.id} role="group" aria-label={`From ${g.project.name}`} className="bring-group">
            <span className="bring-from ellipsis">{g.project.name}</span>
            <div className="row wrap gap8">
              {g.agents.map(({ agent: a, trust }) => {
                const key = agentKey(g.project.id, a.id);
                const on = picked.includes(key);
                const h = hueOf(a);
                // Changed outside the app: not copied until the user reviews it in its project.
                const unreviewed = trust !== "ok";
                return (
                  <button
                    key={key}
                    type="button"
                    className="chip small"
                    aria-pressed={on}
                    aria-disabled={unreviewed || undefined}
                    title={
                      unreviewed
                        ? `${a.name}'s saved settings were changed outside the app. Review them in ${g.project.name} before bringing it.`
                        : `${a.name} from ${g.project.name}`
                    }
                    style={on ? { borderColor: agentColor(h) } : undefined}
                    onClick={() =>
                      unreviewed
                        ? notify(`${a.name}'s saved settings were changed outside the app. Review them in ${g.project.name} before bringing it.`)
                        : toggleAgent(key)
                    }
                  >
                    <Avatar name={a.name} style={a.avatarStyle} mode="idle" size={18} hue={h} />
                    <span>{a.name}</span>
                    {unreviewed && <WarnIcon size={12} />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="new-field">
        <span className="label">
          Bring files <span className="label-aside">copied in; nothing is moved</span>
        </span>
        <div className="row gap8">
          <button type="button" className="btn small" onClick={() => void addFiles(false)}>
            Files…
          </button>
          <button type="button" className="btn small" onClick={() => void addFiles(true)}>
            Folders…
          </button>
        </div>
        {files.length > 0 && (
          <>
            <div className="row wrap gap8">
              {files.map((f) => (
                <span key={f} className="file-chip" title={f}>
                  <span className="ellipsis">{baseName(f)}</span>
                  <button
                    type="button"
                    aria-label={`Leave out ${baseName(f)}`}
                    onClick={() => setFiles((list) => list.filter((x) => x !== f))}
                  >
                    <CloseIcon size={10} />
                  </button>
                </span>
              ))}
            </div>
            <span className="new-note">{measured ? measuredText(measured) : "Counting…"}</span>
          </>
        )}
      </div>

      <div className="new-foot">
        <span className={error ? "new-error" : "new-problem"} role={error ? "alert" : undefined}>
          {error ?? problem}
        </span>
        <button type="submit" className="btn primary" disabled={Boolean(problem) || busy}>
          {busy ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}

function TaskForm() {
  const agents = useStore((s) => s.agents);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assignee = agents.find((a) => a.id === agentId);

  const add = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createTask({ title: title.trim(), notes: notes.trim(), agentId: assignee?.id ?? null });
      if (!task) {
        setError("The task could not be added.");
        return;
      }
      closeNew();
      notify(assignee ? `Task added for ${assignee.name}.` : "Task added, unassigned.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="new-body"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label className="field">
        <span className="label">Title</span>
        <input
          className="input strong"
          data-autofocus
          value={title}
          maxLength={200}
          placeholder="Cover the no-rule case in the router"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="label">Notes</span>
        <textarea
          className="input area"
          rows={3}
          value={notes}
          placeholder="Optional"
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void add();
            }
          }}
        />
      </label>
      <div role="group" aria-labelledby="assign-to" className="new-field">
        <span className="label" id="assign-to">
          Assign to
        </span>
        <div className="row wrap gap8">
          <button type="button" className="chip small plain" aria-pressed={agentId === null} onClick={() => setAgentId(null)}>
            Unassigned
          </button>
          {agents.map((a) => {
            const on = a.id === agentId;
            const h = hueOf(a);
            return (
              <button
                key={a.id}
                type="button"
                className="chip small"
                aria-pressed={on}
                style={on ? { borderColor: agentColor(h) } : undefined}
                onClick={() => setAgentId(a.id)}
              >
                <Avatar name={a.name} style={a.avatarStyle} mode="idle" size={18} hue={h} />
                <span>{a.name}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="new-foot">
        <span className={error ? "new-error" : "new-problem"} role={error ? "alert" : undefined}>
          {error ?? (title.trim() ? "" : "Give it a title.")}
        </span>
        <button type="submit" className="btn primary" disabled={!title.trim() || busy}>
          Add task
        </button>
      </div>
    </form>
  );
}
