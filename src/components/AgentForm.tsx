import { useEffect, useMemo, useState } from "react";
import { Avatar } from "../avatars/Avatar";
import { AVATAR_STYLES, nameHue } from "../avatars/generator";
import { APP_NAME } from "../brand";
import { AgentConnectors } from "../connectors/AgentConnectors";
import { isActive, modName, useMods, useRulePacks, type AvailableRulePack } from "../mods/registry";
import { removeAgent } from "../model/agent-actions";
import { useSettings } from "../model/app-settings";
import { sendToAgent } from "../model/mock-agent";
import { canRunForReal, hasApiKey, saveApiKey, sendToRealAgent, syncAgent } from "../model/real-agent";
import { describeArea, PROTECTED_NAMES } from "../model/paths";
import { agentById, hueOf, modelName, notify, saveAgent, setAgentTrust, showView, uid, useStore } from "../model/store";
import {
  FALLBACK_MODELS,
  PROGRAM_LABELS,
  TOOL_LABELS,
  type Agent,
  type AttachedRulePack,
  type Permission,
  type Program,
  type RunsOn,
  type ToolId,
} from "../model/types";
import { agentColor, agentTint } from "../theme/theme";
import { Segmented, Switch } from "./controls";
import { agentSubline } from "./Sidebar";

const NAME_POOL = ["Wren", "Heron", "Lark", "Cicada", "Ibis", "Tern", "Mantis", "Sable", "Quill", "Ember", "Finch", "Otter"];

const SWATCHES: { label: string; hue: number }[] = [
  { label: "Orange", hue: 55 },
  { label: "Green", hue: 150 },
  { label: "Violet", hue: 300 },
  { label: "Sky", hue: 235 },
  { label: "Yellow", hue: 95 },
  { label: "Pink", hue: 350 },
];

const firstModel = (program: Program) => useStore.getState().models[program][0]?.id ?? "";

const RUNS_ON: { id: RunsOn; title: string; hint: string }[] = [
  { id: "hosted", title: "Hosted agent", hint: "Claude Code or Codex, signed in with your own account" },
  { id: "api-key", title: "API key", hint: "Any provider, billed per use" },
  { id: "self-hosted", title: "Self-hosted", hint: "A model on your own machine or server" },
];

const TOOLS: ToolId[] = ["read", "edit", "run", "commit", "push"];

/** A new agent, starting from the defaults in Settings. */
function blankAgent(taken: string[]): Agent {
  const name = NAME_POOL.find((n) => !taken.includes(n.toLowerCase())) ?? "";
  const defaults = useSettings.getState().newAgent;
  return {
    id: uid("agent"),
    name,
    role: "",
    avatarStyle: "blob",
    hue: null,
    runsOn: "api-key",
    program: "claude-code",
    model: defaults.model || FALLBACK_MODELS["claude-code"][0].id,
    effort: defaults.effort,
    instructions: defaults.instructions,
    readNotes: defaults.readNotes,
    permissions: { ...defaults.permissions },
    editPaths: "",
    rulePacks: [],
    connectors: {},
    canMessage: true,
    takesTasks: true,
    canGiveTo: [],
    typingSpeed: defaults.typingSpeed,
    dailyLimit: "",
    whenIdle: defaults.whenIdle,
    status: "idle",
    placeholder: true,
  };
}

export function AgentForm({ editingId }: { editingId: string | null }) {
  const agents = useStore((s) => s.agents);
  const editing = editingId ? agentById(editingId) : undefined;
  const changedOutside = useStore((s) => (editingId ? s.agentTrust[editingId] === "changed-outside" : false));
  const [draft, setDraft] = useState<Agent>(() => editing ?? blankAgent(agents.map((a) => a.name.toLowerCase())));
  const [limitArea, setLimitArea] = useState(Boolean(editing?.editPaths.trim()));
  const [firstTask, setFirstTask] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void hasApiKey().then(setKeySaved);
  }, []);

  const set = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setTool = (tool: ToolId, value: Permission) =>
    setDraft((d) => ({ ...d, permissions: { ...d.permissions, [tool]: value } }));

  const others = agents.filter((a) => a.id !== draft.id);
  const nameTaken = others.some((a) => a.name.trim().toLowerCase() === draft.name.trim().toLowerCase());
  const real = editing ? !editing.placeholder : canRunForReal(draft);
  const problem = !draft.name.trim()
    ? "Give it a name."
    : nameTaken
      ? "Another agent already has this name."
      : real && !keySaved && !apiKey.trim()
        ? "Paste your Anthropic API key to run this agent."
        : null;
  const hue = hueOf(draft);

  const submit = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      if (real && apiKey.trim()) await saveApiKey(apiKey.trim());
      const agent: Agent = {
        ...draft,
        name: draft.name.trim(),
        editPaths: limitArea ? draft.editPaths : "",
        placeholder: !real,
      };
      // Saving here is the user's review: in a project the core trusts the
      // record again (if it was changed outside the app) and saves it.
      const saved = await syncAgent(agent, true);
      saveAgent(agent);
      if (saved?.trust === "changed-outside") setAgentTrust(agent.id, "changed-outside");
      const task = firstTask.trim();
      if (!editing && task) {
        if (real) void sendToRealAgent(agent.id, task, true);
        else sendToAgent(agent.id, task, true);
      }
    } catch (e) {
      notify(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form-page">
      <main className="form-main">
        <div>
          <h1>{editing ? editing.name : "New agent"}</h1>
          <div className="muted">Everything here can be changed later.</div>
        </div>

        {changedOutside && (
          <div className="form-warning" role="status">
            This agent's saved settings were changed outside {APP_NAME}. Its permissions were lowered to Ask, and it does not
            run until you review them here and save.
          </div>
        )}

        <section aria-label="Identity" className="panel">
          <h2>Identity</h2>
          <div className="row wrap gap14">
            <label className="field grow1">
              <span className="label">Name</span>
              <input className="input strong" value={draft.name} maxLength={24} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label className="field grow2">
              <span className="label">What it's for</span>
              <input
                className="input"
                value={draft.role}
                placeholder="Writes and maintains the tests"
                onChange={(e) => set("role", e.target.value)}
              />
            </label>
          </div>
          <div className="row wrap identity-pickers">
            <div className="field">
              <span className="label">Avatar, drawn from the name</span>
              <div role="group" aria-label="Avatar" className="row gap8">
                {AVATAR_STYLES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="avatar-pick"
                    aria-label={s.label}
                    title={s.label}
                    aria-pressed={draft.avatarStyle === s.id}
                    style={draft.avatarStyle === s.id ? { borderColor: agentColor(hue), background: agentTint(hue, 16) } : undefined}
                    onClick={() => set("avatarStyle", s.id)}
                  >
                    <Avatar name={draft.name} style={s.id} mode="idle" size={32} hue={hue} />
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="label">Colour</span>
              <div role="group" aria-label="Colour" className="row gap10 swatches">
                <button
                  type="button"
                  className="swatch-btn auto"
                  aria-label="From the name"
                  title="From the name"
                  aria-pressed={draft.hue === null}
                  style={{ background: agentColor(nameHue(draft.name)) }}
                  onClick={() => set("hue", null)}
                >
                  A
                </button>
                {SWATCHES.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="swatch-btn"
                    aria-label={s.label}
                    title={s.label}
                    aria-pressed={draft.hue === s.hue}
                    style={{ background: agentColor(s.hue) }}
                    onClick={() => set("hue", s.hue)}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section aria-label="Runs on" className="panel">
          <h2>Runs on</h2>
          <div role="group" aria-label="Runs on" className="row wrap gap10">
            {RUNS_ON.map((r) => (
              <button
                key={r.id}
                type="button"
                className="choice"
                aria-pressed={draft.runsOn === r.id}
                onClick={() =>
                  setDraft((d) => {
                    const program: Program = r.id === "self-hosted" ? "opencode" : "claude-code";
                    return { ...d, runsOn: r.id, program, model: firstModel(program) };
                  })
                }
              >
                <span className="choice-title">{r.title}</span>
                <span className="choice-hint">{r.hint}</span>
              </button>
            ))}
          </div>
          <RunsOnFields draft={draft} setDraft={setDraft} apiKey={apiKey} setApiKey={setApiKey} keySaved={keySaved} real={real} />
        </section>

        <section aria-label="Instructions" className="panel">
          <h2>Instructions</h2>
          <label className="field">
            <span className="label">How it should work</span>
            <textarea
              className="input area"
              rows={4}
              value={draft.instructions}
              placeholder="You write and maintain tests for this project. Keep test files small and focused."
              onChange={(e) => set("instructions", e.target.value)}
            />
          </label>
          <div className="top12">
            <Switch
              label="Give it the project notes (CLAUDE.md, AGENTS.md) when it starts"
              checked={draft.readNotes}
              onChange={(v) => set("readNotes", v)}
            />
          </div>
          <RulePacks draft={draft} setDraft={setDraft} />
        </section>

        <section aria-label="Tools" className="panel">
          <h2 className="tight">Tools and connectors</h2>
          <div className="hint-line">Ask means it stops and waits for you each time.</div>
          {TOOLS.map((tool) => (
            <div key={tool}>
              <div className="tool-row">
                <div className="tool-text">
                  <span>{TOOL_LABELS[tool].name}</span>
                  <span className="label">{TOOL_LABELS[tool].hint}</span>
                </div>
                <Segmented
                  label={TOOL_LABELS[tool].name}
                  value={draft.permissions[tool]}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "ask", label: "Ask" },
                    { value: "allow", label: "Allow" },
                  ]}
                  onChange={(v) => setTool(tool, v)}
                />
              </div>
              {tool === "edit" && draft.permissions.edit !== "off" && (
                <div className="area-row">
                  <div className="row wrap gap10 center">
                    <span className="label">Where</span>
                    <Segmented
                      label="Where it may edit"
                      value={limitArea ? "paths" : "all"}
                      options={[
                        { value: "all", label: "Whole project" },
                        { value: "paths", label: "Only these paths" },
                      ]}
                      onChange={(v) => setLimitArea(v === "paths")}
                    />
                  </div>
                  {limitArea && (
                    <label className="field top10">
                      <span className="label">One pattern per line, written like .gitignore. Start a line with ! to leave something out.</span>
                      <textarea
                        className="input area"
                        rows={3}
                        value={draft.editPaths}
                        placeholder={"docs/**\nsrc/agents/**\n!src/agents/generated/**"}
                        onChange={(e) => set("editPaths", e.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          ))}
          <AgentConnectors draft={draft} setDraft={setDraft} />
          <div className="tool-foot label">
            Changes to agent settings and instruction files, and to git's own folder, always ask you first:{" "}
            {PROTECTED_NAMES.join(", ")}.
          </div>
        </section>

        <section aria-label="Working with others" className="panel">
          <h2 className={real ? "tight" : undefined}>Working with others</h2>
          {real && <div className="hint-line">Not active for real agents yet: it arrives with messages between agents.</div>}
          <Switch label="Can message other agents" checked={draft.canMessage} disabled={real} onChange={(v) => set("canMessage", v)} />
          <div className="top10">
            <Switch label="Takes tasks from other agents" checked={draft.takesTasks} disabled={real} onChange={(v) => set("takesTasks", v)} />
          </div>
          <div className="row wrap gap10 center top14">
            <span className="label">Can give tasks to</span>
            {others.length === 0 && <span className="label">No other agents yet</span>}
            {others.map((a) => {
              const on = draft.canGiveTo.includes(a.id);
              const h = hueOf(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  disabled={real}
                  style={on ? { borderColor: agentColor(h) } : undefined}
                  onClick={() => set("canGiveTo", on ? draft.canGiveTo.filter((x) => x !== a.id) : [...draft.canGiveTo, a.id])}
                >
                  <Avatar name={a.name} style={a.avatarStyle} mode="idle" size={20} hue={h} />
                  <span>{a.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section aria-label="Limits" className="panel">
          <h2>Limits</h2>
          <div className="row wrap limits">
            <label className="field grow-speed">
              <span className="label spread">
                <span>Typing speed in the editor</span>
                <span className="strong">{draft.typingSpeed} chars/s</span>
              </span>
              <input
                type="range"
                min={2}
                max={40}
                step={1}
                value={draft.typingSpeed}
                className="range"
                onChange={(e) => set("typingSpeed", Number(e.target.value))}
              />
            </label>
            <label className="field grow-limit">
              <span className="label">Daily spending limit (USD)</span>
              <input
                className="input"
                placeholder={real ? "Not active for real agents yet" : "No limit"}
                value={draft.dailyLimit}
                disabled={real}
                onChange={(e) => set("dailyLimit", e.target.value)}
              />
            </label>
          </div>
          <div className="row wrap gap16 center top14">
            <span className="label">When it has nothing to do</span>
            <Segmented
              label="When it has nothing to do"
              disabled={real}
              value={draft.whenIdle}
              options={[
                { value: "wait", label: "Wait for me" },
                { value: "pick-up", label: "Pick up queued tasks" },
              ]}
              onChange={(v) => set("whenIdle", v)}
            />
            {real && <span className="label">Real agents wait for you until task queues arrive.</span>}
          </div>
        </section>

        {!editing && (
          <section aria-label="First task" className="panel">
            <h2>First task</h2>
            <label className="field">
              <span className="label">Optional. Leave empty to create it idle.</span>
              <textarea
                className="input area"
                rows={3}
                placeholder="What should it start on?"
                value={firstTask}
                onChange={(e) => setFirstTask(e.target.value)}
              />
            </label>
          </section>
        )}
      </main>

      <Preview
        draft={draft}
        limitArea={limitArea}
        problem={problem}
        editing={Boolean(editing)}
        reviewing={changedOutside}
        real={real}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

function RunsOnFields(props: {
  draft: Agent;
  setDraft: React.Dispatch<React.SetStateAction<Agent>>;
  apiKey: string;
  setApiKey: (v: string) => void;
  keySaved: boolean;
  real: boolean;
}) {
  const { draft, setDraft } = props;
  const programs: Program[] = draft.runsOn === "self-hosted" ? ["opencode"] : ["claude-code", "codex"];
  const offered = useStore((s) => s.models[draft.program]);
  // Keep the agent's own model listed even if the program no longer offers it.
  const models = offered.some((m) => m.id === draft.model) ? offered : [{ id: draft.model, name: draft.model }, ...offered];
  return (
    <>
      <div className="row wrap gap14 top16">
        <label className="field grow1">
          <span className="label">Program</span>
          <select
            className="input"
            value={draft.program}
            onChange={(e) => {
              const program = e.target.value as Program;
              setDraft((d) => ({ ...d, program, model: firstModel(program) }));
            }}
          >
            {programs.map((p) => (
              <option key={p} value={p}>
                {PROGRAM_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow1">
          <span className="label">Model</span>
          <select className="input" value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}>
            {models.map((m) => (
              <option key={m.id} value={m.id} title={m.description ?? undefined}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {draft.runsOn === "api-key" && (
          <label className="field grow2">
            <span className="label">API key</span>
            <input
              className="input"
              type="password"
              placeholder={props.keySaved ? "Saved in your keychain; paste to replace" : "Paste your key"}
              autoComplete="off"
              value={props.apiKey}
              onChange={(e) => props.setApiKey(e.target.value)}
            />
          </label>
        )}
        {draft.runsOn === "self-hosted" && (
          <label className="field grow2">
            <span className="label">Model server</span>
            <input className="input" placeholder="http://localhost:11434" />
          </label>
        )}
      </div>
      <div className="row wrap gap16 center top14">
        <span className="label">Thinking effort</span>
        <Segmented
          label="Thinking effort"
          value={draft.effort}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
          onChange={(v) => setDraft((d) => ({ ...d, effort: v }))}
        />
        <span className="label note">{runsOnNote(draft, props.real)}</span>
      </div>
    </>
  );
}

function runsOnNote(draft: Agent, real: boolean): string {
  if (draft.runsOn === "api-key")
    return real
      ? "The key is kept in your system keychain, never in the project, chat or logs."
      : "Real agents run in the desktop app. Here this agent is a scripted placeholder.";
  if (draft.runsOn === "hosted")
    return draft.program === "claude-code"
      ? "Signing in with a Claude subscription needs Anthropic's approval first; use an API key for now."
      : "You sign in with ChatGPT in Codex's own window. Blixel never sees your password.";
  return "Self-hosted models arrive with OpenCode, after Claude Code.";
}

/** The pack as attached to an agent: a copy, so a mod's later change needs review. */
function attachedCopy(p: AvailableRulePack): AttachedRulePack {
  return {
    modId: p.modId,
    packId: p.pack.id,
    label: p.pack.label,
    instructions: p.pack.instructions ?? "",
    editArea: p.pack.editArea ?? "",
    protect: p.pack.protect ?? [],
    hash: p.hash,
  };
}

const samePack = (a: { modId: string; packId: string }, b: { modId: string; packId: string }) =>
  a.modId === b.modId && a.packId === b.packId;

/** What a pack does besides instructions, as short lines. */
function packEffects(p: Pick<AttachedRulePack, "editArea" | "protect">): string[] {
  const lines: string[] = [];
  const area = describeArea(p.editArea);
  if (area) lines.push(`Edits only in ${area}`);
  const protect = describeArea(p.protect.join("\n"));
  if (protect) lines.push(`Asks you before changing ${protect}`);
  return lines;
}

function PackContent({ pack }: { pack: AttachedRulePack }) {
  const effects = packEffects(pack);
  return (
    <>
      {pack.instructions.trim() && <span className="label pre-wrap">{pack.instructions.trim()}</span>}
      {effects.map((line) => (
        <span key={line} className="label">
          {line}
        </span>
      ))}
    </>
  );
}

/** Rule packs from enabled mods, to attach to this agent, and the ones it already has. */
function RulePacks(props: { draft: Agent; setDraft: React.Dispatch<React.SetStateAction<Agent>> }) {
  const { draft, setDraft } = props;
  const available = useRulePacks();
  const mods = useMods((s) => s.mods);
  const attach = (p: AvailableRulePack) => setDraft((d) => ({ ...d, rulePacks: [...d.rulePacks, attachedCopy(p)] }));
  const update = (p: AvailableRulePack) => {
    const copy = attachedCopy(p);
    setDraft((d) => ({ ...d, rulePacks: d.rulePacks.map((r) => (samePack(r, copy) ? copy : r)) }));
  };
  const remove = (r: AttachedRulePack) => setDraft((d) => ({ ...d, rulePacks: d.rulePacks.filter((x) => !samePack(x, r)) }));
  // Attached packs that no enabled mod offers any more keep applying until removed.
  const orphans = draft.rulePacks.filter((r) => !available.some((p) => samePack(r, attachedCopy(p))));

  return (
    <div className="top16">
      <div className="label">Rules from mods</div>
      <div className="hint-line top6">
        A pack cannot let this agent do more: its settings, edit area and protected files still hold, and a pack can
        only narrow them. Its instructions are text the agent's model reads, though, given as guidance from a third
        party below your own, so read a pack before you attach it. A change to a mod reaches this agent only after you
        review it here.
      </div>
      {available.length === 0 && orphans.length === 0 && (
        <div className="label">No enabled mod offers rules. Mods with rule packs appear on the Mods page.</div>
      )}
      {available.map((p) => {
        const current = attachedCopy(p);
        const attached = draft.rulePacks.find((r) => samePack(r, current));
        const changed = attached !== undefined && attached.hash !== p.hash;
        return (
          <div key={`${p.modId}:${p.pack.id}`} className="tool-row">
            <div className="tool-text">
              <span>
                {p.pack.label} <span className="label">from {p.modName}</span>
              </span>
              {p.pack.description && <span className="label">{p.pack.description}</span>}
              {changed ? (
                <>
                  <span className="warn-text">Changed by its mod — review</span>
                  <PackContent pack={current} />
                </>
              ) : (
                <PackContent pack={attached ?? current} />
              )}
            </div>
            <div className="row gap8">
              {changed && (
                <button type="button" className="btn primary" onClick={() => update(p)}>
                  Update
                </button>
              )}
              <button type="button" className="btn" onClick={() => (attached ? remove(attached) : attach(p))}>
                {attached ? "Detach" : "Attach"}
              </button>
            </div>
          </div>
        );
      })}
      {orphans.map((r) => {
        const mod = mods.find((m) => m.id === r.modId);
        return (
          <div key={`${r.modId}:${r.packId}`} className="tool-row">
            <div className="tool-text">
              <span>
                {r.label} <span className="label">from {modName(r.modId)}</span>
              </span>
              <span className="warn-text">
                {mod && isActive(mod)
                  ? "Its mod no longer offers these rules; they still apply"
                  : "Its mod is off; these rules still apply"}
              </span>
              <PackContent pack={r} />
            </div>
            <button type="button" className="btn" onClick={() => remove(r)}>
              Remove
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Preview(props: {
  draft: Agent;
  limitArea: boolean;
  problem: string | null;
  editing: boolean;
  /** Its saved settings were changed outside the app: saving is the user's review. */
  reviewing: boolean;
  real: boolean;
  onSubmit: () => void;
}) {
  const { draft } = props;
  const hue = hueOf(draft);
  const groups = useMemo(() => {
    const by: Record<Permission, string[]> = { allow: [], ask: [], off: [] };
    for (const tool of TOOLS) by[draft.permissions[tool]].push(TOOL_LABELS[tool].short);
    return by;
  }, [draft.permissions]);
  const area = props.limitArea ? describeArea(draft.editPaths) : null;
  const packAreas = draft.rulePacks.flatMap((r) => {
    const packArea = describeArea(r.editArea);
    return packArea ? [{ key: `${r.modId}:${r.packId}`, area: packArea, label: r.label }] : [];
  });
  const name = draft.name.trim() || "Unnamed";

  return (
    <aside aria-label="Preview" className="form-preview">
      <div className="label">In the sidebar</div>
      <div className="preview-row">
        <div className="agent-row static">
          <Avatar name={draft.name} style={draft.avatarStyle} mode="idle" size={32} hue={hue} />
          <span className="agent-row-text">
            <span className="agent-row-top">
              <span className="agent-row-name strong">{name}</span>
              <span className="status" data-status="idle">
                <span className="status-text">idle</span>
                <i />
              </span>
            </span>
            <span className="agent-row-sub">
              {draft.runsOn === "api-key" ? `${modelName(draft.program, draft.model)}, API key` : agentSubline(draft)}
            </span>
          </span>
        </div>
      </div>

      <div className="label">In the editor</div>
      <div className="preview-code">
        <span style={{ color: "var(--kw)" }}>const </span>rule ={" "}
        <span className="cm-agent-caret" style={{ ["--c" as string]: agentColor(hue) }}>
          <span className="bar" />
          <span className="flag">{name}</span>
        </span>
      </div>

      <div className="label">In chat</div>
      <div className="bubble card">
        <div className="bubble-head">
          <Avatar name={draft.name} style={draft.avatarStyle} mode="idle" size={20} hue={hue} />
          <span className="who-name">{name}</span>
        </div>
        <div className="anywhere">{draft.role || "What it's for appears here."}</div>
      </div>

      <div className="label">What it may do</div>
      <div className="may-do">
        {groups.allow.length > 0 && (
          <div>
            <span className="ok-text">Allowed </span>
            <span>{groups.allow.join(", ")}</span>
          </div>
        )}
        {groups.ask.length > 0 && (
          <div>
            <span className="warn-text">Asks first </span>
            <span>{groups.ask.join(", ")}</span>
          </div>
        )}
        {groups.off.length > 0 && (
          <div>
            <span className="muted bold">Off </span>
            <span className="muted">{groups.off.join(", ")}</span>
          </div>
        )}
        {draft.permissions.edit !== "off" && (
          <div>
            <span className="muted bold">Edits </span>
            <span>{area ? `only in ${area}` : packAreas.length ? "in the project" : "anywhere in the project"}</span>
            {packAreas.map((p) => (
              <div key={p.key}>
                <span>
                  and only in {p.area}, by the rules from {p.label}
                </span>
              </div>
            ))}
          </div>
        )}
        {draft.rulePacks.length > 0 && (
          <div>
            <span className="muted bold">Rules from mods </span>
            <span>{draft.rulePacks.map((r) => r.label).join(", ")}</span>
          </div>
        )}
      </div>

      <div className="form-actions">
        {props.problem && <div className="form-problem">{props.problem}</div>}
        {!props.real && (
          <div className="label">Only Claude Code with an API key runs for real so far; this agent will be a scripted placeholder.</div>
        )}
        <button type="button" className="btn primary big" disabled={Boolean(props.problem)} onClick={props.onSubmit}>
          {props.reviewing ? "Save reviewed settings" : props.editing ? "Save changes" : "Create agent"}
        </button>
        <button type="button" className="btn big" onClick={() => showView({ kind: "main" })}>
          Cancel
        </button>
        {props.editing && <RemoveAgent agent={draft} />}
      </div>
    </aside>
  );
}

/** Removing an existing agent; removeAgent asks first, and leaves this page if it goes. */
function RemoveAgent({ agent }: { agent: Agent }) {
  return (
    <button type="button" className="link-btn form-remove" onClick={() => removeAgent(agent.id).catch((e) => notify(String(e)))}>
      Remove agent…
    </button>
  );
}
