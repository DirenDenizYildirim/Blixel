// Commands this part of the app provides: the palette, the Settings, Mods and
// Connectors pages, the New pop-up, one command per theme of the enabled mods,
// per project and per agent (kept in step as they change). The layout and
// editor commands are registered next to the code they run.

import { DEMO_LABEL, currentProjectId, openNew, projectsNow } from "../components/NewPopover";
import { availableThemes, useMods, type AvailableTheme } from "../mods/registry";
import { openDemo, openFolderAsProject, openProject } from "../model/projects";
import { setTheme, showView, useStore } from "../model/store";
import { closePalette, openPalette } from "./Palette";
import { registerCommand } from "./registry";

let themeCommands: (() => void)[] = [];
let registeredThemes: AvailableTheme[] | null = null;

function syncThemeCommands() {
  const themes = availableThemes();
  if (themes === registeredThemes) return;
  registeredThemes = themes;
  themeCommands.forEach((off) => off());
  themeCommands = themes.map((t) =>
    registerCommand({
      id: `theme.${t.id}`,
      title: `Theme: ${t.label}`,
      source: t.builtin ? "core" : t.modId,
      run: () => setTheme(t.id),
    }),
  );
}

/** Replaces a group of commands when what they are made from changes (by `key`). */
function commandGroup<T>(make: (item: T) => Parameters<typeof registerCommand>[0]) {
  let key = "";
  let off: (() => void)[] = [];
  return (items: T[], nextKey: string) => {
    if (nextKey === key) return;
    key = nextKey;
    off.forEach((fn) => fn());
    off = items.map((item) => registerCommand(make(item)));
  };
}

const syncProjectCommands = commandGroup((p: { id: string; name: string }) => ({
  id: `project.switch.${p.id}`,
  title: `Project: Switch to ${p.name}`,
  source: "core",
  hidden: () => currentProjectId() === p.id,
  run: () => (p.id === "demo" ? openDemo() : openProject(p.id)),
}));

const syncAgentCommands = commandGroup((a: { id: string; name: string }) => ({
  id: `agent.edit.${a.id}`,
  title: `Agent: Edit ${a.name || "Unnamed"}`,
  source: "core",
  run: () => showView({ kind: "agent-form", editingId: a.id }),
}));

function syncListCommands() {
  const projects = [...projectsNow(), { id: "demo", name: DEMO_LABEL }];
  syncProjectCommands(projects, projects.map((p) => `${p.id}\t${p.name}`).join("\n"));
  // Agents change often (their status); the commands only when an id or name does.
  const agents = useStore.getState().agents;
  syncAgentCommands(agents, agents.map((a) => `${a.id}\t${a.name}`).join("\n"));
}

let installed = false;

/** Registers the commands. Call once, at start. */
export function installBuiltinCommands() {
  if (installed) return;
  installed = true;
  registerCommand({ id: "palette.open", title: "Commands: Show all", source: "core", key: "Ctrl+Shift+P", run: openPalette });
  // The palette closes too, so Ctrl+, pressed over it shows the page.
  registerCommand({
    id: "settings.open",
    title: "Settings: Open",
    source: "core",
    key: "Ctrl+,",
    run: () => {
      closePalette();
      showView({ kind: "settings" });
    },
  });
  registerCommand({ id: "mods.open", title: "Mods: Open", source: "core", run: () => showView({ kind: "mods" }) });
  registerCommand({ id: "connectors.open", title: "Connectors: Open", source: "core", run: () => showView({ kind: "connectors" }) });
  registerCommand({ id: "project.new", title: "Project: New…", source: "core", run: () => openNew("project") });
  registerCommand({ id: "project.openFolder", title: "Project: Open folder…", source: "core", run: openFolderAsProject });
  registerCommand({ id: "task.new", title: "Task: New…", source: "core", run: () => openNew("task") });
  syncListCommands();
  useStore.subscribe(syncListCommands);
  syncThemeCommands();
  useMods.subscribe((s, prev) => {
    if (s.mods !== prev.mods) syncThemeCommands();
  });
}
