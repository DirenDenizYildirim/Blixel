// The window's arrangement: the navigation at one edge, then a row of columns,
// each a stack of views. Zen shows one view alone over an unchanged layout.

/** A view the layout can place: built in, or `mod:<mod id>:<view id>` from a mod. */
export type ViewId = "chat" | "editor" | "shell" | `mod:${string}:${string}`;

export interface Slot {
  view: ViewId;
  /** Closed slots keep their place, so reopening a view puts it back where it was. */
  open: boolean;
  /** Height in px, or "fill" for the slot that takes the rest (one per column). */
  height: number | "fill";
}

export interface Column {
  id: string;
  /** Width in px, or "fill" for the column that takes the rest (one per layout). */
  width: number | "fill";
  slots: Slot[];
}

export interface NavState {
  side: "left" | "right";
  width: number;
  collapsed: boolean;
}

export interface LayoutState {
  v: 2;
  nav: NavState;
  columns: Column[];
  /** The view shown alone, or null. */
  zen: ViewId | null;
}

/** A layout a mod (or the built-in presets) offers; nav side and zen stay as the user has them. */
export interface LayoutPreset {
  id: string;
  label: string;
  columns: Column[];
}

/** The default: chat, then the editor with the selected agent's shell under it (the approved main screen). */
export const DEFAULT_COLUMNS: Column[] = [
  { id: "c1", width: 440, slots: [{ view: "chat", open: true, height: "fill" }] },
  {
    id: "c2",
    width: "fill",
    slots: [
      { view: "editor", open: true, height: "fill" },
      { view: "shell", open: true, height: 150 },
    ],
  },
];
