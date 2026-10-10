import { useMemo, useRef, useState } from "react";
import { Avatar } from "../avatars/Avatar";
import { APP_NAME } from "../brand";
import { keyBindings } from "../commands/keys";
import { formatKey } from "../commands/keynames";
import { runCommand } from "../commands/registry";
import { expandSidebar, toggleSidebar, useLayout } from "../model/layout";
import { hueOf, notify, openFile, selectAgent, showView, toggleFiles, toggleFolder, useStore, type View } from "../model/store";
import { PROGRAM_LABELS, type Agent, type AgentStatus, type TreeEntry } from "../model/types";
import { agentColor } from "../theme/theme";
import { AgentMenu } from "./AgentMenu";
import { StatusLabel } from "./controls";
import {
  AgentsIcon,
  ChevronDown,
  ChevronRight,
  ConnectorsIcon,
  FolderIcon,
  MenuIcon,
  ModsIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ThemeIcon,
  WarnIcon,
} from "./icons";
import { toggleNew, useNewPopover } from "./NewPopover";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeMenu } from "./ThemeMenu";
import "./sidebar.css";

export function avatarMode(status: AgentStatus) {
  return status === "working" ? "working" : status === "waiting" ? "waiting" : "idle";
}

export function agentSubline(agent: Pick<Agent, "program" | "runsOn">) {
  const program = PROGRAM_LABELS[agent.program];
  if (agent.runsOn === "api-key") return `${program}, API key`;
  if (agent.runsOn === "self-hosted") return `${program}, local`;
  return program;
}

/** Said wherever an agent shows that its saved settings were changed outside the app. */
export const UNREVIEWED = "Settings changed outside the app; review them before it runs";

export function AgentRow(props: { agent: Agent; current?: boolean; unreviewed?: boolean; onClick?: () => void }) {
  const { agent } = props;
  return (
    <button type="button" className="agent-row" aria-current={props.current || undefined} onClick={props.onClick}>
      <Avatar name={agent.name} style={agent.avatarStyle} mode={avatarMode(agent.status)} size={32} hue={hueOf(agent)} />
      <span className="agent-row-text">
        <span className="agent-row-top">
          <span className="agent-row-name">{agent.name || "Unnamed"}</span>
          {props.unreviewed && (
            <span className="trust-mark" role="img" aria-label={UNREVIEWED} title={UNREVIEWED}>
              <WarnIcon />
            </span>
          )}
          <StatusLabel status={agent.status} />
        </span>
        <span className="agent-row-sub">{agentSubline(agent)}</span>
      </span>
    </button>
  );
}

/** Search opens the command palette. */
const search = () => void runCommand("palette.open").catch(() => notify("Search comes in a later milestone."));

const newAgentPage = (view: View) => view.kind === "agent-form" && !view.editingId;
const statusText = (a: Agent) => (a.status === "waiting" ? "needs you" : a.status);

export function Sidebar() {
  const collapsed = useLayout((l) => l.nav.collapsed);
  const width = useLayout((l) => l.nav.width);
  const side = useLayout((l) => l.nav.side);
  return collapsed ? <SidebarRail side={side} /> : <FullSidebar width={width} />;
}

function FullSidebar({ width }: { width: number }) {
  const agents = useStore((s) => s.agents);
  const trust = useStore((s) => s.agentTrust);
  const selectedId = useStore((s) => s.selectedId);
  const view = useStore((s) => s.view);
  const filesOpen = useStore((s) => s.filesOpen);
  const newOpen = useNewPopover((s) => s.open);

  return (
    <nav aria-label="Workspace" className="sidebar nav-full" style={{ flexBasis: width }}>
      <div className="sidebar-head" data-tauri-drag-region>
        <button type="button" className="icon-btn" aria-label="Collapse sidebar" title="Collapse sidebar (Ctrl+B)" onClick={toggleSidebar}>
          <MenuIcon />
        </button>
        <span className="brand" data-tauri-drag-region>{APP_NAME}</span>
      </div>
      <ProjectSwitcher />

      <div className="side-scroll">
        <div className="side-group">
          <button type="button" className="side-item" onClick={search}>
            <SearchIcon />
            <span>Search</span>
          </button>
          <button
            type="button"
            className="side-item"
            data-new-anchor
            aria-haspopup="dialog"
            aria-expanded={newOpen}
            aria-current={newAgentPage(view) ? "page" : undefined}
            onClick={toggleNew}
          >
            <PlusIcon />
            <span>New</span>
          </button>
          <div className="side-item side-label">
            <AgentsIcon />
            <span>Agents</span>
          </div>
        </div>

        <div className="side-group agents">
          {agents.map((a) => (
            <AgentItem key={a.id} agent={a} current={view.kind === "main" && a.id === selectedId} unreviewed={Boolean(trust[a.id])} />
          ))}
          {agents.length === 0 && (
            <div className="side-empty">
              No agents here yet.{" "}
              <button type="button" className="link-btn" onClick={() => showView({ kind: "agent-form", editingId: null })}>
                Add one
              </button>
            </div>
          )}
        </div>

        <div className="side-group files">
          <button type="button" className="side-item" aria-expanded={filesOpen} onClick={toggleFiles}>
            <FolderIcon />
            <span className="grow">Files</span>
            {filesOpen ? <ChevronDown /> : <ChevronRight />}
          </button>
          {filesOpen && <FileTree />}
        </div>
      </div>

      <SidebarFoot rail={false} />
    </nav>
  );
}

/** An agent in the list, with its "⋯" menu on hover or focus (or a right click). */
function AgentItem({ agent, current, unreviewed }: { agent: Agent; current: boolean; unreviewed: boolean }) {
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="agent-item"
      data-open={menu || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      <AgentRow agent={agent} current={current} unreviewed={unreviewed} onClick={() => selectAgent(agent.id)} />
      <button
        ref={more}
        type="button"
        className="agent-more"
        aria-label={`Actions for ${agent.name}`}
        title="Edit, duplicate, copy or remove"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        <MoreIcon />
      </button>
      {menu && <AgentMenu agent={agent} anchor={() => more.current} place="below-end" onClose={() => setMenu(false)} />}
    </div>
  );
}

/** Mods, Connectors, Theme and Settings: a row of icons at the foot, or a column on the rail. */
function SidebarFoot({ rail }: { rail: boolean }) {
  const page = useStore((s) => s.view.kind);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeButton = useRef<HTMLButtonElement>(null);
  const settingsKey = keyBindings().byCommand.get("settings.open");
  const cls = rail ? "rail-btn" : "icon-btn muted foot-btn";
  const icon = { size: 17, color: "currentColor" };
  const pageButton = (kind: View["kind"], label: string, Icon: (p: typeof icon) => React.ReactNode, hint = label) => (
    <button
      type="button"
      className={cls}
      aria-label={label}
      title={hint}
      aria-current={page === kind ? "page" : undefined}
      onClick={() => showView({ kind } as View)}
    >
      <Icon {...icon} />
    </button>
  );

  return (
    <div className={rail ? "rail-foot" : "sidebar-foot foot-row"}>
      {pageButton("mods", "Mods", ModsIcon)}
      {pageButton("connectors", "Connectors", ConnectorsIcon)}
      <button
        ref={themeButton}
        type="button"
        className={cls}
        aria-label="Theme"
        title="Theme"
        aria-haspopup="menu"
        aria-expanded={themeOpen}
        onClick={() => setThemeOpen(!themeOpen)}
      >
        <ThemeIcon {...icon} />
      </button>
      {pageButton("settings", "Settings", SettingsIcon, settingsKey ? `Settings (${formatKey(settingsKey)})` : "Settings")}
      {themeOpen && (
        <ThemeMenu anchor={() => themeButton.current} place={rail ? "beside" : "above-start"} onClose={() => setThemeOpen(false)} />
      )}
    </div>
  );
}

/** The collapsed sidebar: icons and agent avatars only. */
function SidebarRail({ side }: { side: "left" | "right" }) {
  const agents = useStore((s) => s.agents);
  const trust = useStore((s) => s.agentTrust);
  const selectedId = useStore((s) => s.selectedId);
  const view = useStore((s) => s.view);
  const newOpen = useNewPopover((s) => s.open);
  const openFiles = () => {
    if (!expandSidebar()) return;
    if (!useStore.getState().filesOpen) toggleFiles();
  };

  return (
    <nav aria-label="Workspace" className="sidebar rail nav-rail" data-side={side}>
      <div className="sidebar-head rail-head" data-tauri-drag-region>
        <button type="button" className="icon-btn" aria-label="Expand sidebar" title="Expand sidebar (Ctrl+B)" onClick={toggleSidebar}>
          <MenuIcon />
        </button>
      </div>
      <ProjectSwitcher rail />
      <div className="rail-scroll">
        <button type="button" className="rail-btn" aria-label="Search" title="Search" onClick={search}>
          <SearchIcon />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-new-anchor
          aria-label="New"
          title="New project, task or agent"
          aria-haspopup="dialog"
          aria-expanded={newOpen}
          aria-current={newAgentPage(view) ? "page" : undefined}
          onClick={toggleNew}
        >
          <PlusIcon />
        </button>
        <div className="rail-agents">
          {agents.map((a) => (
            <RailAgent key={a.id} agent={a} current={view.kind === "main" && a.id === selectedId} unreviewed={Boolean(trust[a.id])} />
          ))}
        </div>
        <button type="button" className="rail-btn" aria-label="Files" title="Files" onClick={openFiles}>
          <FolderIcon />
        </button>
      </div>
      <SidebarFoot rail />
    </nav>
  );
}

function RailAgent({ agent: a, current, unreviewed }: { agent: Agent; current: boolean; unreviewed: boolean }) {
  const [menu, setMenu] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const label = `${a.name}, ${statusText(a)}${unreviewed ? `. ${UNREVIEWED}` : ""}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="rail-agent"
        aria-label={label}
        title={label}
        aria-current={current || undefined}
        onClick={() => selectAgent(a.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        <Avatar name={a.name} style={a.avatarStyle} mode={avatarMode(a.status)} size={32} hue={hueOf(a)} />
        <span className="rail-dot" data-status={a.status} />
        {unreviewed && (
          <span className="rail-trust" aria-hidden="true">
            <WarnIcon size={12} />
          </span>
        )}
      </button>
      {menu && <AgentMenu agent={a} anchor={() => button.current} place="beside" onClose={() => setMenu(false)} />}
    </>
  );
}

// ---- File tree ----

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

function buildTree(entries: TreeEntry[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  const byPath = new Map<string, Node>([["", root]]);
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const parentPath = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const parent = byPath.get(parentPath) ?? root;
    const node: Node = { name: e.path.slice(parentPath ? parentPath.length + 1 : 0), path: e.path, dir: e.dir, children: [] };
    parent.children.push(node);
    if (e.dir) byPath.set(e.path, node);
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? 1 : -1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

/** Folders with a single folder inside show as one row, "src / agents". */
function compact(node: Node): { label: string; node: Node } {
  let label = node.name;
  let n = node;
  while (n.dir && n.children.length === 1 && n.children[0].dir) {
    n = n.children[0];
    label += " / " + n.name;
  }
  return { label, node: n };
}

function FileTree() {
  const tree = useStore((s) => s.tree);
  const nodes = useMemo(() => buildTree(tree), [tree]);
  if (!tree.length) return <div className="tree-empty">No files</div>;
  return (
    <div className="tree" role="tree">
      {nodes.map((n) => (
        <TreeNode key={n.path} node={n} depth={0} />
      ))}
    </div>
  );
}

function TreeNode({ node, depth }: { node: Node; depth: number }) {
  const collapsed = useStore((s) => s.collapsed);
  const activePath = useStore((s) => s.activePath);
  const presence = useStore((s) => s.presence);
  const agents = useStore((s) => s.agents);
  const pad = 37 + depth * 12;

  if (node.dir) {
    const { label, node: inner } = compact(node);
    const closed = collapsed[inner.path];
    return (
      <>
        <button
          type="button"
          role="treeitem"
          aria-expanded={!closed}
          className="tree-row folder"
          style={{ paddingLeft: pad }}
          onClick={() => toggleFolder(inner.path)}
        >
          <span>{label}</span>
        </button>
        {!closed && inner.children.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
      </>
    );
  }

  const here = agents.filter((a) => presence[a.id]?.path === node.path);
  return (
    <button
      type="button"
      role="treeitem"
      className="tree-row"
      aria-current={activePath === node.path || undefined}
      style={{ paddingLeft: pad }}
      onClick={() => openFile(node.path)}
    >
      <span className="grow ellipsis">{node.name}</span>
      {here.map((a) => (
        <span key={a.id} className="dot" title={`${a.name} is here`} style={{ background: agentColor(hueOf(a)) }} />
      ))}
      {activePath === node.path && here.length > 0 && <span className="dot" title="You are here" style={{ background: "var(--accent)" }} />}
    </button>
  );
}
