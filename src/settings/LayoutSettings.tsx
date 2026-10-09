// Where the sidebar sits, the arrangements on offer, which panels show, and zen.

import { keyBindings } from "../commands/keys";
import { runCommand, useCommands } from "../commands/registry";
import { Segmented } from "../components/controls";
import { useLayoutPresets } from "../layout/presets";
import type { ViewId } from "../layout/types";
import { useViews, type ViewDef } from "../layout/views";
import { modName } from "../mods/registry";
import {
  applyPreset,
  closeView,
  isOpen,
  mirrorColumns,
  openView,
  resetLayout,
  setNavCollapsed,
  setNavSide,
  setZen,
  useLayout,
} from "../model/layout";
import { showView } from "../model/store";
import { Keycaps } from "./Keycaps";
import { LayoutMap, shapeOf, useWindowSize } from "./LayoutMap";

/** A switch for a settings row, whose text sits to its left. */
function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className="switch"
      onClick={() => props.onChange(!props.checked)}
    >
      <span />
    </button>
  );
}

const VIEW_HINTS: Record<string, string> = {
  chat: "The selected agent's conversation",
  editor: "Open files, shared with the agents",
  shell: "The selected agent's terminal",
};

/** A preset's id is "<mod id>:<layout id>"; the built-in ones come from "builtin." mods. */
function presetSource(id: string): string | null {
  const mod = id.slice(0, id.indexOf(":"));
  return mod.startsWith("builtin.") ? null : modName(mod);
}

function tryZen() {
  showView({ kind: "main" });
  // The chat's own command puts the cursor in it, now in zen.
  if (setZen("chat")) void runCommand("layout.chat").catch(() => undefined);
}

export function LayoutSettings() {
  const layout = useLayout();
  const views = useViews();
  const presets = useLayoutPresets();
  const size = useWindowSize();
  useCommands();
  const keys = keyBindings().byCommand;
  const { nav } = layout;
  const shape = shapeOf(layout.columns, views, nav);
  const current = presets.find((p) => shapeOf(p.columns, views, nav) === shape)?.id;
  const sidebarKey = keys.get("layout.toggleSidebar");

  return (
    <section id="settings-layout" aria-labelledby="settings-layout-title" className="panel">
      <h2 id="settings-layout-title" className="tight">
        Layout
      </h2>
      <div className="hint-line">How the window is arranged. The map of this window follows every change.</div>

      <div className="set-block first">
        <h3>Sidebar</h3>
        <div className="tool-row">
          <div className="tool-text">
            <span>Side</span>
            <span className="label">The edge the navigation sits on</span>
          </div>
          <Segmented
            label="Sidebar side"
            value={nav.side}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
            onChange={setNavSide}
          />
        </div>
        <div className="tool-row">
          <div className="tool-text">
            <span>Collapse sidebar</span>
            <span className="label">Icons and avatars only</span>
          </div>
          {sidebarKey && <Keycaps keys={sidebarKey} />}
          <Toggle label="Collapse sidebar" checked={nav.collapsed} onChange={setNavCollapsed} />
        </div>
      </div>

      <div className="set-block">
        <h3>Arrangement</h3>
        <div className="hint-line">Where the panels sit. Layouts from mods appear here too.</div>
        <div role="group" aria-label="Arrangement" className="settings-grid presets">
          {presets.map((p) => {
            const source = presetSource(p.id);
            const on = p.id === current;
            return (
              <button
                key={p.id}
                type="button"
                className="choice settings-card"
                aria-pressed={on}
                onClick={() => applyPreset(p.columns)}
              >
                <LayoutMap columns={p.columns} views={views} nav={nav} width={size.width} height={size.height} />
                <span className="choice-title ellipsis">{p.label}</span>
                <span className="choice-hint ellipsis">{on ? "Current" : source ? `From ${source}` : "Built in"}</span>
              </button>
            );
          })}
        </div>
        <div className="row wrap gap8 top14">
          <button type="button" className="btn" onClick={mirrorColumns}>
            Mirror columns
          </button>
          <button type="button" className="btn" onClick={resetLayout}>
            Reset layout
          </button>
        </div>
      </div>

      <div className="set-block">
        <h3>Panels</h3>
        <div className="hint-line">A hidden panel keeps its place and comes back to it.</div>
        {Object.values(views).map((v) => (
          <PanelRow key={v.id} def={v} />
        ))}
      </div>

      <div className="set-block">
        <h3>Zen mode</h3>
        <div className="zen-text">
          One panel alone, with the rest of the layout kept as it is. Agents that need you show as a small chip in the corner.
        </div>
        <div className="zen-keys">
          {[
            { id: "layout.zen", what: "zen on or off" },
            { id: "layout.chat", what: "the chat" },
            { id: "layout.editor", what: "the editor" },
          ].map(({ id, what }) => {
            const key = keys.get(id);
            return (
              key && (
                <span key={id} className="zen-key">
                  <Keycaps keys={key} />
                  <span className="label">{what}</span>
                </span>
              )
            );
          })}
        </div>
        <button type="button" className="btn top14" onClick={tryZen}>
          Try zen mode
        </button>
      </div>
    </section>
  );
}

/** Shows or hides one view. The chat or the editor always shows, so the last of them cannot be hidden here. */
function PanelRow({ def }: { def: ViewDef }) {
  const layout = useLayout();
  const id = def.id as ViewId;
  const open = isOpen(layout, id);
  const partner = id === "chat" ? "editor" : id === "editor" ? "chat" : null;
  const required = open && partner !== null && !isOpen(layout, partner);
  const hint = required
    ? `Shows while the ${partner} is hidden: one of them always does`
    : def.source === "core"
      ? (VIEW_HINTS[id] ?? "")
      : `From ${modName(def.source)}`;
  return (
    <div className="tool-row">
      <div className="tool-text">
        <span>{def.title}</span>
        {hint && <span className="label">{hint}</span>}
      </div>
      <Toggle
        label={`Show ${def.title}`}
        checked={open}
        disabled={required}
        onChange={(on) => (on ? openView(id) : closeView(id))}
      />
    </div>
  );
}
