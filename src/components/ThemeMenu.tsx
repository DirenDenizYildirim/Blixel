import { useThemes } from "../mods/registry";
import { setTheme, useStore } from "../model/store";
import { Popover, type Place } from "./NewPopover";

/** The themes of every enabled mod, the built-in ones first, in a small pop-up by the Theme button. */
export function ThemeMenu({ anchor, place, onClose }: { anchor: () => HTMLElement | null; place: Place; onClose: () => void }) {
  const current = useStore((s) => s.theme);
  const themes = useThemes();

  return (
    <Popover anchor={anchor} label="Theme" place={place} role="menu" className="pop-menu theme-pop" onClose={onClose}>
      {themes.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitemradio"
          className="pop-item"
          aria-checked={t.id === current}
          data-autofocus={t.id === current || undefined}
          title={t.builtin ? undefined : `From ${t.modName}`}
          onClick={() => setTheme(t.id)}
        >
          <span className="swatch" style={{ background: t.tokens.bg, borderColor: t.tokens.border }}>
            <i style={{ background: t.tokens.accent }} />
            <i style={{ background: t.tokens.fg }} />
          </span>
          <span className="ellipsis">{t.label}</span>
        </button>
      ))}
    </Popover>
  );
}
