// A small drawing of an arrangement: the navigation at its side and the
// columns of views, sized in proportion to a window. The Settings page draws
// each layout preset with it, and this window's own layout, live.

import { useEffect, useState } from "react";
import type { Column, NavState, ViewId } from "../layout/types";
import type { ViewDef } from "../layout/views";
import { arrange, headHeight, RAIL_WIDTH, type PlacedColumn } from "../model/layout";

/** Matches .statusbar and the filling slot's minimum in model/layout.ts, near enough for a drawing. */
const STATUS_BAR = 52;
const FILL_MIN = 160;

export function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** The views each column shows, in order, as one string: two arrangements with the same shape show the same thing. */
export function shapeOf(columns: Column[], views: Record<string, ViewDef>, nav: NavState): string {
  return arrange({ v: 2, nav, columns, zen: null }, views)
    .map((c) => c.slots.map((s) => s.view).join("+"))
    .join("|");
}

const widthOf = (c: PlacedColumn) => Math.max(c.minWidth, typeof c.column.width === "number" ? c.column.width : c.minWidth);

export function LayoutMap(props: {
  columns: Column[];
  views: Record<string, ViewDef>;
  nav: NavState;
  /** The window it is drawn for, in px. */
  width: number;
  height: number;
  /** The view shown alone, highlighted. */
  zen?: ViewId | null;
  /** Draws a hint of the sidebar's contents, for the larger map. */
  detail?: boolean;
}) {
  const { nav, views, width, height, zen } = props;
  const navWidth = nav.collapsed ? RAIL_WIDTH : nav.width;
  const placed = arrange({ v: 2, nav, columns: props.columns, zen: null }, views);
  const fixed = placed.reduce((sum, c) => sum + (c.fill ? 0 : widthOf(c)), 0);
  const room = width - navWidth - (placed.length - 1);

  const strip = (
    <span className="lmap-nav" data-collapsed={nav.collapsed || undefined} style={{ flexBasis: `${(navWidth / width) * 100}%` }}>
      {props.detail && (
        <>
          <i className="lmap-brand" />
          {nav.collapsed ? (
            <>
              <i className="lmap-dot" />
              <i className="lmap-dot" />
              <i className="lmap-dot" />
            </>
          ) : (
            <>
              <i className="lmap-line" />
              <i className="lmap-line short" />
              <i className="lmap-line" />
              <i className="lmap-line short" />
            </>
          )}
        </>
      )}
    </span>
  );

  return (
    <span className="lmap" data-side={nav.side} data-zen={zen ? "" : undefined} style={{ aspectRatio: `${width} / ${height}` }}>
      {nav.side === "left" && strip}
      <span className="lmap-cols">
        {placed.map((c) => {
          const status = c.slots.some((s) => s.view === "editor") ? STATUS_BAR : 0;
          const others = c.slots.reduce((sum, s) => sum + (s.fill ? 0 : (s.slot.height as number) + headHeight(s.view)), 0);
          return (
            <span key={c.column.id} className="lmap-col" style={{ flexGrow: c.fill ? Math.max(c.minWidth, room - fixed) : widthOf(c) }}>
              {c.slots.map((s) => (
                <span
                  key={s.view}
                  className="lmap-slot"
                  data-zen={zen === s.view || undefined}
                  style={{ flexGrow: s.fill ? Math.max(FILL_MIN, height - others - status) : (s.slot.height as number) + headHeight(s.view) }}
                >
                  <span className="lmap-name">{views[s.view].title}</span>
                </span>
              ))}
            </span>
          );
        })}
      </span>
      {nav.side === "right" && strip}
    </span>
  );
}
