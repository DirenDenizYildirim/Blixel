// The themes of every enabled mod, each drawn as a small window in its own colours.

import { useThemes } from "../mods/registry";
import type { ThemeTokens } from "../mods/types";
import { setTheme, showView, useStore } from "../model/store";

/** A miniature main screen: the sidebar, a chat card with its composer, and code. Colours from the theme itself. */
function ThemeMock({ t }: { t: ThemeTokens }) {
  const bar = (color: string, width: string) => <i className="tm-bar" style={{ background: color, width }} />;
  return (
    <span className="theme-mock" style={{ background: t.bg, borderColor: t.line }} aria-hidden="true">
      <span className="tm-side" style={{ background: t.side }}>
        <i className="tm-dot" style={{ background: t.accent }} />
        {bar(t.muted, "80%")}
        {bar(t.muted, "55%")}
        {bar(t.muted, "70%")}
      </span>
      <span className="tm-chat">
        <span className="tm-card" style={{ background: t.card, borderColor: t.border }}>
          {bar(t.strong, "45%")}
          {bar(t.fg, "90%")}
          {bar(t.fg, "65%")}
        </span>
        <span className="tm-composer" style={{ background: t.side, borderColor: t.border }}>
          {bar(t.muted, "50%")}
          <i className="tm-send" style={{ background: t.accent }} />
        </span>
      </span>
      <span className="tm-code" style={{ background: t.code, borderColor: t.line }}>
        <span className="tm-row">
          {bar(t.kw, "22%")}
          {bar(t.fn, "40%")}
        </span>
        <span className="tm-row tm-in">
          {bar(t.fg, "18%")}
          {bar(t.str, "46%")}
        </span>
        <span className="tm-row tm-in">{bar(t.com, "58%")}</span>
        <span className="tm-row">
          {bar(t.type, "30%")}
          {bar(t.fg, "24%")}
        </span>
      </span>
    </span>
  );
}

export function Appearance() {
  const themes = useThemes();
  const current = useStore((s) => s.theme);
  return (
    <section id="settings-appearance" aria-labelledby="settings-appearance-title" className="panel">
      <h2 id="settings-appearance-title" className="tight">
        Appearance
      </h2>
      <div className="hint-line">A theme changes the colours only; the layout and the font stay the same.</div>
      <div role="group" aria-label="Theme" className="settings-grid themes">
        {themes.map((t) => {
          const tone = t.light ? "Light" : "Dark";
          return (
            <button key={t.id} type="button" className="choice settings-card" aria-pressed={t.id === current} onClick={() => setTheme(t.id)}>
              <ThemeMock t={t.tokens} />
              <span className="choice-title ellipsis">{t.label}</span>
              <span className="choice-hint ellipsis">{t.builtin ? tone : `${tone}, from ${t.modName}`}</span>
            </button>
          );
        })}
      </div>
      <div className="settings-note">
        More themes come from mods.
        <button type="button" className="link-btn" onClick={() => showView({ kind: "mods" })}>
          Open the Mods page
        </button>
      </div>
    </section>
  );
}
