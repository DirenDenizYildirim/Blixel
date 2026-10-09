// Every view the layout can place, built in or from a mod. The layout keeps
// only view ids; this registry says what each id draws.

import type { ReactNode } from "react";
import { create } from "zustand";
import type { ViewId } from "./types";

export interface ViewDef {
  id: ViewId;
  title: string;
  /** Narrowest it may be drawn, in px. */
  minWidth: number;
  /** Who provides it: "core", or the mod's id. */
  source: string;
  render: () => ReactNode;
}

export const useViews = create<Record<string, ViewDef>>(() => ({}));

/** Adds a view; the returned function removes it again (its slot stays, closed or empty). */
export function registerView(def: ViewDef): () => void {
  useViews.setState({ [def.id]: def });
  return () => {
    const current = useViews.getState()[def.id];
    if (current !== def) return;
    const next = { ...useViews.getState() };
    delete next[def.id];
    useViews.setState(next, true);
  };
}

export const viewDef = (id: ViewId): ViewDef | undefined => useViews.getState()[id];
