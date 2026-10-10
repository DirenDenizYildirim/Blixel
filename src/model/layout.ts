// The window's arrangement: the navigation at one edge, a row of columns of
// views, their sizes, and zen. Remembered between launches in the web view's
// local storage; if that is unavailable the defaults are used.

import { create } from "zustand";
import { DEFAULT_COLUMNS, type Column, type LayoutState, type NavState, type Slot, type ViewId } from "../layout/types";
import { useViews, type ViewDef } from "../layout/views";
import { notify } from "./store";

/** The navigation's width when open; collapsed it is the rail. */
export const NAV = { min: 180, max: 420, initial: 232 };
export const RAIL_WIDTH = 64;
/** The desktop window's minimum width: a layout that fits it is always allowed. */
const MIN_WINDOW = 960;
/** Shortest a slot with a set height may be, below its view's head. */
export const SLOT_MIN = 72;
/** What a column's filling slot keeps at least when another slot grows. */
const FILL_MIN = 160;
/** Heights the layout draws between and under slots: a divider, and the editor's status bar. */
const SPLIT_Y = 12;
const STATUS_BAR = 52;
/** The slim head the layout draws over a mod's view (.mod-view-head in styles.css). */
const MOD_HEAD = 40;

/**
 * What a view's head adds to its slot's height. A slot's height counts what
 * the view shows under its head, so the shell's height is its terminal's, as
 * it always was, and a mod's is its page's.
 */
export const headHeight = (view: ViewId) => (view === "shell" || view === "tasks" ? 32 : view.startsWith("mod:") ? MOD_HEAD : 0);

/** Widths a view gets in a column of its own, and heights when stacked under other views. */
const WIDTHS: Partial<Record<ViewId, number>> = { chat: 440, editor: 560, shell: 420, tasks: 380 };
const HEIGHTS: Partial<Record<ViewId, number>> = { chat: 360, editor: 360, shell: 150, tasks: 220 };

const KEY = "blixel.layout";
const DEFAULT_NAV: NavState = { side: "left", width: NAV.initial, collapsed: false };

const CORE_VIEWS = new Set<string>(["chat", "editor", "shell", "tasks"]);
const isViewId = (v: unknown): v is ViewId =>
  typeof v === "string" && (CORE_VIEWS.has(v) || /^mod:[^:\s]+:[^:\s]+$/.test(v));

function defaultWidth(view: ViewId): number {
  return WIDTHS[view] ?? Math.max(360, useViews.getState()[view]?.minWidth ?? 0);
}

/** The default layout's height for a view, so resets and moves agree with it. */
function defaultHeight(view: ViewId): number {
  for (const c of DEFAULT_COLUMNS) for (const s of c.slots) if (s.view === view && typeof s.height === "number") return s.height;
  return HEIGHTS[view] ?? 240;
}

const px = (value: unknown, fallback: number, min: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(4000, Math.max(min, value))) : fallback;

// ---- Repair ----

/**
 * Makes any stored or changed layout valid: each view at most once, one
 * filling slot per column, exactly one filling column, the chat or the editor
 * open, zen only on an open view. Views that are not registered (a mod not
 * loaded yet) keep their place.
 */
function repair(input: unknown): LayoutState {
  const s = (input ?? {}) as Partial<LayoutState>;
  const rawColumns = Array.isArray(s.columns) ? s.columns : [];
  const taken = new Set(rawColumns.map((c) => c?.id).filter((id): id is string => typeof id === "string" && id !== ""));
  const ids = new Set<string>();
  const seen = new Set<string>();
  const columns: Column[] = [];

  for (const c of rawColumns) {
    const slots: Slot[] = [];
    for (const sl of Array.isArray(c?.slots) ? c.slots : []) {
      if (!isViewId(sl?.view) || seen.has(sl.view)) continue;
      seen.add(sl.view);
      slots.push({
        view: sl.view,
        open: sl.open !== false,
        height: sl.height === "fill" ? "fill" : px(sl.height, defaultHeight(sl.view), SLOT_MIN),
      });
    }
    if (!slots.length) continue;
    const keep = slots.find((sl) => sl.height === "fill") ?? slots[slots.length - 1];
    for (const sl of slots) if (sl !== keep && sl.height === "fill") sl.height = defaultHeight(sl.view);
    keep.height = "fill";
    let id = typeof c.id === "string" && c.id && !ids.has(c.id) ? c.id : "";
    if (!id) id = freshId(new Set([...taken, ...ids]));
    ids.add(id);
    columns.push({ id, width: c.width === "fill" ? "fill" : px(c.width, defaultWidth(slots[0].view), 120), slots });
  }

  // Never leave nothing to look at.
  const state: LayoutState = { v: 2, nav: DEFAULT_NAV, columns, zen: null };
  if (!isOpen(state, "chat") && !isOpen(state, "editor")) {
    const chat = find(state, "chat");
    if (chat) chat.slot.open = true;
    else place(state, "chat");
  }

  const fills = columns.filter((c) => c.width === "fill");
  const fill = fills[0] ?? find(state, "editor")?.column ?? columns[columns.length - 1];
  for (const c of columns) if (c !== fill && c.width === "fill") c.width = defaultWidth(c.slots[0].view);
  fill.width = "fill";

  const nav = (s.nav ?? {}) as Partial<NavState>;
  state.nav = {
    side: nav.side === "right" ? "right" : "left",
    width: Math.min(NAV.max, px(nav.width, NAV.initial, NAV.min)),
    collapsed: nav.collapsed === true,
  };
  state.zen = isViewId(s.zen) && isOpen(state, s.zen) ? s.zen : null;
  return state;
}

function freshId(taken: Set<string>): string {
  let n = 1;
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
}

function find(s: LayoutState, view: ViewId): { column: Column; index: number; slot: Slot } | undefined {
  for (let index = 0; index < s.columns.length; index++) {
    const slot = s.columns[index].slots.find((sl) => sl.view === view);
    if (slot) return { column: s.columns[index], index, slot };
  }
  return undefined;
}

/** Puts a view that is not in the layout at all where it usually goes. */
function place(s: LayoutState, view: ViewId) {
  const column = (width: number | "fill"): Column => ({
    id: freshId(new Set(s.columns.map((c) => c.id))),
    width,
    slots: [{ view, open: true, height: "fill" }],
  });
  const editor = find(s, "editor");
  if (view === "chat") s.columns.unshift(column(defaultWidth("chat")));
  else if (view === "editor") {
    // The editor takes the room; the column that filled before keeps a width.
    const chat = find(s, "chat");
    s.columns.splice(chat ? chat.index + 1 : s.columns.length, 0, column("fill"));
    for (const c of s.columns) if (c.width === "fill" && c.slots[0].view !== "editor") c.width = defaultWidth(c.slots[0].view);
  } else if (view === "shell" && editor) editor.column.slots.push({ view, open: true, height: defaultHeight(view) });
  else if (view === "tasks" && find(s, "chat")) find(s, "chat")!.column.slots.push({ view, open: true, height: defaultHeight(view) });
  else s.columns.push(column(defaultWidth(view)));
}

// ---- Reading the layout ----

export function isOpen(s: LayoutState, view: ViewId): boolean {
  return Boolean(find(s, view)?.slot.open);
}

export interface PlacedSlot {
  view: ViewId;
  slot: Slot;
  /** Takes the column's remaining height: its filling slot, or the last drawn one if that is closed. */
  fill: boolean;
}

export interface PlacedColumn {
  column: Column;
  slots: PlacedSlot[];
  /** Takes the remaining width: the filling column, or the last drawn one if that has nothing to show. */
  fill: boolean;
  minWidth: number;
}

/** The columns and slots that are drawn: open, with their view registered. */
export function arrange(s: LayoutState, views: Record<string, ViewDef>): PlacedColumn[] {
  const placed: PlacedColumn[] = [];
  for (const column of s.columns) {
    const shown = column.slots.filter((sl) => sl.open && views[sl.view]);
    if (!shown.length) continue;
    let f = shown.findIndex((sl) => sl.height === "fill");
    if (f < 0) f = shown.length - 1;
    placed.push({
      column,
      slots: shown.map((slot, i) => ({ view: slot.view, slot, fill: i === f })),
      fill: false,
      minWidth: Math.max(0, ...shown.map((sl) => views[sl.view].minWidth)),
    });
  }
  const f = placed.findIndex((c) => c.column.width === "fill");
  if (placed.length) placed[f < 0 ? placed.length - 1 : f].fill = true;
  return placed;
}

/** The view shown alone, if zen is on and that view can be drawn. */
export function zenView(s: LayoutState, views: Record<string, ViewDef>): ViewId | null {
  return s.zen && views[s.zen] && isOpen(s, s.zen) ? s.zen : null;
}

/** Narrowest the window may be for this layout without squeezing a view below its minimum. */
function neededWidth(s: LayoutState): number {
  const columns = arrange(s, useViews.getState());
  const nav = s.nav.collapsed ? RAIL_WIDTH : s.nav.width + 1;
  return nav + columns.reduce((sum, c) => sum + c.minWidth, 0) + Math.max(0, columns.length - 1);
}

// ---- The store ----

function defaults(): LayoutState {
  return repair({ v: 2, nav: DEFAULT_NAV, columns: structuredClone(DEFAULT_COLUMNS), zen: null });
}

/** The first layout format: the chat, then the editor with the shell inside it. */
interface LayoutV1 {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  chatWidth: number;
  chatOpen: boolean;
  editorOpen: boolean;
  shellOpen: boolean;
  shellHeight: number;
}

function fromV1(old: Partial<LayoutV1>): LayoutState {
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    v: 2,
    nav: { side: "left", width: num(old.sidebarWidth, NAV.initial), collapsed: old.sidebarCollapsed === true },
    columns: [
      { id: "c1", width: num(old.chatWidth, 440), slots: [{ view: "chat", open: old.chatOpen !== false, height: "fill" }] },
      {
        id: "c2",
        width: "fill",
        slots: [
          { view: "editor", open: old.editorOpen !== false, height: "fill" },
          // The shell was drawn inside the editor, so a hidden editor hid it too.
          { view: "shell", open: old.shellOpen !== false && old.editorOpen !== false, height: num(old.shellHeight, 150) },
        ],
      },
    ],
    zen: null,
  };
}

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw);
    return repair(saved?.v === 2 ? saved : fromV1(saved ?? {}));
  } catch {
    return defaults();
  }
}

export const useLayout = create<LayoutState>(load);

useLayout.subscribe((layout) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Storage can be blocked; the layout then simply resets next launch.
  }
});

const get = useLayout.getState;
const draft = (): LayoutState => structuredClone(get());

/** Puts a changed layout in place, repaired. Refuses one that needs more width than the window has. */
function commit(next: LayoutState): boolean {
  const fixed = repair(next);
  const need = neededWidth(fixed);
  if (need > Math.max(window.innerWidth, MIN_WINDOW) && need > neededWidth(get())) {
    notify("There is no room for that in this window. Hide a view or make the window wider.");
    return false;
  }
  useLayout.setState(fixed, true);
  return true;
}

/** For sizes: no room check, the value is clamped instead. */
const put = (next: LayoutState) => useLayout.setState(repair(next), true);

// ---- Views ----

export function openView(view: ViewId): boolean {
  const s = draft();
  const at = find(s, view);
  if (at?.slot.open) return true;
  if (at) at.slot.open = true;
  else place(s, view);
  return commit(s);
}

/** Hiding the chat or the editor always leaves the other one showing. */
export function closeView(view: ViewId): boolean {
  const s = draft();
  const at = find(s, view);
  if (!at?.slot.open) return true;
  at.slot.open = false;
  if (view === "chat" || view === "editor") {
    const other = view === "chat" ? "editor" : "chat";
    const there = find(s, other);
    if (there) there.slot.open = true;
    else place(s, other);
  }
  if (s.zen === view) s.zen = null;
  return commit(s);
}

export type MoveTarget =
  /** One place left (-1) or right (1). A view alone in its column takes the column along; one stacked with others gets a new column on that side. */
  | { step: -1 | 1 }
  /** Into a new column just left or right of its own. */
  | { newColumn: "left" | "right" }
  /** Under the views of another column. */
  | { column: string };

export function moveView(view: ViewId, to: MoveTarget): boolean {
  const s = draft();
  const at = find(s, view);
  if (!at) return false;
  const views = useViews.getState();
  const drawn = (c: Column) => c.slots.some((sl) => sl.open && views[sl.view]);
  const alone = at.column.slots.every((sl) => sl.view === view || !sl.open || !views[sl.view]);

  if ("step" in to) {
    if (!alone) return moveView(view, { newColumn: to.step < 0 ? "left" : "right" });
    // Swap with the nearest column that shows something; closed slots travel along.
    let j = at.index + to.step;
    while (j >= 0 && j < s.columns.length && !drawn(s.columns[j])) j += to.step;
    if (j < 0 || j >= s.columns.length) return false;
    s.columns.splice(at.index, 1);
    s.columns.splice(j, 0, at.column);
    return commit(s);
  }

  const taken = new Set(s.columns.map((c) => c.id));
  at.column.slots = at.column.slots.filter((sl) => sl !== at.slot);
  if ("newColumn" in to) {
    if (alone) return false;
    s.columns.splice(to.newColumn === "left" ? at.index : at.index + 1, 0, {
      id: freshId(taken),
      width: defaultWidth(view),
      slots: [{ view, open: true, height: "fill" }],
    });
    return commit(s);
  }

  const target = s.columns.find((c) => c.id === to.column);
  if (!target || target === at.column) return false;
  target.slots.push({ view, open: true, height: at.slot.height === "fill" ? defaultHeight(view) : at.slot.height });
  // The column that took the room is gone; the one the view joined takes it over.
  if (!at.column.slots.length && at.column.width === "fill") target.width = "fill";
  return commit(s);
}

// ---- Zen ----

let focused: ViewId = "chat";

/** Remembers the view the user last worked in, for zen. */
export function noteFocus(view: ViewId) {
  focused = view;
}

/** The view zen would show: the last one focused if it is still open, else the chat or the editor. */
export function focusedView(): ViewId {
  const s = get();
  if (useViews.getState()[focused] && isOpen(s, focused)) return focused;
  return isOpen(s, "chat") ? "chat" : "editor";
}

/** Shows one view alone (opening it if it is hidden), or null to show the whole layout again. */
export function setZen(view: ViewId | null): boolean {
  if (view && !isOpen(get(), view) && !openView(view)) return false;
  put({ ...draft(), zen: view });
  return true;
}

export function toggleZen(view?: ViewId) {
  setZen(zenView(get(), useViews.getState()) ? null : (view ?? focusedView()));
}

// ---- Navigation ----

export function setNavSide(side: "left" | "right") {
  commit({ ...draft(), nav: { ...get().nav, side } });
}

export function setNavCollapsed(collapsed: boolean): boolean {
  return commit({ ...draft(), nav: { ...get().nav, collapsed } });
}

export function toggleSidebar() {
  setNavCollapsed(!get().nav.collapsed);
}

export function expandSidebar(): boolean {
  return setNavCollapsed(false);
}

/** Widest the navigation may be without squeezing the columns below their minimum. */
export function navMaxWidth(): number {
  const s = get();
  const columns = neededWidth({ ...s, nav: { ...s.nav, collapsed: true } }) - RAIL_WIDTH;
  return Math.max(NAV.min, Math.min(NAV.max, window.innerWidth - columns - 1));
}

export function setNavWidth(width: number) {
  put({ ...draft(), nav: { ...get().nav, width: Math.round(Math.min(navMaxWidth(), Math.max(NAV.min, width))) } });
}

export function resetNavWidth() {
  setNavWidth(NAV.initial);
}

// ---- Sizes ----

/** Widest a column may be while the others keep their widths and the filling one its minimum. */
export function columnMaxWidth(id: string): number {
  const s = get();
  const columns = arrange(s, useViews.getState());
  const self = columns.find((c) => c.column.id === id);
  if (!self) return 0;
  const nav = s.nav.collapsed ? RAIL_WIDTH : s.nav.width + 1;
  const others = columns
    .filter((c) => c !== self)
    .reduce((sum, c) => sum + (c.fill || c.column.width === "fill" ? c.minWidth : Math.max(c.minWidth, c.column.width as number)), 0);
  return Math.max(self.minWidth, window.innerWidth - nav - others - (columns.length - 1));
}

export function setColumnWidth(id: string, width: number) {
  const s = draft();
  const column = s.columns.find((c) => c.id === id);
  const self = arrange(get(), useViews.getState()).find((c) => c.column.id === id);
  if (!column || !self || column.width === "fill") return;
  column.width = Math.round(Math.min(columnMaxWidth(id), Math.max(self.minWidth, width)));
  put(s);
}

export function resetColumnWidth(id: string) {
  const column = get().columns.find((c) => c.id === id);
  const first = column && arrange(get(), useViews.getState()).find((c) => c.column === column)?.slots[0];
  if (first) setColumnWidth(id, defaultWidth(first.view));
}

/** Tallest a slot may be while the others in its column keep their heights and the filling one its minimum. */
export function slotMaxHeight(view: ViewId): number {
  const column = arrange(get(), useViews.getState()).find((c) => c.slots.some((sl) => sl.view === view));
  if (!column) return SLOT_MIN;
  const others = column.slots
    .filter((sl) => sl.view !== view)
    .reduce((sum, sl) => sum + (sl.fill || sl.slot.height === "fill" ? FILL_MIN : (sl.slot.height as number) + headHeight(sl.view)), 0);
  const status = column.slots.some((sl) => sl.view === "editor") ? STATUS_BAR : 0;
  const room = window.innerHeight - others - status - SPLIT_Y * (column.slots.length - 1) - headHeight(view);
  return Math.max(SLOT_MIN, room);
}

export function setSlotHeight(view: ViewId, height: number) {
  const s = draft();
  const at = find(s, view);
  if (!at || at.slot.height === "fill") return;
  at.slot.height = Math.round(Math.min(slotMaxHeight(view), Math.max(SLOT_MIN, height)));
  put(s);
}

export function resetSlotHeight(view: ViewId) {
  setSlotHeight(view, defaultHeight(view));
}

// ---- Whole layouts ----

/** Reverses the order of the columns. */
export function mirrorColumns() {
  const s = draft();
  s.columns.reverse();
  commit(s);
}

/** Uses a preset's columns; the navigation and zen stay as they are. */
export function applyPreset(columns: Column[]): boolean {
  return commit({ ...draft(), columns: structuredClone(columns) });
}

export function resetLayout() {
  commit(defaults());
}

// ---- The first layout's calls, still used across the interface ----

export const setChatOpen = (open: boolean) => (open ? openView("chat") : closeView("chat"));
export const setEditorOpen = (open: boolean) => (open ? openView("editor") : closeView("editor"));
export const setShellOpen = (open: boolean) => (open ? openView("shell") : closeView("shell"));

export function toggleShell() {
  setShellOpen(!isOpen(get(), "shell"));
}
