// What a new agent starts with, with the same controls as an agent's own
// settings. Changing these leaves existing agents as they are.

import { Segmented, Switch } from "../components/controls";
import { TYPING_SPEEDS, updateNewAgent, useSettings } from "../model/app-settings";
import { useStore } from "../model/store";
import { TOOL_LABELS, type ToolId } from "../model/types";

const TOOLS: ToolId[] = ["read", "edit", "run", "commit", "push"];

export function NewAgentSettings() {
  const d = useSettings((s) => s.newAgent);
  const offered = useStore((s) => s.models["claude-code"]);
  // Keep the chosen model listed even if the program no longer offers it.
  const models = offered.some((m) => m.id === d.model) ? offered : [{ id: d.model, name: d.model }, ...offered];

  return (
    <section id="settings-new-agents" aria-labelledby="settings-new-agents-title" className="panel">
      <h2 id="settings-new-agents-title" className="tight">
        New agents
      </h2>
      <div className="hint-line">What a new agent starts with. Each agent can differ, and changing these leaves existing ones as they are.</div>

      <div className="set-block first">
        <h3>Tools</h3>
        <div className="hint-line">Ask means it stops and waits for you each time. Connectors start Off for every new agent.</div>
        {TOOLS.map((tool) => (
          <div key={tool} className="tool-row">
            <div className="tool-text">
              <span>{TOOL_LABELS[tool].name}</span>
              <span className="label">{TOOL_LABELS[tool].hint}</span>
            </div>
            <Segmented
              label={TOOL_LABELS[tool].name}
              value={d.permissions[tool]}
              options={[
                { value: "off", label: "Off" },
                { value: "ask", label: "Ask" },
                { value: "allow", label: "Allow" },
              ]}
              onChange={(v) => updateNewAgent({ permissions: { ...d.permissions, [tool]: v } })}
            />
          </div>
        ))}
      </div>

      <div className="set-block">
        <h3>Model</h3>
        <div className="row wrap gap16 center top6">
          <label className="field grow1 settings-model">
            <span className="label">Model, for Claude Code</span>
            <select className="input" value={d.model} onChange={(e) => updateNewAgent({ model: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id} title={m.description ?? undefined}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="label">Thinking effort</span>
            <Segmented
              label="Thinking effort"
              value={d.effort}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
              onChange={(v) => updateNewAgent({ effort: v })}
            />
          </div>
        </div>
      </div>

      <div className="set-block">
        <h3>Working</h3>
        <div className="row wrap limits top6">
          <label className="field grow-speed">
            <span className="label spread">
              <span>Typing speed in the editor</span>
              <span className="strong">{d.typingSpeed} chars/s</span>
            </span>
            <input
              type="range"
              min={TYPING_SPEEDS.min}
              max={TYPING_SPEEDS.max}
              step={1}
              value={d.typingSpeed}
              className="range"
              onChange={(e) => updateNewAgent({ typingSpeed: Number(e.target.value) })}
            />
          </label>
          <div className="field">
            <span className="label">When it has nothing to do</span>
            <Segmented
              label="When it has nothing to do"
              value={d.whenIdle}
              options={[
                { value: "wait", label: "Wait for me" },
                { value: "pick-up", label: "Pick up queued tasks" },
              ]}
              onChange={(v) => updateNewAgent({ whenIdle: v })}
            />
          </div>
        </div>
      </div>

      <div className="set-block">
        <h3>Instructions</h3>
        <label className="field top6">
          <span className="label">Every new agent starts with these; you can change them per agent</span>
          <textarea
            className="input area"
            rows={4}
            value={d.instructions}
            placeholder="Keep changes small and explain them. Run the tests before saying you are done."
            onChange={(e) => updateNewAgent({ instructions: e.target.value })}
          />
        </label>
        <div className="top12">
          <Switch
            label="Give it the project notes (CLAUDE.md, AGENTS.md) when it starts"
            checked={d.readNotes}
            onChange={(v) => updateNewAgent({ readNotes: v })}
          />
        </div>
      </div>
    </section>
  );
}
