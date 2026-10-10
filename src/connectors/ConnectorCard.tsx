// One connector on the Connectors page: where it runs, its state with the
// action that state needs, its tools, and which agents may use it.

import { useRef, useState } from "react";
import { Avatar } from "../avatars/Avatar";
import { Segmented } from "../components/controls";
import { PopupMenu, type MenuItem } from "../layout/Menu";
import { MoreIcon } from "../layout/icons";
import { ChevronIcon } from "../mods/page/icons";
import { hueOf, notify, useStore } from "../model/store";
import type { ConnectorState, ConnectorTool, Permission } from "../model/types";
import { visibleText } from "../model/visible-text";
import { ConnectorTile, artFor } from "./ConnectorTile";
import { approveTools, message, removeConnector, setAccess, testConnector, useConnectors, type ConnectorEntry } from "./store";
import { whereItRuns } from "./templates";

export const ACCESS_OPTIONS: { value: Permission; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
];

/** The state in a few words, and how it should look. */
export function stateText(state: ConnectorState, approvedBefore: boolean): { text: string; tone: "ok" | "warn" | "error" | "quiet" } {
  switch (state.kind) {
    case "unchecked":
      return { text: "Not checked yet", tone: "quiet" };
    case "checking":
      return { text: "Checking…", tone: "quiet" };
    case "ok":
      return { text: `Ready · ${count(state.tools.length)}`, tone: "ok" };
    case "changed":
      return { text: approvedBefore ? "Its tools changed" : `${count(state.tools.length)} to approve`, tone: "warn" };
    case "failed":
      return { text: "Not working", tone: "error" };
    case "sign-in":
      return { text: "Needs its token", tone: "warn" };
  }
}

const count = (n: number) => (n === 1 ? "1 tool" : `${n} tools`);

export function ConnectorCard(props: { entry: ConnectorEntry; onEdit: () => void }) {
  const { connector, state } = props.entry;
  const agents = useStore((s) => s.agents);
  const approved = useConnectors((s) => s.approvedTools[connector.id]);
  const [step, setStep] = useState<"idle" | "remove">("idle");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { name } = connector;
  const approvedBefore = connector.approvedHash !== null;
  const status = stateText(state, approvedBefore);
  const tools = state.kind === "ok" || state.kind === "changed" ? state.tools : null;
  // A first approval lists every tool already, so there is nothing more to unfold.
  const foldable = tools !== null && tools.length > 0 && !(state.kind === "changed" && !approvedBefore);

  const act = async (run: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await run();
      if (done) notify(done);
      setStep("idle");
    } catch (e) {
      notify(`${name}: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const test = () => void act(() => testConnector(connector.id));

  const menu: MenuItem[] = [
    { label: "Edit…", run: props.onEdit },
    { label: "Check again", run: test, disabled: state.kind === "checking" },
    "separator",
    { label: "Remove…", run: () => setStep("remove") },
  ];

  return (
    <section className="panel conn-card" aria-label={name} data-step={step}>
      <div className="conn-top">
        <ConnectorTile art={artFor(connector)} />
        <div className="conn-body">
          <div className="conn-title">
            <h3 className="conn-name">{name}</h3>
            <code className="conn-slug" title="The name its tools reach agents under">
              {connector.slug}
            </code>
            {connector.transport.kind === "url" ? <span className="conn-tag">remote</span> : <span className="conn-tag">on this computer</span>}
          </div>
          <div className="conn-where ellipsis" title={connector.transport.kind === "url" ? connector.transport.url : undefined}>
            {whereItRuns(connector.transport)}
          </div>
          {state.kind === "failed" && (
            <div className="conn-reason" data-tone="error">
              {state.reason}
              {state.retriesLeft > 0 ? ` It tries again by itself (${state.retriesLeft} more).` : ""}
            </div>
          )}
          {state.kind === "sign-in" && <div className="conn-reason">{state.reason}</div>}
          {connector.trust === "changed-outside" && (
            <div className="conn-reason" data-tone="warn">
              Its saved settings were changed outside the app, so its tools ask on every call until you look at it again.
            </div>
          )}
          {foldable && (
            <button type="button" className="conn-fold" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>
              {toolsOpen ? "Hide its tools" : `Show its ${count(tools!.length)}`}
              <ChevronIcon open={toolsOpen} />
            </button>
          )}
        </div>
        <div className="conn-side">
          <div className="conn-controls">
            <span className="conn-state" data-tone={status.tone}>
              {status.text}
            </span>
            <button
              ref={menuButton}
              type="button"
              className="icon-btn small muted"
              aria-label={`${name} options`}
              title="Options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreIcon />
            </button>
          </div>
          {(state.kind === "unchecked" || state.kind === "failed") && (
            <button type="button" className="btn" disabled={busy} onClick={test}>
              {state.kind === "failed" ? "Retry" : "Check"}
            </button>
          )}
          {state.kind === "sign-in" && (
            <button type="button" className="btn" onClick={props.onEdit}>
              Set token…
            </button>
          )}
        </div>
      </div>

      {state.kind === "changed" && (
        <ToolReview
          name={name}
          tools={state.tools}
          approved={approvedBefore ? (approved ?? null) : []}
          firstTime={!approvedBefore}
          busy={busy}
          onApprove={() => void act(() => approveTools(connector.id), `${name}'s tools are approved.`)}
        />
      )}
      {toolsOpen && foldable && <ToolList tools={tools!} />}

      <div className="conn-access" role="group" aria-label={`Who may use ${name}`}>
        <div className="conn-access-head">
          <span className="label">Who may use it</span>
          {state.kind === "changed" && <span className="label">Until you approve its tools, every call asks.</span>}
        </div>
        {agents.length === 0 && <div className="label">No agents in this project yet.</div>}
        {agents.map((a) => (
          <div key={a.id} className="conn-access-row">
            <Avatar name={a.name} style={a.avatarStyle} mode="idle" size={22} hue={hueOf(a)} />
            <span className="conn-agent ellipsis">{a.name}</span>
            <Segmented
              label={`${a.name}'s access to ${name}`}
              value={a.connectors[connector.id] ?? "off"}
              options={ACCESS_OPTIONS}
              onChange={(p) => setAccess(a, connector.id, p)}
            />
          </div>
        ))}
      </div>

      {step === "remove" && (
        <div className="conn-confirm" role="group" aria-label={`Remove ${name}`} onKeyDown={(e) => e.key === "Escape" && setStep("idle")}>
          <div className="conn-confirm-title">Remove {name}?</div>
          <div>Agents lose its tools at once, and its stored secrets are deleted from your keychain.</div>
          <div className="row wrap gap8">
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              autoFocus
              onClick={() => void act(() => removeConnector(connector.id), `${name} was removed.`)}
            >
              Remove
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setStep("idle")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {menuOpen && <PopupMenu anchor={menuButton.current} label={`${name} options`} items={menu} onClose={() => setMenuOpen(false)} />}
    </section>
  );
}

function Hints({ tool }: { tool: ConnectorTool }) {
  return (
    <>
      {tool.readOnly && <span className="conn-hint-chip" data-tone="ok">reads only</span>}
      {tool.destructive && <span className="conn-hint-chip" data-tone="warn">can delete or overwrite</span>}
    </>
  );
}

function ToolList({ tools, marks }: { tools: ConnectorTool[]; marks?: Record<string, string> }) {
  return (
    <ul className="conn-tools">
      {tools.map((t) => (
        <ToolItem key={t.name} tool={t} mark={marks?.[t.name]} />
      ))}
    </ul>
  );
}

/** A description longer than this is cut to two lines until the tool is unfolded. */
const LONG_TEXT = 120;

/**
 * One tool. Approving a connector's tools approves what each one takes too,
 * so its input schema and its whole description unfold here. Text from the
 * server is shown without hidden characters.
 */
function ToolItem({ tool: t, mark }: { tool: ConnectorTool; mark?: string }) {
  const [open, setOpen] = useState(false);
  const schema = t.inputSchema === undefined ? null : visibleText(JSON.stringify(t.inputSchema, null, 2) ?? "");
  const name = visibleText(t.name);
  const foldable = schema !== null || t.description.length > LONG_TEXT;
  return (
    <li>
      <span className="conn-tool-head">
        <code>{name}</code>
        {mark && <span className="conn-hint-chip" data-tone="warn">{mark}</span>}
        <Hints tool={t} />
      </span>
      {t.description && <span className={open ? "conn-tool-text full" : "conn-tool-text"}>{visibleText(t.description)}</span>}
      {foldable && (
        <button type="button" className="conn-tool-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide details" : schema !== null ? "Show what it takes" : "Show all of it"}
          <ChevronIcon open={open} size={10} />
        </button>
      )}
      {open && schema !== null && (
        <pre className="conn-schema" tabIndex={0} aria-label={`What ${name} takes, as a JSON schema`}>
          {schema}
        </pre>
      )}
    </li>
  );
}

/** JSON with its keys in order, to tell whether two schemas say the same. */
function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

/**
 * Approving tools: for a new connector, all of them; for a changed one, what
 * differs from the tools approved before (when they are known here).
 */
function ToolReview(props: {
  name: string;
  tools: ConnectorTool[];
  approved: ConnectorTool[] | null;
  firstTime: boolean;
  busy: boolean;
  onApprove: () => void;
}) {
  const { tools, approved, firstTime } = props;
  const before = new Map((approved ?? []).map((t) => [t.name, t]));
  const marks: Record<string, string> = {};
  if (approved && !firstTime) {
    for (const t of tools) {
      const old = before.get(t.name);
      if (!old) marks[t.name] = "new";
      else if (
        old.description !== t.description ||
        old.readOnly !== t.readOnly ||
        old.destructive !== t.destructive ||
        // Tools approved before schemas were kept have none to compare.
        (old.inputSchema !== undefined && !sameJson(old.inputSchema, t.inputSchema))
      ) {
        marks[t.name] = "changed";
      }
    }
  }
  const gone = approved && !firstTime ? approved.filter((t) => !tools.some((x) => x.name === t.name)) : [];
  const marked = tools.filter((t) => marks[t.name]);
  // When what differs can't be told apart here, every tool is shown.
  const known = Boolean(approved) && !firstTime && (marked.length > 0 || gone.length > 0);
  const changed = known ? marked : tools;

  return (
    <div className="conn-review" role="group" aria-label={`Approve ${props.name}'s tools`}>
      <div className="conn-confirm-title">
        {firstTime ? `Approve ${props.name}'s tools?` : `${props.name}'s tools changed since you approved them`}
      </div>
      <div className="muted">
        {firstTime
          ? "These are what agents with access could call. Until you approve them, every call asks, even with Allow."
          : known
            ? "Until you approve them again, every call asks, even with Allow. What differs:"
            : "Until you approve them again, every call asks, even with Allow. Its tools now:"}
      </div>
      {changed.length > 0 && <ToolList tools={changed} marks={marks} />}
      {gone.length > 0 && (
        <div className="label">
          No longer offered: {gone.map((t) => visibleText(t.name)).join(", ")}
        </div>
      )}
      <div className="row wrap gap8">
        <button type="button" className="btn primary" disabled={props.busy} onClick={props.onApprove}>
          Approve tools
        </button>
      </div>
    </div>
  );
}
