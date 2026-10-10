// What this project's agents spent today, each against its daily limit. The
// limits themselves are set in each agent's settings.

import { Avatar } from "../avatars/Avatar";
import { avatarMode } from "../components/Sidebar";
import { hueOf, showView, useStore } from "../model/store";
import type { Agent } from "../model/types";
import { formatUsd, limitOf, spendLevel } from "../model/usage";

export function UsageSettings() {
  const agents = useStore((s) => s.agents);
  const usage = useStore((s) => s.usage);
  const demo = useStore((s) => s.projectId === "demo");
  const total = agents.reduce((sum, a) => sum + (usage[a.id]?.today ?? 0), 0);

  return (
    <section id="settings-usage" aria-labelledby="settings-usage-title" className="panel">
      <h2 id="settings-usage-title" className="tight">
        Usage
      </h2>
      <div className="hint-line">
        What this project's agents spent today, from the cost each agent's program reports. Each agent's daily limit is
        set in its own settings.
      </div>
      {agents.length === 0 ? (
        <div className="label top6">No agents in this project yet.</div>
      ) : (
        <div className="usage-list">
          {agents.map((a) => (
            <UsageRow key={a.id} agent={a} today={usage[a.id]?.today ?? 0} />
          ))}
          {agents.length > 1 && (
            <div className="usage-row usage-total">
              <span className="usage-who">All agents</span>
              <span className="usage-spent">{formatUsd(total)}</span>
              <span className="usage-limit" />
              <span className="usage-change" />
            </div>
          )}
        </div>
      )}
      {demo && <div className="settings-note">The demo's agents are scripted, so what they spend here is made up.</div>}
    </section>
  );
}

function UsageRow({ agent, today }: { agent: Agent; today: number }) {
  const limit = limitOf(agent);
  const level = spendLevel(agent, today);
  return (
    <div className="usage-row">
      <span className="usage-who">
        <Avatar name={agent.name} style={agent.avatarStyle} mode={avatarMode(agent.status)} size={20} hue={hueOf(agent)} />
        <span className="ellipsis">{agent.name}</span>
        {agent.status === "limited" && <span className="usage-flag">at limit</span>}
      </span>
      <span className="usage-spent" data-level={level}>
        {formatUsd(today)}
      </span>
      <span className="usage-limit">{limit === null ? "no limit" : `of ${formatUsd(limit)}`}</span>
      <button
        type="button"
        className="link-btn usage-change"
        aria-label={`Change ${agent.name}'s daily limit`}
        onClick={() => showView({ kind: "agent-form", editingId: agent.id })}
      >
        Change
      </button>
    </div>
  );
}
