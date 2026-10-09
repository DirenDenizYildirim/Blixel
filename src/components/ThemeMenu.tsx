import { useEffect, useRef } from "react";
import { useThemes } from "../mods/registry";
import { setTheme, useStore } from "../model/store";

/** The themes of every enabled mod, the built-in ones first. */
export function ThemeMenu({ onClose }: { onClose: () => void }) {
  const current = useStore((s) => s.theme);
  const themes = useThemes();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="theme-menu" role="menu" aria-label="Theme">
      {themes.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitemradio"
          aria-checked={t.id === current}
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
    </div>
  );
}
