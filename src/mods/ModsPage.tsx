// The Mods page: what is installed, what each mod adds and asks for, turning
// mods on (with approval of exactly what they ask for) and off, installing
// and removing them, and what went wrong recently. The cards and the side
// column are in ./page.

import { useMemo, useState } from "react";
import { Segmented } from "../components/controls";
import { SearchIcon } from "../components/icons";
import { inTauri, pickFolder } from "../model/backend";
import { notify } from "../model/store";
import { installFrom, keepModsOn, loadDevFrom, startWithoutModCode, useMods } from "./registry";
import type { ModRecord } from "./types";
import { DevIcon, InstallIcon } from "./page/icons";
import { ModCard } from "./page/ModCard";
import { ModIcon } from "./page/ModIcon";
import { ModsAside } from "./page/ModsAside";
import { matchesFilter, matchesText, modFacts, type Filter, type ModFacts } from "./page/model";
import { EMPTY_ICON } from "./page/pixel-icons";
import "./mods-page.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_ERRORS: string[] = [];

interface Entry {
  mod: ModRecord;
  facts: ModFacts;
  errors: string[];
}

export function ModsPage() {
  const mods = useMods((s) => s.mods);
  const ready = useMods((s) => s.ready);
  const errors = useMods((s) => s.errors);
  const disabledByFlag = useMods((s) => s.disabledByFlag);
  const safeStartSuggested = useMods((s) => s.safeStartSuggested);
  const codeModsSuspended = useMods((s) => s.codeModsSuspended);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const add = async (dev: boolean) => {
    if (!inTauri) {
      notify("Installing mods works in the desktop app.");
      return;
    }
    const path = await pickFolder();
    if (!path) return;
    setBusy(true);
    try {
      const record = await (dev ? loadDevFrom(path) : installFrom(path));
      const listed = useMods.getState().mods.find((m) => m.id === record.id) ?? record;
      const name = listed.manifest?.name ?? listed.id;
      notify(listed.error ? `${name} was added, but it cannot run: ${listed.error}` : `${name} was added. Turn it on to use it.`);
    } catch (e) {
      notify(`The mod could not be added: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const entries = useMemo(
    () =>
      mods.map((mod): Entry => {
        const errs = errors[mod.id] ?? NO_ERRORS;
        return { mod, facts: modFacts(mod, errs), errors: errs };
      }),
    [mods, errors],
  );
  const installed = entries.filter((e) => !e.mod.builtin);
  const builtin = entries.filter((e) => e.mod.builtin);
  const shows = (e: Entry) => matchesText(e.mod, query) && matchesFilter(e.facts, filter);
  const shownInstalled = installed.filter(shows);
  const shownBuiltin = builtin.filter(shows);
  const needs = entries.filter((e) => e.facts.needsYou).length;
  const narrowed = filter !== "all" || query.trim() !== "";
  const codeOff = disabledByFlag || codeModsSuspended || safeStartSuggested;
  const reset = () => {
    setQuery("");
    setFilter("all");
  };

  const card = (e: Entry) => <ModCard key={e.mod.id} mod={e.mod} facts={e.facts} errors={e.errors} codeOff={codeOff} />;
  const buttons = (
    <>
      <button type="button" className="btn primary with-icon" disabled={busy} onClick={() => void add(false)}>
        <InstallIcon />
        Install from folder…
      </button>
      <button type="button" className="btn with-icon" disabled={busy} onClick={() => void add(true)}>
        <DevIcon color="var(--accent)" />
        Load a dev folder…
      </button>
    </>
  );

  return (
    <div className="mods-page">
      <div className="mods-layout">
        <main className="mods-main">
          <header className="mods-head">
            <div className="mods-head-text">
              <h1>Mods</h1>
              <div className="muted">Themes, layouts, rules and tools by others.</div>
            </div>
            <div className="mods-actions">{buttons}</div>
          </header>

          <div className="mods-toolbar">
            <label className="mods-filter">
              <SearchIcon color="var(--muted)" />
              <input
                type="search"
                value={query}
                placeholder="Filter mods"
                aria-label="Filter mods"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              />
            </label>
            <Segmented<Filter>
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
                { value: "needs", label: needs ? `Needs you · ${needs}` : "Needs you" },
              ]}
            />
          </div>

          {safeStartSuggested && (
            <div className="mods-banner" role="alert">
              <span className="mods-banner-text">
                <span className="strong bold">The last session ended while mods were running.</span> Their code waits until you
                choose.
              </span>
              <button type="button" className="btn" onClick={startWithoutModCode}>
                Start without mod code this time
              </button>
              <button type="button" className="btn" onClick={keepModsOn}>
                Keep them on
              </button>
            </div>
          )}
          {disabledByFlag && (
            <div className="mods-banner" role="status">
              <span className="mods-banner-text">
                Started with <code>--no-mods</code>: mod code is off for this session.
              </span>
            </div>
          )}
          {codeModsSuspended && !disabledByFlag && (
            <div className="mods-banner" role="status">
              <span className="mods-banner-text">Mod code is off for this session. It starts again the next time you open the app.</span>
            </div>
          )}

          <section className="mods-section" aria-labelledby="mods-installed">
            <SectionHead id="mods-installed" title="Installed" shown={shownInstalled.length} total={installed.length} narrowed={narrowed} />
            {!ready && <div className="mods-quiet">Looking for installed mods…</div>}
            {ready && installed.length === 0 && <Empty buttons={buttons} />}
            {installed.length > 0 && shownInstalled.length === 0 && <NoMatch what="installed" onReset={reset} />}
            {shownInstalled.map(card)}
          </section>

          <section className="mods-section" aria-labelledby="mods-builtin">
            <SectionHead id="mods-builtin" title="Built in" shown={shownBuiltin.length} total={builtin.length} narrowed={narrowed} />
            {shownBuiltin.length === 0 && <NoMatch what="built-in" onReset={reset} />}
            {shownBuiltin.map(card)}
          </section>
        </main>

        <ModsAside on={installed.filter((e) => e.facts.on).length} installed={installed.length} builtin={builtin.length} />
      </div>
    </div>
  );
}

function SectionHead(props: { id: string; title: string; shown: number; total: number; narrowed: boolean }) {
  return (
    <h2 id={props.id} className="mods-section-head">
      <span>{props.title}</span>
      <span className="mods-section-count">{props.narrowed ? `${props.shown} of ${props.total}` : props.total}</span>
    </h2>
  );
}

function NoMatch({ what, onReset }: { what: string; onReset: () => void }) {
  return (
    <div className="mods-quiet">
      No {what} mod matches.
      <button type="button" className="link-btn" onClick={onReset}>
        Show all
      </button>
    </div>
  );
}

function Empty({ buttons }: { buttons: React.ReactNode }) {
  return (
    <div className="panel mods-empty">
      <ModIcon icon={EMPTY_ICON} tint={EMPTY_ICON.colors.m} />
      <div className="mods-empty-text">
        <div className="mods-empty-title">No mods yet</div>
        <div className="muted">
          A mod is a folder that adds themes, layouts, rules for agents or small tools. Install one from a folder that holds its
          mod.json, or load your own while you make it.
        </div>
        <div className="mods-actions top12">{buttons}</div>
      </div>
    </div>
  );
}
