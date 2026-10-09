// The layout's commands and the editor's save, for the palette and keys. The
// key dispatcher reads `key` from here; nothing in the layout listens itself.

import { registerCommand, type Command } from "../commands/registry";
import { focusEditor } from "../components/EditorPanel";
import { save } from "../editor/sessions";
import {
  applyPreset,
  closeView,
  isOpen,
  mirrorColumns,
  noteFocus,
  openView,
  resetLayout,
  setNavSide,
  setZen,
  toggleShell,
  toggleSidebar,
  toggleZen,
  useLayout,
  zenView,
} from "../model/layout";
import { modName } from "../mods/registry";
import { showView, useStore } from "../model/store";
import { useLayoutPresets } from "./presets";
import type { ViewId } from "./types";
import { useViews } from "./views";

const core = (command: Omit<Command, "source">) => registerCommand({ ...command, source: "core" });

/** Pages other than the agent form (whose edits would be lost) give way to the views. */
function leavePage(): boolean {
  const page = useStore.getState().view;
  if (page.kind === "agent-form") return false;
  if (page.kind !== "main") showView({ kind: "main" });
  return true;
}

function focusView(view: "chat" | "editor") {
  noteFocus(view);
  requestAnimationFrame(() => {
    if (view === "editor") focusEditor();
    else document.querySelector<HTMLElement>('[data-slot="chat"] .composer textarea')?.focus();
  });
}

/** In zen, shows that view instead; otherwise puts the cursor in it, showing it first if hidden. */
function goTo(view: "chat" | "editor") {
  if (!leavePage()) return;
  const inZen = zenView(useLayout.getState(), useViews.getState());
  if (inZen ? setZen(view) : openView(view)) focusView(view);
}

let registered = false;

/** Registers once at startup; view and preset commands follow the views and presets as they change. */
export function registerLayoutCommands() {
  if (registered) return;
  registered = true;
  const onPage = () => useStore.getState().view.kind !== "main";
  const side = () => useLayout.getState().nav.side;

  core({ id: "layout.zen", title: "Layout: Zen mode", key: "Ctrl+.", hidden: onPage, run: () => !onPage() && toggleZen() });
  core({ id: "layout.chat", title: "Layout: Go to the chat", key: "Ctrl+1", run: () => goTo("chat") });
  core({ id: "layout.editor", title: "Layout: Go to the editor", key: "Ctrl+2", run: () => goTo("editor") });
  core({ id: "layout.toggleSidebar", title: "Layout: Show or hide the sidebar", key: "Ctrl+B", run: toggleSidebar });
  core({ id: "layout.toggleShell", title: "Layout: Show or hide the shell", key: "Ctrl+J", run: toggleShell });
  core({ id: "layout.sidebarLeft", title: "Layout: Sidebar on the left", hidden: () => side() === "left", run: () => setNavSide("left") });
  core({ id: "layout.sidebarRight", title: "Layout: Sidebar on the right", hidden: () => side() === "right", run: () => setNavSide("right") });
  core({ id: "layout.mirror", title: "Layout: Mirror columns", run: mirrorColumns });
  core({ id: "layout.reset", title: "Layout: Reset layout", run: resetLayout });
  core({
    id: "editor.save",
    title: "Editor: Save",
    key: "Ctrl+S",
    hidden: () => !useStore.getState().activePath,
    run: () => {
      const path = useStore.getState().activePath;
      if (path) return save(path);
    },
  });

  syncViewCommands();
  useViews.subscribe(syncViewCommands);
  syncPresetCommands();
  useLayoutPresets.subscribe(syncPresetCommands);
}

const viewCommands = new Map<string, { title: string; off: () => void }>();

/** A view's name in its commands: a mod's view names its mod, so it cannot pass for one of the app's. */
const viewName = (def: { title: string; source: string }) =>
  def.source === "core" ? def.title : `${def.title} (${modName(def.source)})`;

/** "Show" and "Hide" for every registered view, built in or from a mod. */
function syncViewCommands() {
  const views = useViews.getState();
  for (const [id, entry] of viewCommands) {
    const def = views[id];
    if (def && viewName(def) === entry.title) continue;
    entry.off();
    viewCommands.delete(id);
  }
  for (const def of Object.values(views)) {
    if (viewCommands.has(def.id)) continue;
    const view = def.id as ViewId;
    const name = viewName(def);
    const open = () => isOpen(useLayout.getState(), view);
    const offShow = core({ id: `layout.show.${view}`, title: `Layout: Show ${name}`, hidden: open, run: () => openView(view) });
    const offHide = core({ id: `layout.hide.${view}`, title: `Layout: Hide ${name}`, hidden: () => !open(), run: () => closeView(view) });
    viewCommands.set(view, {
      title: name,
      off: () => {
        offShow();
        offHide();
      },
    });
  }
}

let presetCommands: (() => void)[] = [];

function syncPresetCommands() {
  presetCommands.forEach((off) => off());
  presetCommands = useLayoutPresets.getState().map((p) => {
    // A preset's id is "<mod id>:<layout id>"; one from an installed mod names it in the palette.
    const mod = p.id.slice(0, p.id.indexOf(":"));
    const source = mod.startsWith("builtin.") ? "core" : mod;
    return registerCommand({ id: `layout.preset.${p.id}`, title: `Layout: ${p.label}`, source, run: () => applyPreset(p.columns) });
  });
}
