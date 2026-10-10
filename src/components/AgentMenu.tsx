// An agent's "⋯" menu in the sidebar: edit, duplicate, copy to another
// project, remove (removeAgent asks first).

import { useEffect, useRef, useState } from "react";
import { copyAgentToProject, duplicateAgent, refuseUnreviewed, removeAgent } from "../model/agent-actions";
import { notify, showView, useStore } from "../model/store";
import type { Agent } from "../model/types";
import { byRecent, errorText, Popover, shortPath, useHome, useProjectId, useProjects, type Place } from "./NewPopover";

export function AgentMenu(props: { agent: Agent; anchor: () => HTMLElement | null; place: Place; onClose: () => void }) {
  const { agent, onClose } = props;
  const [page, setPage] = useState<"main" | "copy">("main");
  const projects = useProjects();
  const current = useProjectId();
  const home = useHome();
  const others = byRecent(projects.filter((p) => p.id !== current));
  const body = useRef<HTMLDivElement>(null);
  const name = agent.name || "this agent";
  // Its saved settings were changed outside the app: editing is reviewing, and copies are refused until then.
  const unreviewed = useStore((s) => Boolean(s.agentTrust[agent.id]));

  // Each page starts with focus on its first button.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    body.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [page]);

  // The actions say themselves how it went.
  const run = (action: () => Promise<void>) => {
    onClose();
    action().catch((e) => notify(errorText(e)));
  };

  return (
    <Popover
      anchor={props.anchor}
      label={page === "copy" ? (others.length ? `Copy ${name}'s settings to` : "No other projects yet") : `${name}: actions`}
      place={props.place}
      role="menu"
      className="pop-menu agent-pop"
      onClose={onClose}
    >
      <div ref={body} className="pop-pages">
        {page === "main" && (
          <>
            <button
              type="button"
              role="menuitem"
              className="pop-item"
              onClick={() => {
                onClose();
                showView({ kind: "agent-form", editingId: agent.id });
              }}
            >
              {unreviewed ? "Review settings…" : "Edit…"}
            </button>
            <button type="button" role="menuitem" className="pop-item" onClick={() => run(() => duplicateAgent(agent.id))}>
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              className="pop-item"
              // Refused at once, with why, rather than after picking a project.
              onClick={() => (unreviewed ? run(async () => refuseUnreviewed(agent)) : setPage("copy"))}
            >
              Copy to project…
            </button>
            <div className="pop-sep" role="separator" />
            <button type="button" role="menuitem" className="pop-item danger" onClick={() => run(() => removeAgent(agent.id))}>
              Remove…
            </button>
          </>
        )}
        {page === "copy" && (
          <>
            <div className="pop-label" aria-hidden="true">
              Copy {name}'s settings to
            </div>
            {others.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="pop-item two-line"
                title={p.folder}
                onClick={() => run(() => copyAgentToProject(agent.id, p.id))}
              >
                <span className="project-text">
                  <span className="ellipsis">{p.name}</span>
                  <span className={p.missing ? "project-path missing" : "project-path"}>
                    {p.missing ? "Folder missing" : shortPath(p.folder, home)}
                  </span>
                </span>
              </button>
            ))}
            {!others.length && (
              <div className="pop-note" aria-hidden="true">
                No other projects yet. Make one with New.
              </div>
            )}
            <div className="pop-sep" role="separator" />
            <button type="button" role="menuitem" className="pop-item" onClick={() => setPage("main")}>
              ← Back
            </button>
          </>
        )}
      </div>
    </Popover>
  );
}
