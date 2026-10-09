// Keeps the theme on screen in step with the user's choice and the enabled
// mods. `store.theme` is always the theme actually shown, so views that read
// tokens (the shell) redraw when it changes. A saved theme from an installed
// mod shows once mods have loaded; until then, or if it is gone, Slate shows.

import { findTheme, useMods } from "../mods/registry";
import { useStore } from "../model/store";
import { applyTheme, FALLBACK_THEME, FALLBACK_THEME_ID, savedThemeId, type AppliedTheme } from "./theme";

const resolve = (id: string): AppliedTheme | null =>
  findTheme(id) ?? (id === FALLBACK_THEME_ID ? FALLBACK_THEME : null);

let shown: AppliedTheme | null = null;

function show(theme: AppliedTheme) {
  if (shown && shown.id === theme.id && shown.tokens === theme.tokens && shown.light === theme.light) return;
  applyTheme(theme);
  shown = theme;
}

/** Applies the saved theme now and follows changes. Call once, before the first render. */
export function installThemes() {
  const saved = savedThemeId();
  // The saved theme, while its mod may still be loading.
  let waiting: string | null = saved;

  const sync = () => {
    const wanted = useStore.getState().theme;
    const theme = resolve(wanted);
    if (theme) {
      show(theme);
      return;
    }
    // Its mod was turned off or removed: show Slate, but keep the saved choice
    // in case the mod comes back next time.
    show(FALLBACK_THEME);
    useStore.setState({ theme: FALLBACK_THEME_ID });
  };

  const now = resolve(saved);
  useStore.setState({ theme: now ? saved : FALLBACK_THEME_ID });
  if (now) waiting = null;
  sync();

  useStore.subscribe((s, prev) => {
    if (s.theme !== prev.theme) sync();
  });

  useMods.subscribe((s, prev) => {
    if (s.mods === prev.mods && s.ready === prev.ready) return;
    // The saved theme's mod has loaded, and the user has not picked another
    // theme meanwhile (picking one saves it).
    if (waiting && waiting === savedThemeId() && findTheme(waiting)) {
      const id = waiting;
      waiting = null;
      useStore.setState({ theme: id });
      return;
    }
    if (s.ready) waiting = null;
    sync();
  });
}
