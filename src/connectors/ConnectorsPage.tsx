// The Connectors page: the services agents can reach through the app (MCP
// servers), their state, and per agent who may use each one. Laid out like
// the Mods page: cards in a main column, and what to know in a side column.

import { useEffect, useMemo, useState } from "react";
import { APP_NAME } from "../brand";
import { Segmented } from "../components/controls";
import { SearchIcon } from "../components/icons";
import { CheckIcon } from "../mods/page/icons";
import { showView } from "../model/store";
import type { Connector } from "../model/types";
import { AddConnector } from "./AddConnector";
import { ConnectorCard } from "./ConnectorCard";
import { ConnectorTile, templateArt } from "./ConnectorTile";
import { connectorsAvailable, loadConnectors, NEEDS_APP, needsYou, useConnectors } from "./store";
import { CUSTOM, TEMPLATES } from "./templates";
import "./connectors.css";

type Filter = "all" | "ready" | "needs";
/** What the pop-up shows: nothing, the list of templates, one template's form, or a saved connector's. */
type Adding = null | { startWith?: string } | { editing: Connector };

export function ConnectorsPage() {
  const { ready, entries, error } = useConnectors();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState<Adding>(null);
  useEffect(() => {
    void loadConnectors();
  }, []);

  const needs = entries.filter((e) => needsYou(e.state)).length;
  const okCount = entries.filter((e) => e.state.kind === "ok").length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (!q || `${e.connector.name} ${e.connector.slug}`.toLowerCase().includes(q)) &&
        (filter === "all" || (filter === "ready" ? e.state.kind === "ok" : needsYou(e.state))),
    );
  }, [entries, query, filter]);

  return (
    <div className="conn-page">
      <div className="conn-layout">
        <main className="conn-main">
          <header className="conn-head">
            <div className="conn-head-text">
              <h1>Connectors</h1>
              <div className="muted">Services your agents can use, such as GitHub or a database. You choose who may use each.</div>
            </div>
            <button type="button" className="btn primary" onClick={() => setAdding({})}>
              Add connector
            </button>
          </header>

          {!connectorsAvailable && (
            <div className="conn-banner" role="status">
              {NEEDS_APP} Here in the browser you can look around, but nothing is added or checked.
            </div>
          )}
          {error && (
            <div className="conn-banner" role="alert">
              The connectors could not be read: {error}
            </div>
          )}

          {entries.length > 0 && (
            <div className="conn-toolbar">
              <label className="conn-filter">
                <SearchIcon color="var(--muted)" />
                <input
                  type="search"
                  value={query}
                  placeholder="Filter connectors"
                  aria-label="Filter connectors"
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
                  { value: "ready", label: "Ready" },
                  { value: "needs", label: needs ? `Needs you · ${needs}` : "Needs you" },
                ]}
              />
            </div>
          )}

          {!ready && <div className="conn-quiet">Looking for connectors…</div>}
          {ready && entries.length === 0 && <Empty onPick={(id) => setAdding({ startWith: id })} />}
          {entries.length > 0 && shown.length === 0 && (
            <div className="conn-quiet">
              No connector matches.
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Show all
              </button>
            </div>
          )}
          {shown.map((e) => (
            <ConnectorCard key={e.connector.id} entry={e} onEdit={() => setAdding({ editing: e.connector })} />
          ))}
        </main>

        <Aside total={entries.length} ready={okCount} needs={needs} />
      </div>

      {adding && (
        <AddConnector
          editing={"editing" in adding ? adding.editing : undefined}
          startWith={"startWith" in adding ? adding.startWith : undefined}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  );
}

function Empty({ onPick }: { onPick: (id: string) => void }) {
  return (
    <div className="panel conn-empty">
      <div className="conn-empty-title">No connectors yet</div>
      <div className="muted">
        A connector gives agents the tools of a service: issues on GitHub, errors in Sentry, a database, a browser. Pick one to start;
        agents get no access until you give it to them.
      </div>
      <div className="conn-empty-grid">
        {[...TEMPLATES, CUSTOM].map((t) => (
          <button key={t.id} type="button" className="conn-empty-item" onClick={() => onPick(t.id)}>
            <ConnectorTile art={templateArt(t.id === CUSTOM.id ? null : t.id)} size={56} />
            <span className="conn-pick-name">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const ACCESS: [string, string][] = [
  ["Off", "its tools are hidden from the agent"],
  ["Ask", "each call waits for your answer"],
  ["Allow", "calls go ahead without asking"],
];

const KEPT: string[] = [
  "Every call is logged in the agent's chat",
  "Tokens stay in your system keychain",
  "Changed tools ask on every call until you approve them",
  "Mods can never add connectors",
];

function Aside(props: { total: number; ready: number; needs: number }) {
  return (
    <aside aria-label="About connectors" className="conn-aside">
      <div className="conn-aside-block">
        <div className="label">On this computer</div>
        <div className="conn-counts">
          <div>
            <span className="conn-count-n">{props.total}</span>
            <span className="label">added</span>
          </div>
          <div>
            <span className="conn-count-n">{props.ready}</span>
            <span className="label">ready</span>
          </div>
          <div>
            <span className="conn-count-n">{props.needs}</span>
            <span className="label">need you</span>
          </div>
        </div>
      </div>

      <div className="conn-aside-block">
        <div className="label">How access works</div>
        <div className="conn-list">
          <div className="conn-list-intro">Each agent starts with every connector Off. Per agent and connector:</div>
          {ACCESS.map(([what, how]) => (
            <div key={what} className="conn-list-row">
              <span className="conn-access-word">{what}</span>
              <span className="conn-list-hint">{how}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="conn-aside-block">
        <div className="label">Always</div>
        <ul className="conn-list">
          {KEPT.map((what) => (
            <li key={what} className="conn-list-row">
              <span className="conn-list-mark">
                <CheckIcon />
              </span>
              <span>{what}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="conn-aside-block">
        <div className="label">Custom connectors</div>
        <div className="conn-list conn-list-text">
          A custom connector runs with your rights. If it works on files or runs commands, it does so outside {APP_NAME}'s rules: edit
          areas and protected files don't apply to it.
        </div>
      </div>

      <button type="button" className="btn big conn-back" onClick={() => showView({ kind: "main" })}>
        Back
      </button>
    </aside>
  );
}
