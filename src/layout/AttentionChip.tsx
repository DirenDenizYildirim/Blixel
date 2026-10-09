// In zen the sidebar is gone, so agents that need an answer show up here.

import { Avatar } from "../avatars/Avatar";
import { setZen } from "../model/layout";
import { hueOf, selectAgent, useStore } from "../model/store";

export function AttentionChip() {
  const agents = useStore((s) => s.agents);
  const waiting = agents.filter((a) => a.status === "waiting");
  if (!waiting.length) return null;
  return (
    <div className="attention" role="status" aria-label="Agents waiting for you">
      {waiting.map((a) => (
        <button
          key={a.id}
          type="button"
          className="attention-agent"
          aria-label={`${a.name} needs you`}
          title={`${a.name} needs you`}
          onClick={() => {
            selectAgent(a.id);
            setZen("chat");
          }}
        >
          <Avatar name={a.name} style={a.avatarStyle} mode="waiting" size={20} hue={hueOf(a)} />
        </button>
      ))}
    </div>
  );
}
