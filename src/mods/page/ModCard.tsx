// One mod on the Mods page: who it is, what it adds and asks for, a switch to
// turn it on (through an approval of exactly what it asks for) or off, a menu
// for the rest, and what went wrong recently.

import { useEffect, useRef, useState } from "react";
import { PopupMenu, type MenuItem } from "../../layout/Menu";
import { MoreIcon } from "../../layout/icons";
import { notify } from "../../model/store";
import { reloadDevMod, removeMod, turnOff, turnOn } from "../registry";
import { CAPABILITIES, type ModRecord } from "../types";
import { ChevronIcon } from "./icons";
import { ModIcon } from "./ModIcon";
import { additions, type ModFacts } from "./model";
import { modIcon } from "./pixel-icons";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Theme swatches shown at most; the rest are counted. */
const MAX_SWATCHES = 8;

type Step = "idle" | "approve" | "remove";

export function ModCard(props: { mod: ModRecord; facts: ModFacts; errors: string[]; codeOff: boolean }) {
  const { mod, facts, errors, codeOff } = props;
  const [step, setStep] = useState<Step>("idle");
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const m = mod.manifest;
  const { name, on, approved, changed, asks, newAsks, asksMore, code } = facts;

  const act = async (change: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await change();
      notify(done);
      setStep("idle");
    } catch (e) {
      notify(`${name}: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const flip = () => {
    if (on) void act(() => turnOff(mod.id), `${name} is off.`);
    else setStep(step === "approve" ? "idle" : "approve");
  };

  const copyPath = () => {
    const done = () => notify(`Copied ${mod.dir}`);
    if (!navigator.clipboard) return notify(mod.dir);
    navigator.clipboard.writeText(mod.dir).then(done, () => notify(mod.dir));
  };

  const menu: MenuItem[] = [];
  if (mod.dev) menu.push({ label: "Reload", run: () => void act(() => reloadDevMod(mod.id), `${name} was reloaded.`) });
  if (approved && !on) menu.push({ label: "Turn off", run: () => void act(() => turnOff(mod.id), `${name} is off.`) });
  if (mod.dir) menu.push({ label: "Copy folder path", run: copyPath });
  if (!mod.builtin) menu.push("separator", { label: "Remove…", run: () => setStep("remove") });

  const added = additions(m);
  const label = `${name}${m?.version ? ` ${m.version}` : ""}`;

  return (
    <section className="panel mod-card" aria-label={label} data-step={step}>
      <div className="mod-top">
        <ModIcon {...modIcon(mod.id, m)} />

        <div className="mod-body">
          <div className="mod-title">
            <h3 className="mod-name">{name}</h3>
            {m?.version && <span className="mod-version">{m.version}</span>}
            {mod.builtin && <span className="mod-tag">built in</span>}
            {mod.dev && <span className="mod-tag dev">dev</span>}
            {m?.author && <span className="mod-by">by {m.author}</span>}
          </div>
          {m?.description && <p className="mod-text">{m.description}</p>}

          <dl className="mod-facts">
            {added.length > 0 && (
              <div className="mod-fact">
                <dt>Adds</dt>
                <dd>
                  {added.map((a) => (
                    <span key={a.key} className="mod-chip" title={a.names.join(", ")}>
                      {a.text}
                      {a.themes && (
                        <span className="mod-swatches">
                          {a.themes.slice(0, MAX_SWATCHES).map((t) => (
                            <span
                              key={t.id}
                              className="mod-swatch"
                              title={t.label}
                              style={{ background: t.tokens.bg, borderColor: t.tokens.border }}
                            >
                              <i style={{ background: t.tokens.accent }} />
                              <i style={{ background: t.tokens.fg }} />
                            </span>
                          ))}
                          {a.themes.length > MAX_SWATCHES && <span className="mod-more">+{a.themes.length - MAX_SWATCHES}</span>}
                        </span>
                      )}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            <div className="mod-fact">
              <dt>Needs</dt>
              <dd>
                {asks.length > 0 ? (
                  asks.map((c) => (
                    <span key={c} className="mod-chip perm" data-new={newAsks.includes(c) || undefined} title={c}>
                      {CAPABILITIES[c]}
                    </span>
                  ))
                ) : (
                  <span className="mod-none">no permissions</span>
                )}
              </dd>
            </div>
            {code && (
              <div className="mod-fact">
                <dt>Runs</dt>
                <dd>
                  <span className="mod-none">its own code, in a sandbox</span>
                </dd>
              </div>
            )}
          </dl>

          {on && code && codeOff && <div className="mod-quiet">Its code is off for this session.</div>}
        </div>

        <div className="mod-side">
          <div className="mod-controls">
            {mod.builtin ? (
              <span className="mod-always">Always on</span>
            ) : (
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={on}
                aria-label={name}
                aria-expanded={on ? undefined : step === "approve"}
                disabled={busy || (!on && Boolean(mod.error))}
                title={mod.error && !on ? "It cannot run; see the problem below." : undefined}
                onClick={flip}
              >
                <span />
              </button>
            )}
            {menu.length > 0 && (
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
            )}
          </div>
          {!mod.builtin && (
            <div className="mod-status" data-tone={facts.status.tone}>
              {facts.status.text}
            </div>
          )}
        </div>
      </div>

      {changed && step === "idle" && (
        <div className="mod-note" role="status">
          <span className="grow">Its files changed since you approved it, so it stays off until you approve it again.</span>
          <button type="button" className="btn" disabled={busy} onClick={() => setStep("approve")}>
            Review and approve…
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => turnOff(mod.id), `${name} is off.`)}>
            Turn off
          </button>
        </div>
      )}
      {!changed && asksMore && step === "idle" && (
        <div className="mod-note" role="status">
          <span className="grow">It asks for more than you approved. Until you approve again, it runs with only what you approved.</span>
          <button type="button" className="btn" disabled={busy} onClick={() => setStep("approve")}>
            Review…
          </button>
        </div>
      )}

      {(mod.error || errors.length > 0) && <Problems error={mod.error} errors={errors} />}

      {step === "approve" && (
        <Approval
          name={name}
          facts={facts}
          busy={busy}
          onApprove={() => void act(() => turnOn(mod.id, asks), `${name} is on.`)}
          onCancel={() => setStep("idle")}
        />
      )}

      {step === "remove" && (
        <Confirm
          label={`Remove ${name}`}
          tone="danger"
          title={`Remove ${name}?`}
          text={mod.dev ? "Its folder stays where it is; the app forgets the mod and what it stored." : "Its files and what it stored are deleted."}
          action="Remove"
          busy={busy}
          onConfirm={() => void act(() => removeMod(mod.id), `${name} was removed.`)}
          onCancel={() => setStep("idle")}
        />
      )}

      {menuOpen && <PopupMenu anchor={menuButton.current} label={`${name} options`} items={menu} onClose={() => setMenuOpen(false)} />}
    </section>
  );
}

/** Why it cannot run, and what went wrong recently: the newest shown, the rest folded away. */
function Problems({ error, errors }: { error: string | null; errors: string[] }) {
  const [open, setOpen] = useState(false);
  const newest = [...errors].reverse();
  const shown = open ? newest : newest.slice(0, 1);
  return (
    <div className="mod-problems" role="group" aria-label="Problems">
      {error && (
        <div>
          <span className="bold">It cannot run. </span>
          <span className="anywhere">{error}</span>
        </div>
      )}
      {errors.length > 0 && (
        <>
          <div className="mod-problems-head">
            <span className="bold grow">{errors.length === 1 ? "A recent problem" : `${errors.length} recent problems`}</span>
            {errors.length > 1 && (
              <button type="button" className="mod-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? "Show only the newest" : `Show all ${errors.length}`}
                <ChevronIcon open={open} />
              </button>
            )}
          </div>
          <ul>
            {shown.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Turning a mod on: exactly what it asks for, what is new since the last approval, and what no mod can ever do. */
function Approval(props: { name: string; facts: ModFacts; busy: boolean; onApprove: () => void; onCancel: () => void }) {
  const { name, facts, busy } = props;
  const { approved, changed, asks, newAsks, code } = facts;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    ref.current?.querySelector<HTMLButtonElement>(".btn.primary")?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={ref}
      className="mod-approve"
      role="group"
      aria-label={approved ? `Approve ${name} again` : `Turn on ${name}`}
      onKeyDown={(e) => e.key === "Escape" && props.onCancel()}
    >
      <div className="mod-approve-title">{approved ? `Approve ${name} again?` : `Turn on ${name}?`}</div>
      {changed && (
        <div>Its files changed since you last approved it. Approving lets this new version run, with what it now asks for below.</div>
      )}
      {asks.length > 0 ? (
        <>
          <div className="muted">{approved ? "It now asks to:" : "It will be able to:"}</div>
          <ul className="mod-caps">
            {asks.map((c) => (
              <li key={c}>
                <span className="mod-cap-text">{CAPABILITIES[c]}</span>
                <code className="mod-cap-id">{c}</code>
                {newAsks.includes(c) && <span className="mod-new">new since you approved it</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div>
          {code
            ? "It asks for no access to your files or agents: it only shows its own panels and commands."
            : "It has no code: it only adds what is listed above."}
        </div>
      )}
      <div className="mod-never">Mods can never answer permission requests, change your agents or read your keys.</div>
      <div className="row wrap gap8">
        <button type="button" className="btn primary" disabled={busy} onClick={props.onApprove}>
          {approved ? "Approve and turn on" : "Turn on"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Confirm(props: {
  label: string;
  tone: "danger";
  title: string;
  text: string;
  action: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    ref.current?.querySelector<HTMLButtonElement>(".btn.danger")?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      className="mod-approve"
      data-tone={props.tone}
      role="group"
      aria-label={props.label}
      onKeyDown={(e) => e.key === "Escape" && props.onCancel()}
    >
      <div className="mod-approve-title">{props.title}</div>
      <div>{props.text}</div>
      <div className="row wrap gap8">
        <button type="button" className="btn danger" disabled={props.busy} onClick={props.onConfirm}>
          {props.action}
        </button>
        <button type="button" className="btn" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
