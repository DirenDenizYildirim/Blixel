// The window's body: the navigation at its side and the columns of views, a
// full page in place of the columns, or one view alone in zen.

import { Fragment, memo, useEffect } from "react";
import { AgentForm } from "../components/AgentForm";
import { StatusBar } from "../components/EditorPanel";
import { Sidebar as FullSidebar } from "../components/Sidebar";
import { Splitter } from "../components/Splitter";
import { ModsPage } from "../mods/ModsPage";
import { modName } from "../mods/registry";
import { SettingsPage } from "../settings/SettingsPage";
import {
  arrange,
  columnMaxWidth,
  headHeight,
  NAV,
  navMaxWidth,
  noteFocus,
  resetColumnWidth,
  resetNavWidth,
  resetSlotHeight,
  setColumnWidth,
  setNavWidth,
  setSlotHeight,
  SLOT_MIN,
  slotMaxHeight,
  useLayout,
  zenView,
  type PlacedColumn,
  type PlacedSlot,
} from "../model/layout";
import { useStore, type View } from "../model/store";
import { AttentionChip } from "./AttentionChip";
import type { ViewId } from "./types";
import { ViewMenuButton } from "./ViewMenu";
import { useViews, type ViewDef } from "./views";

export function Workspace() {
  const layout = useLayout();
  const views = useViews();
  const page = useStore((s) => s.view);
  const onPage = page.kind !== "main";
  // A page keeps the navigation, so zen waits until the page is left.
  const zen = onPage ? null : zenView(layout, views);
  useFocusIntoFrames();

  const { side, collapsed, width } = layout.nav;
  const splitter = !collapsed && (
    <Splitter
      axis="x"
      label="Resize sidebar"
      value={width}
      min={NAV.min}
      max={navMaxWidth()}
      invert={side === "right"}
      onChange={setNavWidth}
      onReset={resetNavWidth}
    />
  );
  const nav =
    !zen &&
    (side === "left" ? (
      <>
        <Sidebar />
        {splitter}
      </>
    ) : (
      <>
        {splitter}
        <Sidebar />
      </>
    ));

  return (
    <>
      {side === "left" && nav}
      {onPage ? <Page view={page} /> : <Columns columns={arrange(layout, views)} zen={zen} views={views} />}
      {side === "right" && nav}
      {zen && <AttentionChip />}
    </>
  );
}

function Page({ view }: { view: View }) {
  if (view.kind === "agent-form") return <AgentForm key={view.editingId ?? "new"} editingId={view.editingId} />;
  if (view.kind === "settings") return <SettingsPage />;
  return <ModsPage />;
}

const titles = (c: PlacedColumn, views: Record<string, ViewDef>) => c.slots.map((s) => views[s.view].title).join(", ");

function Columns({ columns, zen, views }: { columns: PlacedColumn[]; zen: ViewId | null; views: Record<string, ViewDef> }) {
  // Zen draws the same tree minus everything else, so the view shown keeps its state.
  const shown = zen ? columns.filter((c) => c.slots.some((s) => s.view === zen)) : columns;
  const fill = shown.findIndex((c) => c.fill);
  return (
    <div className="columns">
      {shown.map((c, i) => {
        // A divider sizes the column on the far side from the filling one, so it follows the pointer.
        const target = fill >= i ? shown[i - 1] : c;
        const id = target?.column.id ?? "";
        return (
          <Fragment key={c.column.id}>
            {i > 0 && (
              <Splitter
                axis="x"
                label={`Resize ${titles(target, views)}`}
                value={typeof target.column.width === "number" ? target.column.width : target.minWidth}
                min={target.minWidth}
                max={columnMaxWidth(id)}
                invert={fill < i}
                onChange={(v) => setColumnWidth(id, v)}
                onReset={() => resetColumnWidth(id)}
              />
            )}
            <ColumnView placed={c} zen={zen} views={views} />
          </Fragment>
        );
      })}
    </div>
  );
}

function ColumnView({ placed, zen, views }: { placed: PlacedColumn; zen: ViewId | null; views: Record<string, ViewDef> }) {
  const slots = zen ? placed.slots.filter((s) => s.view === zen) : placed.slots;
  // The editor's status bar sits at the bottom of the editor's column.
  const status = slots.some((s) => s.view === "editor");
  const fill = zen ? 0 : slots.findIndex((s) => s.fill);
  const { width } = placed.column;
  const style = zen
    ? { flex: "1 1 auto", minWidth: 0 }
    : placed.fill
      ? { flex: "1 1 560px", minWidth: placed.minWidth }
      : { flex: `0 1 ${width}px`, minWidth: placed.minWidth };

  return (
    <div className="column" style={style}>
      {slots.map((s, j) => {
        const target = fill >= j ? slots[j - 1] : s;
        return (
          <Fragment key={s.view}>
            {j > 0 && (
              <Splitter
                axis="y"
                label={`Resize ${views[target.view].title}`}
                value={typeof target.slot.height === "number" ? target.slot.height : SLOT_MIN}
                min={SLOT_MIN}
                max={slotMaxHeight(target.view)}
                invert={fill < j}
                onChange={(v) => setSlotHeight(target.view, v)}
                onReset={() => resetSlotHeight(target.view)}
              />
            )}
            <SlotView
              placed={s}
              def={views[s.view]}
              fill={j === fill}
              first={j === 0}
              last={j === slots.length - 1 && !status}
            />
          </Fragment>
        );
      })}
      {status && <StatusBar />}
    </div>
  );
}

function SlotView(props: { placed: PlacedSlot; def: ViewDef; fill: boolean; first: boolean; last: boolean }) {
  const { view, slot } = props.placed;
  return (
    <div
      className="slot"
      data-slot={view}
      data-first={props.first || undefined}
      data-last={props.last || undefined}
      style={{ flex: props.fill ? "1 1 0" : `0 0 ${(slot.height as number) + headHeight(view)}px` }}
      onFocus={() => noteFocus(view)}
      onPointerDown={() => noteFocus(view)}
    >
      <ViewBody def={props.def} />
    </div>
  );
}

/** The sidebar follows the store itself; dragging a divider need not draw it again. */
const Sidebar = memo(FullSidebar);

/** Drawn again only when the view itself changes, not on every resize. */
const ViewBody = memo(function ViewBody({ def }: { def: ViewDef }) {
  return def.source === "core" ? def.render() : <ModView def={def} />;
});

/** A mod's view gets a slim head from the layout: its title, its menu, and room to drag the window. */
function ModView({ def }: { def: ViewDef }) {
  return (
    <section className="mod-view" aria-label={def.title}>
      <div className="mod-view-head" data-tauri-drag-region>
        <span className="mod-view-title ellipsis" title={`${def.title}, from ${modName(def.source)}`} data-tauri-drag-region>
          {def.title}
        </span>
        <span className="grow" data-tauri-drag-region />
        <ViewMenuButton view={def.id} />
      </div>
      <div className="mod-view-body">{def.render()}</div>
    </section>
  );
}

/** Focus moving into a mod's frame never reaches this page as an event; the window losing focus does. */
function useFocusIntoFrames() {
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const slot = document.activeElement?.closest<HTMLElement>("[data-slot]")?.dataset.slot;
        if (slot) noteFocus(slot as ViewId);
      });
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);
}
