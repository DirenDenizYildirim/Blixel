// The project switcher at the top of the sidebar: recent projects, opening a
// folder, the demo, and renaming, locating or forgetting a project.

import { useRef, useState } from "react";
import { inTauri } from "../model/backend";
import { locateProject, openDemo, openFolderAsProject, openProject, removeProject, renameProject } from "../model/projects";
import { notify, useStore } from "../model/store";
import type { Project } from "../model/types";
import { CheckIcon, ChevronDown, MoreIcon, WarnIcon } from "./icons";
import { byRecent, errorText, openNew, Popover, shortPath, useHome, useProjectId, useProjectName, useProjects, type Place } from "./NewPopover";

/** Said wherever a project shows that its saved record was changed outside the app. */
const CHANGED = "Its saved record was changed outside the app. Check that its folder is the right one";

export function ProjectSwitcher({ rail }: { rail?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const name = useProjectName();
  const changed = useStore((s) => s.projects.some((p) => p.id === s.projectId && p.trust === "changed-outside"));
  const tile = <span className="project-tile" aria-hidden="true">{(name.trim()[0] ?? "?").toUpperCase()}</span>;

  return (
    <>
      {rail ? (
        <button
          ref={button}
          type="button"
          className="rail-btn"
          aria-label={`Project: ${name}${changed ? `. ${CHANGED}` : ""}`}
          title={`${name} (switch project)${changed ? `. ${CHANGED}` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {tile}
        </button>
      ) : (
        <div className="switcher">
          <button
            ref={button}
            type="button"
            className="project-switch"
            title={changed ? `Switch project. ${CHANGED}` : "Switch project"}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {tile}
            <span className="project-switch-name">{name}</span>
            {changed && (
              <span className="trust-mark" role="img" aria-label={CHANGED}>
                <WarnIcon />
              </span>
            )}
            <ChevronDown />
          </button>
        </div>
      )}
      {open && <ProjectMenu anchor={() => button.current} place={rail ? "beside" : "below-start"} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProjectMenu({ anchor, place, onClose }: { anchor: () => HTMLElement | null; place: Place; onClose: () => void }) {
  const projects = useProjects();
  const current = useProjectId();
  const run = (action: () => Promise<void>) => {
    onClose();
    action().catch((e) => notify(errorText(e)));
  };

  return (
    // A dialog rather than a menu: a project's row can turn into a rename field or a question.
    <Popover anchor={anchor} label="Projects" place={place} role="dialog" arrows className="pop-menu project-pop" onClose={onClose}>
      {projects.length > 0 && (
        <div className="pop-label" aria-hidden="true">
          Projects
        </div>
      )}
      {byRecent(projects).map((p) => (
        <ProjectEntry key={p.id} project={p} current={p.id === current} run={run} close={onClose} />
      ))}
      {!inTauri && <div className="pop-note">Projects on your disk need the desktop app.</div>}
      <div className="pop-sep" role="separator" />
      <button
        type="button"
        className="pop-item"
        aria-current={current === "demo" || undefined}
        data-autofocus={current === "demo" || undefined}
        onClick={() => (current === "demo" ? onClose() : run(openDemo))}
      >
        <span className="pop-check">{current === "demo" && <CheckIcon />}</span>
        <span className="grow">Demo project</span>
      </button>
      <button type="button" className="pop-item" onClick={() => run(openFolderAsProject)}>
        <span className="pop-check" />
        <span className="grow">Open folder…</span>
      </button>
      <button
        type="button"
        className="pop-item"
        onClick={() => {
          onClose();
          openNew("project");
        }}
      >
        <span className="pop-check" />
        <span className="grow">New project…</span>
      </button>
    </Popover>
  );
}

function ProjectEntry(props: {
  project: Project;
  current: boolean;
  run: (action: () => Promise<void>) => void;
  close: () => void;
}) {
  const { project: p, current, run } = props;
  const home = useHome();
  const changed = p.trust === "changed-outside";
  const [mode, setMode] = useState<"idle" | "actions" | "rename">("idle");
  const [name, setName] = useState(p.name);
  const more = useRef<HTMLButtonElement>(null);
  // Enter, Escape and leaving the field each end a rename; only the first counts.
  const renaming = useRef(false);
  const back = () => {
    setMode("idle");
    requestAnimationFrame(() => more.current?.focus());
  };
  const startRename = () => {
    renaming.current = true;
    setName(p.name);
    setMode("rename");
  };
  const endRename = (save: boolean) => {
    if (!renaming.current) return;
    renaming.current = false;
    const next = name.trim();
    if (save && next && next !== p.name) renameProject(p.id, next).catch((e) => notify(errorText(e)));
    back();
  };

  return (
    <div className="project-entry">
      {mode === "rename" ? (
        <input
          className="input project-rename"
          aria-label={`New name for ${p.name}`}
          value={name}
          maxLength={60}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") endRename(true);
            else if (e.key === "Escape") {
              e.stopPropagation();
              endRename(false);
            } else return;
            e.preventDefault();
          }}
          onBlur={() => endRename(true)}
        />
      ) : (
        <div className="project-line">
          <button
            type="button"
            className="pop-item two-line project-open"
            aria-current={current || undefined}
            data-autofocus={current || undefined}
            title={changed ? `${CHANGED}: ${p.folder}` : p.folder}
            // A project whose folder is gone is pointed at it again first; the open one just closes the list.
            onClick={() => (current && !p.missing ? props.close() : run(() => (p.missing ? locateProject(p.id) : openProject(p.id))))}
          >
            <span className="pop-check">{current && <CheckIcon />}</span>
            <span className="project-text">
              <span className="project-name-line">
                <span className="ellipsis">{p.name}</span>
                {changed && (
                  <span className="trust-mark" role="img" aria-label="Changed outside the app">
                    <WarnIcon size={12} />
                  </span>
                )}
              </span>
              <span className={p.missing || changed ? "project-path missing" : "project-path"}>
                {p.missing ? "Folder missing; locate it" : changed ? `Check its folder: ${shortPath(p.folder, home)}` : shortPath(p.folder, home)}
              </span>
            </span>
          </button>
          <button
            ref={more}
            type="button"
            className="project-more"
            aria-label={`Actions for ${p.name}`}
            aria-expanded={mode !== "idle"}
            onClick={() => setMode(mode === "idle" ? "actions" : "idle")}
          >
            <MoreIcon size={14} />
          </button>
        </div>
      )}
      {mode === "actions" && (
        <div className="project-actions">
          <button type="button" className="pop-mini" onClick={startRename}>
            Rename
          </button>
          <button type="button" className="pop-mini" onClick={() => run(() => locateProject(p.id))}>
            Locate…
          </button>
          {/* removeProject asks first, in the app's question card. */}
          <button type="button" className="pop-mini danger" onClick={() => run(() => removeProject(p.id))}>
            Remove…
          </button>
        </div>
      )}
    </div>
  );
}
