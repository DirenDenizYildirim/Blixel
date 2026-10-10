// Adding or editing a connector, in a small card over the page: the
// templates to pick from, then the few fields the one picked needs. Secrets
// typed here go straight to the keychain through the core and never come back.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { APP_NAME } from "../brand";
import { Segmented } from "../components/controls";
import { CloseIcon } from "../components/icons";
import { notify, uid } from "../model/store";
import type { Connector, ConnectorTransport, ConnectorVar } from "../model/types";
import { artFor, ConnectorTile, templateArt } from "./ConnectorTile";
import { connectorsAvailable, message, NEEDS_APP, saveConnector, storeSecrets, testConnector, useConnectors } from "./store";
import {
  CUSTOM,
  freeSlug,
  joinArgs,
  slugProblem,
  splitArgs,
  TEMPLATES,
  templateById,
  whereItRuns,
  type Built,
  type ConnectorTemplate,
  type FieldValues,
} from "./templates";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_NAME = 40;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The pop-up. Without `editing` it starts at the template list, or at
 * `startWith`'s form; with it, at that connector's form.
 */
export function AddConnector(props: {
  editing?: Connector;
  startWith?: string;
  onClose: () => void;
  onSaved?: (connector: Connector) => void;
}) {
  const { editing } = props;
  const [picked, setPicked] = useState<string | undefined>(editing ? (editing.template ?? CUSTOM.id) : props.startWith);
  const [busy, setBusy] = useState(false);
  const close = () => !busy && props.onClose();
  const label = editing ? `Edit ${editing.name}` : "Add a connector";

  return (
    <Dialog label={label} onClose={close}>
      {picked === undefined ? (
        <Pick onPick={setPicked} onClose={close} />
      ) : (
        <ConnectorForm
          key={picked}
          templateId={picked}
          editing={editing}
          busy={busy}
          setBusy={setBusy}
          onBack={editing || props.startWith ? undefined : () => setPicked(undefined)}
          onClose={close}
          onSaved={(c) => {
            props.onSaved?.(c);
            props.onClose();
          }}
        />
      )}
    </Dialog>
  );
}

/** A modal card: it takes focus, keeps Tab inside, and gives focus back when it closes. */
function Dialog(props: { label: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const all = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select, textarea")];
    const first = all[0];
    const last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    <div className="conn-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={props.label} className="conn-pop" onKeyDown={onKeyDown}>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

/** Focuses the first field (or button) of a step when it appears. */
function useFirstFocus(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-first], input:not(:disabled), button:not(:disabled)")?.focus();
  }, [ref]);
}

function Pick({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFirstFocus(ref);
  return (
    <div ref={ref} className="conn-pop-step">
      <header className="conn-pop-head">
        <div className="grow min0">
          <h2>Add a connector</h2>
          <div className="conn-pop-sub">Tools from a service, shared by every project. You choose which agents may use them.</div>
        </div>
        <CloseButton onClose={onClose} />
      </header>
      <div className="conn-pop-body">
        <div className="conn-pick" role="list">
          {[...TEMPLATES, CUSTOM].map((t, i) => (
            <button key={t.id} type="button" role="listitem" className="conn-pick-item" data-first={i === 0 || undefined} onClick={() => onPick(t.id)}>
              <ConnectorTile art={templateArt(t.id === CUSTOM.id ? null : t.id)} size={44} />
              <span className="conn-pick-text">
                <span className="conn-pick-name">{t.name}</span>
                <span className="conn-pick-blurb">{t.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        {!connectorsAvailable && <div className="conn-pop-note">{NEEDS_APP} Here you can see what each one asks for.</div>}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="icon-btn small muted" aria-label="Close" title="Close" onClick={onClose}>
      <CloseIcon size={13} />
    </button>
  );
}

// ---- The form ----

interface VarRow {
  key: string;
  name: string;
  value: string;
  secret: boolean;
  /** A secret already in the keychain: left empty, it keeps its value. */
  stored: boolean;
}

let rowKey = 0;
const newRow = (secret = false): VarRow => ({ key: `r${rowKey++}`, name: "", value: "", secret, stored: false });
const rowsOf = (vars: ConnectorVar[]): VarRow[] =>
  vars.map((v) => ({ key: `r${rowKey++}`, name: v.name, value: v.secret ? "" : v.value, secret: v.secret, stored: v.secret && v.isSet !== false }));

const varsOf = (t: ConnectorTransport) => (t.kind === "command" ? t.env : t.headers);

function ConnectorForm(props: {
  templateId: string;
  editing?: Connector;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onBack?: () => void;
  onClose: () => void;
  onSaved: (c: Connector) => void;
}) {
  const { editing, busy } = props;
  const template = templateById(props.templateId === CUSTOM.id ? null : props.templateId);
  const entries = useConnectors((s) => s.entries);
  const others = entries.map((e) => e.connector).filter((c) => c.id !== editing?.id);
  const before = editing?.transport ?? null;
  const ref = useRef<HTMLDivElement>(null);
  useFirstFocus(ref);

  const [name, setName] = useState(editing?.name ?? template?.name ?? "");
  const [slug, setSlug] = useState(editing?.slug ?? (template ? freeSlug(template.id, others) : ""));
  // A new connector's slug follows its name until the user edits the slug.
  const [slugEdited, setSlugEdited] = useState(Boolean(editing));
  const [values, setValues] = useState<FieldValues>(() => (template && before ? template.read(before) : {}));
  const [kind, setKind] = useState<"command" | "url">(before?.kind ?? "command");
  const [command, setCommand] = useState(before?.kind === "command" ? before.command : "");
  const [args, setArgs] = useState(before?.kind === "command" ? joinArgs(before.args) : "");
  const [url, setUrl] = useState(before?.kind === "url" ? before.url : "");
  const [env, setEnv] = useState<VarRow[]>(before?.kind === "command" && !template ? rowsOf(before.env) : []);
  const [headers, setHeaders] = useState<VarRow[]>(before?.kind === "url" && !template ? rowsOf(before.headers) : []);
  const [error, setError] = useState<string | null>(null);
  // Once saved, trying again (after a secret could not be stored, say) changes that connector instead of adding another.
  const [savedAs, setSavedAs] = useState<Connector | null>(null);
  const base = savedAs ?? editing;

  const storedSecret = Boolean(before && varsOf(before).some((v) => v.secret && v.isSet !== false));
  const rename = (next: string) => {
    setName(next);
    if (!slugEdited) setSlug(freeSlug(next || template?.id || "", others));
  };

  const built: Built | string = template ? buildTemplate(template, values, before, storedSecret) : buildCustom();
  const problem =
    !name.trim()
      ? "Give it a name."
      : name.trim().length > MAX_NAME
        ? `Keep the name to ${MAX_NAME} characters.`
        : (!base && slugProblem(slug, others)) || (typeof built === "string" ? built : null);

  function buildCustom(): Built | string {
    const rows = (kind === "command" ? env : headers).filter((r) => r.name.trim() || r.value || r.stored);
    const what = kind === "command" ? "variable" : "header";
    const seen = new Set<string>();
    for (const r of rows) {
      const n = r.name.trim();
      if (!(kind === "command" ? ENV_NAME : HEADER_NAME).test(n))
        return n ? `${n} is not a usable ${what} name.` : `Give every ${what} a name.`;
      const id = kind === "command" ? n : n.toLowerCase();
      if (seen.has(id)) return `${n} is listed twice.`;
      seen.add(id);
      if (r.secret && !r.value && !r.stored) return `Give the secret ${n} a value.`;
    }
    const vars = rows.map((r): ConnectorVar => ({ name: r.name.trim(), value: r.secret ? "" : r.value, secret: r.secret }));
    const secrets = Object.fromEntries(rows.filter((r) => r.secret && r.value).map((r) => [r.name.trim(), r.value]));
    if (kind === "command") {
      if (!command.trim()) return "Say which command starts it.";
      return { transport: { kind: "command", command: command.trim(), args: splitArgs(args), env: vars }, secrets };
    }
    const problemWithUrl = urlProblem(url.trim());
    if (problemWithUrl) return problemWithUrl;
    return { transport: { kind: "url", url: url.trim(), headers: vars }, secrets };
  }

  const submit = async () => {
    if (problem || busy || typeof built === "string" || !connectorsAvailable) return;
    props.setBusy(true);
    setError(null);
    try {
      const connector: Connector = {
        id: base?.id ?? uid("conn"),
        slug: base?.slug ?? slug,
        name: name.trim(),
        template: template?.id ?? null,
        created: base?.created ?? Date.now(),
        transport: built.transport,
        approvedHash: base?.approvedHash ?? null,
        trust: base?.trust ?? "ok",
      };
      const saved = await saveConnector(connector);
      setSavedAs(saved);
      try {
        await storeSecrets(saved.id, built.secrets);
      } catch (e) {
        throw new Error(`It was saved, but its secret could not be stored in the keychain: ${message(e)}`);
      }
      void testConnector(saved.id);
      notify(`${saved.name} was ${editing ? "saved" : "added"}. Checking it now.`);
      props.onSaved(saved);
    } catch (e) {
      setError(message(e));
    } finally {
      props.setBusy(false);
    }
  };

  const art = base ? artFor(base) : templateArt(template?.id ?? null);
  const where = typeof built === "string" ? null : whereItRuns(built.transport);

  return (
    <form
      ref={ref as React.RefObject<HTMLFormElement | null>}
      className="conn-pop-step"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header className="conn-pop-head">
        <ConnectorTile art={art} size={44} />
        <div className="grow min0">
          <h2>{editing ? `Edit ${editing.name}` : `Add ${template?.name ?? "a custom connector"}`}</h2>
          <div className="conn-pop-sub">{template?.blurb ?? CUSTOM.blurb}</div>
        </div>
        <CloseButton onClose={props.onClose} />
      </header>

      <div className="conn-pop-body">
        <div className="row wrap gap14">
          <label className="field grow1">
            <span className="label">Name</span>
            <input className="input strong" value={name} maxLength={60} spellCheck={false} onChange={(e) => rename(e.target.value)} />
          </label>
          <label className="field conn-slug-field">
            <span className="label">Name for its tools</span>
            {base ? (
              <span className="input conn-slug-fixed">{base.slug}</span>
            ) : (
              <input
                className="input"
                value={slug}
                maxLength={24}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            )}
          </label>
        </div>
        <div className="conn-hint">
          Agents see its tools as <code>mcp__{(base?.slug ?? slug) || "…"}__tool</code>.{" "}
          {base ? "This name stays as it was added." : "It cannot change once added."}
        </div>

        {template ? (
          <TemplateFields template={template} values={values} setValues={setValues} stored={storedSecret} editing={Boolean(editing)} />
        ) : (
          <CustomFields
            kind={kind}
            setKind={setKind}
            command={command}
            setCommand={setCommand}
            args={args}
            setArgs={setArgs}
            url={url}
            setUrl={setUrl}
            rows={kind === "command" ? env : headers}
            setRows={kind === "command" ? setEnv : setHeaders}
            locked={Boolean(editing)}
          />
        )}

        {where && (
          <div className="conn-hint">
            {(typeof built !== "string" && built.transport.kind === "url" ? "Connects to " : "Runs ") + where}
            {template?.needs ? `. Needs ${template.needs}.` : "."}
          </div>
        )}
        {!template && (
          <div className="conn-warn" role="note">
            A custom connector works with your rights, outside {APP_NAME}'s rules for files and commands: if it reads or changes files
            or runs commands, edit areas and protected files don't apply to it. Add only servers you trust.
          </div>
        )}
        {!connectorsAvailable && <div className="conn-pop-note">{NEEDS_APP} Nothing is saved here.</div>}
      </div>

      <footer className="conn-pop-foot">
        <span className="conn-pop-problem" role="status">
          {error ?? problem}
        </span>
        <button type="button" className="btn" disabled={busy} onClick={props.onBack ?? props.onClose}>
          {props.onBack ? "Back" : "Cancel"}
        </button>
        <button type="submit" className="btn primary" disabled={Boolean(problem) || busy || !connectorsAvailable}>
          {busy ? "Saving…" : editing ? "Save and check" : "Add and check"}
        </button>
      </footer>
    </form>
  );
}

function buildTemplate(t: ConnectorTemplate, values: FieldValues, before: ConnectorTransport | null, stored: boolean): Built | string {
  for (const f of t.fields) {
    const v = values[f.key];
    if (f.kind === "secret" && !f.optional && !stored && !(typeof v === "string" && v.trim())) return `Paste the ${f.label.toLowerCase()}.`;
  }
  return t.build(values, before);
}

function urlProblem(text: string): string | null {
  if (!text) return "Give the server's address.";
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return "That address doesn't look complete; it starts with https://.";
  }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOCAL_HOSTS.includes(u.hostname)) return null;
  return "Use an https:// address; plain http is only for servers on this computer.";
}

function SwitchButton(props: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={props.checked} aria-label={props.label} className="switch" onClick={() => props.onChange(!props.checked)}>
      <span />
    </button>
  );
}

function TemplateFields(props: {
  template: ConnectorTemplate;
  values: FieldValues;
  setValues: React.Dispatch<React.SetStateAction<FieldValues>>;
  stored: boolean;
  editing: boolean;
}) {
  const { template, values, setValues, stored } = props;
  const set = (key: string, v: string | boolean) => setValues((all) => ({ ...all, [key]: v }));
  if (!template.fields.length) return <div className="conn-hint top12">Nothing to fill in: it needs no account or key.</div>;
  return (
    <div className="conn-fields">
      {template.fields.map((f) =>
        f.kind === "secret" ? (
          <label key={f.key} className="field">
            <span className="label">{f.label}</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={stored ? "Stored in your keychain; paste to replace it" : f.placeholder}
              value={typeof values[f.key] === "string" ? (values[f.key] as string) : ""}
              onChange={(e) => set(f.key, e.target.value)}
            />
            {f.hint && <span className="conn-hint">{f.hint} It is kept in your system keychain, never in a project.</span>}
          </label>
        ) : (
          <div key={f.key} className="tool-row">
            <div className="tool-text">
              <span>{f.label}</span>
              {f.hint && <span className="label">{f.hint}</span>}
            </div>
            <SwitchButton label={f.label} checked={values[f.key] === true} onChange={(on) => set(f.key, on)} />
          </div>
        ),
      )}
    </div>
  );
}

function CustomFields(props: {
  kind: "command" | "url";
  setKind: (k: "command" | "url") => void;
  command: string;
  setCommand: (v: string) => void;
  args: string;
  setArgs: (v: string) => void;
  url: string;
  setUrl: (v: string) => void;
  rows: VarRow[];
  setRows: React.Dispatch<React.SetStateAction<VarRow[]>>;
  /** A saved connector keeps how it is reached; only its details change. */
  locked: boolean;
}) {
  const { kind, rows, setRows } = props;
  const patch = (key: string, p: Partial<VarRow>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const what = kind === "command" ? "variable" : "header";
  return (
    <div className="conn-fields">
      {!props.locked && (
        <div className="row wrap gap10 center">
          <span className="label">How it is reached</span>
          <Segmented
            label="How it is reached"
            value={kind}
            options={[
              { value: "command", label: "Command on this computer" },
              { value: "url", label: "Address on the web" },
            ]}
            onChange={props.setKind}
          />
        </div>
      )}
      {kind === "command" ? (
        <div className="row wrap gap14">
          <label className="field conn-command">
            <span className="label">Command</span>
            <input className="input" value={props.command} placeholder="npx" spellCheck={false} onChange={(e) => props.setCommand(e.target.value)} />
          </label>
          <label className="field grow2">
            <span className="label">Arguments</span>
            <input
              className="input"
              value={props.args}
              placeholder="-y some-mcp-server --stdio"
              spellCheck={false}
              onChange={(e) => props.setArgs(e.target.value)}
            />
          </label>
        </div>
      ) : (
        <label className="field">
          <span className="label">Address</span>
          <input
            className="input"
            value={props.url}
            placeholder="https://example.com/mcp"
            spellCheck={false}
            inputMode="url"
            onChange={(e) => props.setUrl(e.target.value)}
          />
        </label>
      )}

      <div className="field">
        <span className="label">{kind === "command" ? "Environment variables" : "Headers"}</span>
        {rows.map((r) => (
          <div key={r.key} className="conn-var">
            <input
              className="input conn-var-name"
              value={r.name}
              aria-label={`${what} name`}
              placeholder={kind === "command" ? "NAME" : "Header"}
              spellCheck={false}
              onChange={(e) => patch(r.key, { name: e.target.value })}
            />
            <input
              className="input conn-var-value"
              type={r.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              aria-label={`${r.name || what} value`}
              placeholder={r.secret && r.stored ? "Stored; type to replace" : "Value"}
              value={r.value}
              onChange={(e) => patch(r.key, { value: e.target.value })}
            />
            <button
              type="button"
              className="conn-secret"
              aria-pressed={r.secret}
              title={r.secret ? "Kept in your keychain" : "Kept with the connector's settings"}
              onClick={() => patch(r.key, { secret: !r.secret, stored: false })}
            >
              secret
            </button>
            <button
              type="button"
              className="icon-btn small muted"
              aria-label={`Remove ${r.name || what}`}
              title="Remove"
              onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
        <div>
          <button type="button" className="link-btn conn-add-row" onClick={() => setRows((all) => [...all, newRow(kind === "url")])}>
            + Add {what}
          </button>
        </div>
        <span className="conn-hint">Mark tokens and passwords as secret: they go to your keychain and are never shown again.</span>
      </div>
    </div>
  );
}
