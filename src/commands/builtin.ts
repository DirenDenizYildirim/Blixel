// Commands this part of the app provides: the palette, the Settings and Mods
// pages, and one command per theme of the enabled mods (kept in step as mods
// change). The layout and editor commands are registered next to the code they run.

import { availableThemes, useMods, type AvailableTheme } from "../mods/registry";
import { setTheme, showView } from "../model/store";
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
  syncThemeCommands();
  useMods.subscribe((s, prev) => {
    if (s.mods !== prev.mods) syncThemeCommands();
  });
}
