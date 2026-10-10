// An agent's access to each connector, inside the Tools part of its settings.
// Changes go into the form's draft and are saved with the agent.

import { useEffect, useState } from "react";
import { Segmented } from "../components/controls";
import { showView } from "../model/store";
import type { Agent } from "../model/types";
import { AddConnector } from "./AddConnector";
import { ACCESS_OPTIONS, stateText } from "./ConnectorCard";
import { ConnectorTile, artFor } from "./ConnectorTile";
import { connectorsAvailable, loadConnectors, NEEDS_APP, useConnectors, withAccess } from "./store";
import { whereItRuns } from "./templates";
import "./connectors.css";

export function AgentConnectors({ draft, setDraft }: { draft: Agent; setDraft: React.Dispatch<React.SetStateAction<Agent>> }) {
  const { ready, entries } = useConnectors();
  // Adding happens over the form, so nothing typed into it is lost.
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void loadConnectors();
  }, []);

  return (
    <div className="agent-conns">
      <div className="agent-conns-head">
        <span className="tool-text">
          <span>Connectors</span>
          <span className="label">Services added on the Connectors page, shared by every project</span>
        </span>
        <button type="button" className="link-btn" onClick={() => setAdding(true)}>
          + Add connector
        </button>
      </div>
      {ready && entries.length === 0 && (
        <div className="label agent-conns-empty">
          {connectorsAvailable ? "No connectors yet." : NEEDS_APP}
          <button type="button" className="link-btn" onClick={() => showView({ kind: "connectors" })}>
            Open the Connectors page
          </button>
        </div>
      )}
      {entries.map(({ connector, state }) => {
        const status = stateText(state, connector.approvedHash !== null);
        return (
          <div key={connector.id} className="tool-row">
            <div className="agent-conn-who">
              <ConnectorTile art={artFor(connector)} size={32} />
              <div className="tool-text">
                <span>{connector.name}</span>
                <span className="label ellipsis">
                  {whereItRuns(connector.transport)}
                  {status.tone !== "ok" && status.tone !== "quiet" && (
                    <span className="conn-state-inline" data-tone={status.tone}>
                      {" · "}
                      {status.text}
                    </span>
                  )}
                </span>
              </div>
            </div>
            <Segmented
              label={`Access to ${connector.name}`}
              value={draft.connectors[connector.id] ?? "off"}
              options={ACCESS_OPTIONS}
              onChange={(p) => setDraft((d) => ({ ...d, connectors: withAccess(d.connectors, connector.id, p) }))}
            />
          </div>
        );
      })}
      {adding && <AddConnector onClose={() => setAdding(false)} />}
    </div>
  );
}
