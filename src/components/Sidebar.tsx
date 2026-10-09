import { useMemo, useState } from "react";
import { Avatar } from "../avatars/Avatar";
import { APP_NAME } from "../brand";
import { runCommand } from "../commands/registry";
import { expandSidebar, toggleSidebar, useLayout } from "../model/layout";
import {
  hueOf,
  notify,
  openDemo,
  openFile,
  openFolder,
  selectAgent,
  showView,
  toggleFiles,
  toggleFolder,
  useStore,
} from "../model/store";
import { PROGRAM_LABELS, type Agent, type AgentStatus, type TreeEntry } from "../model/types";
import { agentColor } from "../theme/theme";
import { StatusLabel } from "./controls";
import {
  AgentsIcon,
  ChevronDown,
  ChevronRight,
  FolderIcon,
  MenuIcon,
  ModsIcon,
  OpenIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TasksIcon,
  TerminalIcon,
  ThemeIcon,
} from "./icons";
import { ThemeMenu } from "./ThemeMenu";

export function avatarMode(status: AgentStatus) {
  return status === "working" ? "working" : status === "waiting" ? "waiting" : "idle";
}

export function agentSubline(agent: Pick<Agent, "program" | "runsOn">) {
  const program = PROGRAM_LABELS[agent.program];
  if (agent.runsOn === "api-key") return `${program}, API key`;
  if (agent.runsOn === "self-hosted") return `${program}, local`;
  return program;
}

export function AgentRow({ agent, current, onClick }: { agent: Agent; current?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className="agent-row" aria-current={current || undefined} onClick={onClick}>
      <Avatar name={agent.name} style={agent.avatarStyle} mode={avatarMode(agent.status)} size={32} hue={hueOf(agent)} />
      <span className="agent-row-text">
        <span className="agent-row-top">
          <span className="agent-row-name">{agent.name || "Unnamed"}</span>
          <StatusLabel status={agent.status} />
        </span>
        <span className="agent-row-sub">{agentSubline(agent)}</span>
      </span>
    </button>
  );
}

const later = (what: string) => () => notify(`${what} comes in a later milestone.`);

/** Search opens the command palette. */
const search = () => void runCommand("palette.open").catch(() => notify("Search comes in a later milestone."));

const openMods = () => showView({ kind: "mods" });

/** The Settings page, from the gear at the foot of the sidebar. */
function SettingsButton() {
  const current = useStore((s) => s.view.kind === "settings");
  return (
    <div className="sidebar-foot">
      <button
        type="button"
        className="icon-btn muted"
        aria-label="Settings"
        title="Settings (Ctrl+,)"
        aria-current={current ? "page" : undefined}
        onClick={() => showView({ kind: "settings" })}
      >
        <SettingsIcon />
      </button>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useLayout((l) => l.nav.collapsed);
  const width = useLayout((l) => l.nav.width);
  const side = useLayout((l) => l.nav.side);
  return collapsed ? <SidebarRail side={side} /> : <FullSidebar width={width} />;
}

function FullSidebar({ width }: { width: number }) {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const view = useStore((s) => s.view);
  const filesOpen = useStore((s) => s.filesOpen);
  const workspace = useStore((s) => s.workspace);
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <nav aria-label="Workspace" className="sidebar" style={{ flexBasis: width }}>
      <div className="sidebar-head" data-tauri-drag-region>
        <button type="button" className="icon-btn" aria-label="Collapse sidebar" title="Collapse sidebar (Ctrl+B)" onClick={toggleSidebar}>
          <MenuIcon />
        </button>
        <span className="brand" data-tauri-drag-region>{APP_NAME}</span>
      </div>

      <div className="side-group">
        <button type="button" className="side-item" onClick={search}>
          <SearchIcon />
          <span>Search</span>
        </button>
        <button
          type="button"
          className="side-item"
          aria-current={view.kind === "agent-form" && !view.editingId ? "page" : undefined}
          onClick={() => showView({ kind: "agent-form", editingId: null })}
        >
          <PlusIcon />
          <span>New agent</span>
        </button>
        <div className="side-item side-label">
          <AgentsIcon />
          <span>Agents</span>
        </div>
      </div>

      <div className="side-group agents">
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            current={view.kind === "main" && a.id === selectedId}
            onClick={() => selectAgent(a.id)}
          />
        ))}
      </div>

      <div className="side-group files">
        <button type="button" className="side-item" aria-expanded={filesOpen} onClick={toggleFiles}>
          <FolderIcon />
          <span className="grow">Files</span>
          {filesOpen ? <ChevronDown /> : <ChevronRight />}
        </button>
        {filesOpen && (
          <>
            <div className="project-row">
              <span className="grow" title={workspace.name}>
                {workspace.name}
              </span>
              {workspace.kind === "folder" ? (
                <button type="button" className="link-btn" onClick={() => void openDemo()}>
                  demo
                </button>
              ) : null}
              <button type="button" className="icon-btn small" aria-label="Open a folder" title="Open a folder" onClick={() => void openFolder()}>
                <OpenIcon />
              </button>
            </div>
            <FileTree />
          </>
        )}
        <button type="button" className="side-item spaced" onClick={later("The task board")}>
          <TasksIcon />
          <span>Tasks</span>
        </button>
        <button type="button" className="side-item" onClick={later("Your own terminal")}>
          <TerminalIcon />
          <span>Terminal</span>
        </button>
        <button type="button" className="side-item" aria-current={view.kind === "mods" ? "page" : undefined} onClick={openMods}>
          <ModsIcon />
          <span>Mods</span>
        </button>
        <div className="theme-anchor">
          <button type="button" className="side-item" aria-expanded={themeOpen} onClick={() => setThemeOpen(!themeOpen)}>
            <ThemeIcon />
            <span>Theme</span>
          </button>
          {themeOpen && <ThemeMenu onClose={() => setThemeOpen(false)} />}
        </div>
      </div>

      <div className="grow min-gap" />
      <SettingsButton />
    </nav>
  );
}

/** The collapsed sidebar: icons and agent avatars only. */
function SidebarRail({ side }: { side: "left" | "right" }) {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const view = useStore((s) => s.view);
  const expandTo = (filesOpen: boolean) => () => {
    if (!expandSidebar()) return;
    if (filesOpen && !useStore.getState().filesOpen) toggleFiles();
  };

  return (
    <nav aria-label="Workspace" className="sidebar rail" data-side={side}>
      <div className="sidebar-head rail-head" data-tauri-drag-region>
        <button type="button" className="icon-btn" aria-label="Expand sidebar" title="Expand sidebar (Ctrl+B)" onClick={toggleSidebar}>
          <MenuIcon />
        </button>
      </div>
      <button type="button" className="rail-btn" aria-label="Search" title="Search" onClick={search}>
        <SearchIcon />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-label="New agent"
        title="New agent"
        aria-current={view.kind === "agent-form" && !view.editingId ? "page" : undefined}
        onClick={() => showView({ kind: "agent-form", editingId: null })}
      >
        <PlusIcon />
      </button>
      <div className="rail-agents">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            className="rail-agent"
            aria-label={`${a.name}, ${a.status === "waiting" ? "needs you" : a.status}`}
            title={`${a.name}, ${a.status === "waiting" ? "needs you" : a.status}`}
            aria-current={view.kind === "main" && a.id === selectedId ? true : undefined}
            onClick={() => selectAgent(a.id)}
          >
            <Avatar name={a.name} style={a.avatarStyle} mode={avatarMode(a.status)} size={32} hue={hueOf(a)} />
            <span className="rail-dot" data-status={a.status} />
          </button>
        ))}
      </div>
      <button type="button" className="rail-btn" aria-label="Files" title="Files" onClick={expandTo(true)}>
        <FolderIcon />
      </button>
      <button type="button" className="rail-btn" aria-label="Tasks" title="Tasks" onClick={later("The task board")}>
        <TasksIcon />
      </button>
      <button type="button" className="rail-btn" aria-label="Terminal" title="Terminal" onClick={later("Your own terminal")}>
        <TerminalIcon />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-label="Mods"
        title="Mods"
        aria-current={view.kind === "mods" ? "page" : undefined}
        onClick={openMods}
      >
        <ModsIcon />
      </button>
      <button type="button" className="rail-btn" aria-label="Theme" title="Theme" onClick={expandTo(false)}>
        <ThemeIcon />
      </button>
      <div className="grow min-gap" />
      <SettingsButton />
    </nav>
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
