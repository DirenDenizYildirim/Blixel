// The app's settings: its look, the editor, the layout, what new agents
// start with, what the agents spent today, the keys, and what it is. A full
// page like an agent's settings, with a live map of this window beside it.
// Everything applies at once; the theme and layout remember themselves.

import { useEffect, useRef, useState } from "react";
import { version } from "../../package.json";
import { APP_NAME } from "../brand";
import { keyBindings } from "../commands/keys";
import { useCommands } from "../commands/registry";
import { MoreIcon } from "../layout/icons";
import { useViews } from "../layout/views";
import { arrange, useLayout, zenView } from "../model/layout";
import { showView } from "../model/store";
import { Appearance } from "./Appearance";
import { EditorSettings } from "./EditorSettings";
import { Keycaps } from "./Keycaps";
import { KeysSettings } from "./KeysSettings";
import { LayoutMap, useWindowSize } from "./LayoutMap";
import { LayoutSettings } from "./LayoutSettings";
import { NewAgentSettings } from "./NewAgentSettings";
import { UsageSettings } from "./UsageSettings";
import "./settings.css";

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "layout", label: "Layout" },
  { id: "new-agents", label: "New agents" },
  { id: "usage", label: "Usage" },
  { id: "keys", label: "Keys" },
  { id: "about", label: "About" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const smooth = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

export function SettingsPage() {
  const [active, setActive] = useState<SectionId>("appearance");
  const page = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  // While a jump scrolls, the section chosen stays marked.
  const jumping = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the user last clicked, and when: kept in view if the page changes shape under it.
  const touched = useRef<{ el: Element; at: number } | null>(null);
  const shown = useRef(active);
  shown.current = active;
  useKeepPlace(page, () => {
    const last = touched.current;
    if (last && last.el.isConnected && Date.now() - last.at < 2000) last.el.scrollIntoView({ block: "center" });
    else page.current?.querySelector(`#settings-${shown.current}`)?.scrollIntoView({ block: "start" });
  });

  /** The current section is the one that fills most of the view under the section bar; at the very bottom, the last. */
  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    if (jumping.current) {
      clearTimeout(jumping.current);
      jumping.current = setTimeout(() => (jumping.current = null), 150);
      return;
    }
    // Only the settings' own scroller counts, not the aside's.
    const scroller = e.target as HTMLElement;
    if (!bar.current || !scroller.contains(bar.current)) return;
    const view = scroller.getBoundingClientRect();
    const top = Math.max(view.top, bar.current.getBoundingClientRect().bottom);
    let current: SectionId = active;
    let most = 0;
    for (const s of SECTIONS) {
      const box = page.current?.querySelector(`#settings-${s.id}`)?.getBoundingClientRect();
      const seen = box ? Math.min(box.bottom, view.bottom) - Math.max(box.top, top) : 0;
      if (seen > most) [current, most] = [s.id, seen];
    }
    if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      current = SECTIONS[SECTIONS.length - 1].id;
    }
    setActive(current);
  };

  const jump = (id: SectionId) => {
    setActive(id);
    if (jumping.current) clearTimeout(jumping.current);
    jumping.current = setTimeout(() => (jumping.current = null), 1000);
    page.current?.querySelector(`#settings-${id}`)?.scrollIntoView({ behavior: smooth(), block: "start" });
  };

  return (
    <div
      ref={page}
      className="form-page settings-page"
      onScrollCapture={onScroll}
      onPointerDownCapture={(e) => (touched.current = { el: e.target as Element, at: Date.now() })}
    >
      <div className="settings-body">
        <main className="form-main settings-main">
          <div className="settings-head">
            <div className="grow min0">
              <h1>Settings</h1>
              <div className="muted">Changes apply at once and are kept for next time.</div>
            </div>
            <button type="button" className="btn" onClick={() => showView({ kind: "main" })}>
              Back
            </button>
          </div>

          <nav ref={bar} className="settings-nav" aria-label="Settings sections">
            <div className="seg">
              {SECTIONS.map((s) => (
                <button key={s.id} type="button" aria-current={active === s.id ? "location" : undefined} onClick={() => jump(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
          </nav>

          <Appearance />
          <EditorSettings />
          <LayoutSettings />
          <NewAgentSettings />
          <UsageSettings />
          <KeysSettings />
          <About />
        </main>
        <ThisWindow />
      </div>
    </div>
  );
}

/**
 * In a narrow window the page scrolls as one instead of in its columns (settings.css), so
 * collapsing the sidebar or resizing the window can switch which element scrolls. When it
 * does, `restore` brings back into view what the user was at.
 */
function useKeepPlace(page: React.RefObject<HTMLDivElement | null>, restore: () => void) {
  const latest = useRef(restore);
  latest.current = restore;
  useEffect(() => {
    const body = page.current?.firstElementChild;
    if (!body) return;
    const stacked = () => getComputedStyle(body).flexDirection === "column";
    let was = stacked();
    const observer = new ResizeObserver(() => {
      if (stacked() === was) return;
      was = !was;
      latest.current();
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [page]);
}

function About() {
  return (
    <section id="settings-about" aria-labelledby="settings-about-title" className="panel">
      <h2 id="settings-about-title">About</h2>
      <div className="about">
        <span className="about-name">{APP_NAME}</span>
        <span className="label">version {version}</span>
      </div>
      <div className="settings-note">
        A workspace where you and several AI agents work on one project together.
      </div>
      <div className="settings-note">
        Making a mod? <span className="strong">docs/mods.md</span> describes themes, layouts, rules for agents, commands and views.
      </div>
    </section>
  );
}

/** A live map of this window's layout, and a few things worth knowing. */
function ThisWindow() {
  const layout = useLayout();
  const views = useViews();
  const size = useWindowSize();
  useCommands();
  const palette = keyBindings().byCommand.get("palette.open");
  const zen = zenView(layout, views);
  const columns = arrange(layout, views);
  const { side, collapsed } = layout.nav;

  return (
    <aside aria-label="This window" className="form-preview settings-aside">
      <div className="aside-block">
        <div className="label">This window</div>
        <LayoutMap columns={layout.columns} views={views} nav={layout.nav} width={size.width} height={size.height} zen={zen} detail />
        <dl className="map-facts">
          <dt>Sidebar</dt>
          <dd>
            {side === "left" ? "Left" : "Right"}
            {collapsed ? ", collapsed" : ""}
          </dd>
          <dt>Columns</dt>
          <dd>{columns.map((c) => c.slots.map((s) => views[s.view].title).join(" over ")).join(" · ")}</dd>
          <dt>Zen</dt>
          <dd>{zen ? `On, ${views[zen].title}` : "Off"}</dd>
        </dl>
      </div>

      <div className="aside-block">
        <div className="label">Tip</div>
        <div className="may-do tips">
          <div>
            Every panel has a{" "}
            <span className="inline-icon">
              <MoreIcon size={12} />
            </span>{" "}
            menu to move it, hide it or show it alone.
          </div>
          {palette && (
            <div>
              <Keycaps keys={palette} /> runs any command by its name.
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
