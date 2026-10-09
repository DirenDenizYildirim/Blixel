// The small "⋯" menu in each view's head: zen, moving the view, hiding it.

import { useRef, useState } from "react";
import { arrange, closeView, moveView, setZen, useLayout, zenView } from "../model/layout";
import { MoreIcon } from "./icons";
import { PopupMenu, type MenuItem } from "./Menu";
import type { ViewId } from "./types";
import { useViews } from "./views";

function viewMenuItems(view: ViewId): MenuItem[] {
  const layout = useLayout.getState();
  const views = useViews.getState();
  const inZen = zenView(layout, views) === view;
  const zen: MenuItem = { label: inZen ? "Leave zen mode" : "Zen mode", hint: "Ctrl+.", run: () => setZen(inZen ? null : view) };
  const hide: MenuItem = { label: "Hide", run: () => closeView(view) };
  // Moving changes nothing that zen shows, so it waits until zen is left.
  if (inZen) return [zen, "separator", hide];

  const columns = arrange(layout, views);
  const here = columns.findIndex((c) => c.slots.some((s) => s.view === view));
  const items: MenuItem[] = [zen, "separator"];
  if (columns[here]?.slots.length === 1) {
    items.push(
      { label: "Move left", disabled: here <= 0, run: () => moveView(view, { step: -1 }) },
      { label: "Move right", disabled: here >= columns.length - 1, run: () => moveView(view, { step: 1 }) },
    );
  } else {
    items.push(
      { label: "Move to a new column on the left", run: () => moveView(view, { newColumn: "left" }) },
      { label: "Move to a new column on the right", run: () => moveView(view, { newColumn: "right" }) },
    );
  }
  columns.forEach((c, i) => {
    if (i === here) return;
    const names = c.slots.map((s) => views[s.view].title).join(", ");
    items.push({ label: `Move under ${names}`, run: () => moveView(view, { column: c.column.id }) });
  });
  items.push("separator", hide);
  return items;
}

export function ViewMenuButton({ view, className }: { view: ViewId; className?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const title = useViews((v) => v[view]?.title ?? "View");
  const label = `${title} options`;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={"icon-btn small muted" + (className ? ` ${className}` : "")}
        aria-label={label}
        title="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon />
      </button>
      {open && <PopupMenu anchor={button.current} label={label} items={viewMenuItems(view)} onClose={() => setOpen(false)} />}
    </>
  );
}
