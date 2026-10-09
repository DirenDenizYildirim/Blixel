// Layout presets offered to the user, from built-in and enabled mods. The mod
// registry fills this; Settings and the palette read it.

import { create } from "zustand";
import type { LayoutPreset } from "./types";

export const useLayoutPresets = create<LayoutPreset[]>(() => []);

export function setLayoutPresets(presets: LayoutPreset[]) {
  useLayoutPresets.setState(presets, true);
}
