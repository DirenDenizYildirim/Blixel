import { ViewMenuButton } from "../layout/ViewMenu";
import { setShellOpen } from "../model/layout";
import { useStore } from "../model/store";
import { CloseIcon, TerminalIcon } from "./icons";
import { ShellView } from "./ShellView";

/** The selected agent's shell, as a view of its own. */
export function ShellPanel() {
  const selected = useStore((s) => s.agents.find((a) => a.id === s.selectedId));
  const shellTitle = useStore((s) => (s.selectedId ? s.shells[s.selectedId]?.title : "") ?? "");

  return (
    <section aria-label={selected ? `${selected.name}'s shell` : "Shell"} className="shell-card">
      <div className="shell-head">
        <TerminalIcon size={14} width={2.4} />
        {selected ? (
          <>
            <span className="who-name">{selected.name}'s shell</span>
            <span className="shell-cmd ellipsis grow">{shellTitle}</span>
          </>
        ) : (
          <span className="shell-cmd grow">No agent selected</span>
        )}
        <span className="head-tools">
          <ViewMenuButton view="shell" />
          <button type="button" className="icon-btn small muted" aria-label="Hide shell" title="Hide shell (Ctrl+J)" onClick={() => setShellOpen(false)}>
            <CloseIcon size={10} />
          </button>
        </span>
      </div>
      <div className="shell-body">{selected && <ShellView agentId={selected.id} />}</div>
    </section>
  );
}
