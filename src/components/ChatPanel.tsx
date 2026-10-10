import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "../avatars/Avatar";
import { answerPermission, sendToAgent } from "../model/mock-agent";
import { answerRealPermission, cancelTurn, sendToRealAgent } from "../model/real-agent";
import { connectorName } from "../connectors/store";
import { ViewMenuButton } from "../layout/ViewMenu";
import { isOpen, setChatOpen, setEditorOpen, toggleShell, useLayout } from "../model/layout";
import { agentById, hueOf, notify, setComposerMode, setDraft, showView, useStore } from "../model/store";
import type { ActivityEntry, Agent, ChatItem } from "../model/types";
import { formatUsd, limitOf, showsSpending, spendLevel, useUsage } from "../model/usage";
import { visibleText } from "../model/visible-text";
import { agentColor } from "../theme/theme";
import { Segmented } from "./controls";
import { ChevronDown, ChevronRight, CloseIcon, CodeIcon, PlusIcon, SendIcon, StopIcon, TerminalIcon, WarnIcon } from "./icons";
import { agentSubline, avatarMode } from "./Sidebar";
import { TasksButton } from "./TasksPanel";
import "./chat.css";

const NO_ITEMS: ChatItem[] = [];

export function ChatPanel() {
  const editorOpen = useLayout((l) => isOpen(l, "editor"));
  const agent = useStore((s) => s.agents.find((a) => a.id === s.selectedId));
  const unreviewed = useStore((s) => Boolean(s.selectedId && s.agentTrust[s.selectedId]));
  const items = useStore((s) => (s.selectedId ? s.chats[s.selectedId] : undefined) ?? NO_ITEMS);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Keep the newest message in view unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  useEffect(() => {
    pinned.current = true;
  }, [agent?.id]);
  // When the chat gets shorter (a view opened under it), the newest message stays in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const keep = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    return () => keep.disconnect();
  }, [agent?.id]);

  const tools = (
    <div className="panel-tools">
      <ViewMenuButton view="chat" />
      {editorOpen ? (
        <button type="button" className="icon-btn small muted" aria-label="Hide chat" title="Hide chat" onClick={() => setChatOpen(false)}>
          <CloseIcon size={11} />
        </button>
      ) : (
        <button type="button" className="reopen-btn" aria-label="Show editor" title="Show the editor" onClick={() => setEditorOpen(true)}>
          <CodeIcon />
          <span>Editor</span>
        </button>
      )}
    </div>
  );

  if (!agent) {
    return (
      <section className="chat">
        <div className="chat-head" data-tauri-drag-region>
          {tools}
        </div>
        <p className="empty-chat">Create an agent to start.</p>
      </section>
    );
  }

  return (
    <section aria-label={`Chat with ${agent.name}`} className="chat">
      <div className="chat-head" data-tauri-drag-region>
        <button
          type="button"
          className="chat-who"
          title="Agent settings"
          onClick={() => showView({ kind: "agent-form", editingId: agent.id })}
        >
          <span>
            {agent.name}
            <span className="chat-desc">, {agentSubline(agent)}</span>
          </span>
          <Spending agent={agent} />
          <ChevronDown size={11} color="currentColor" width={2.6} />
        </button>
        {tools}
      </div>

      {unreviewed && <ReviewCard agent={agent} />}

      <div
        ref={scroller}
        className="chat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 && <div className="chat-note">Nothing here yet. Give {agent.name} a task below.</div>}
        {items.map((item) => (
          <ChatEntry key={item.id} item={item} owner={agent} />
        ))}
      </div>

      <Composer agent={agent} />
    </section>
  );
}

/** What the agent spent today, after its description: in the warning colour from 80% of its limit, the danger colour at it. */
function Spending({ agent }: { agent: Agent }) {
  const usage = useUsage(agent.id);
  if (!showsSpending(agent, usage)) return null;
  const limit = limitOf(agent);
  const spent = formatUsd(usage.today);
  return (
    <span
      className="chat-spend"
      data-level={spendLevel(agent, usage.today)}
      title={limit === null ? `Spent today: ${spent}, no daily limit` : `Spent today: ${spent} of its ${formatUsd(limit)} daily limit`}
    >
      · {spent}
      <span className="spend-today"> today</span>
      {limit !== null && <span className="spend-limit"> · limit {formatUsd(limit)}</span>}
    </span>
  );
}

/**
 * Above the chat while the agent's saved settings were changed outside the
 * app: the core won't run it until the user saves them from its form.
 */
function ReviewCard({ agent }: { agent: Agent }) {
  return (
    <div className="review-card" role="status">
      <WarnIcon size={15} />
      <span className="grow min0">
        {agent.name}'s saved settings were changed outside the app. Review them before it runs.
      </span>
      <button type="button" className="btn" onClick={() => showView({ kind: "agent-form", editingId: agent.id })}>
        Review
      </button>
    </div>
  );
}

function AgentName({ agent }: { agent: Agent }) {
  return (
    <>
      <Avatar name={agent.name} style={agent.avatarStyle} mode={avatarMode(agent.status)} size={20} hue={hueOf(agent)} />
      <span className="who-name">{agent.name}</span>
    </>
  );
}

function ChatEntry({ item, owner }: { item: ChatItem; owner: Agent }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="bubble user">
          <div className="bubble-head end">
            <span className="dot" style={{ background: "var(--accent)" }} />
            <span className="who-name">You</span>
            <span className="muted small">
              {item.delivery === "queued"
                ? "queued until this turn ends"
                : item.delivery === "returned"
                  ? "not sent, back in the message box"
                  : item.asTask
                    ? "as a task"
                    : "in chat"}
            </span>
          </div>
          <div className="pre-wrap">{item.text}</div>
        </div>
      );
    case "agent": {
      const agent = agentById(item.agentId) ?? owner;
      return (
        <div className="bubble card">
          <div className="bubble-head">
            <AgentName agent={agent} />
          </div>
          <div className="pre-wrap">
            {item.text}
            {item.streaming && <span className="stream-caret" />}
          </div>
        </div>
      );
    }
    case "activity":
      return <Activity entries={item.entries} agent={owner} />;
    case "handoff": {
      const from = agentById(item.from);
      const to = agentById(item.to);
      if (!from || !to) return null;
      return (
        <div className="bubble card">
          <div className="bubble-head wrap">
            <AgentName agent={from} />
            <span className="muted small">gave a task to</span>
            <AgentName agent={to} />
          </div>
          <div>{item.task}</div>
          <div className="muted small top6">{item.note}</div>
        </div>
      );
    }
    case "permission":
      return <PermissionRequest item={item} />;
    case "note":
      return <div className="chat-note">{item.text}</div>;
  }
}

function Activity({ entries, agent }: { entries: ActivityEntry[]; agent: Agent }) {
  const color = agentColor(hueOf(agent));
  return (
    <div className="activity">
      {entries.map((e) => (
        <ActivityRow key={e.id} entry={e} color={color} />
      ))}
    </div>
  );
}

/** One line of the log; one with more to it (a connector call's arguments) folds open. */
function ActivityRow({ entry: e, color }: { entry: ActivityEntry; color: string }) {
  const [open, setOpen] = useState(false);
  const target = e.detail ? (
    <button type="button" className="activity-fold grow min0" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="ellipsis">{visibleText(e.target)}</span>
      {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
    </button>
  ) : (
    <span className="grow min0 ellipsis">{visibleText(e.target)}</span>
  );
  return (
    <>
      <div className={"activity-row" + (e.refused ? " refused" : "")}>
        <span className="activity-dot" />
        <span className="activity-verb">{e.verb}</span>
        {target}
        <span className={e.live ? "pulse" : "muted"} style={e.live ? { color } : undefined}>
          {e.result}
        </span>
      </div>
      {open && e.detail && <pre className="activity-detail">{visibleText(e.detail)}</pre>}
    </>
  );
}

const ANSWERS = { allowed: "Allowed once", always: "Always allowed", denied: "Denied" } as const;

function answer(item: Extract<ChatItem, { kind: "permission" }>, value: keyof typeof ANSWERS) {
  if (agentById(item.agentId)?.placeholder === false) answerRealPermission(item.agentId, item.id, value);
  else answerPermission(item.agentId, item.id, value);
}

function PermissionRequest({ item }: { item: Extract<ChatItem, { kind: "permission" }> }) {
  const open = item.state === "open" && !item.closed;
  return (
    <div className={"bubble card" + (open ? " asking" : "")}>
      {/* Shown in full and wrapped, without hidden characters, so nothing in the request is out of sight. */}
      <div className="perm-title">{visibleText(item.title)}</div>
      <div className="perm-detail">{visibleText(item.detail)}</div>
      {open ? (
        <div className="perm-actions">
          <button type="button" className="btn primary" onClick={() => answer(item, "allowed")}>
            Allow once
          </button>
          {item.alwaysOffered && (
            <button
              type="button"
              className="btn"
              title={
                item.tool.startsWith("connector:")
                  ? `Sets ${connectorName(item.tool.slice("connector:".length))} to Allow for this agent`
                  : "Sets this tool to Allow for this agent"
              }
              onClick={() => answer(item, "always")}
            >
              Always allow
            </button>
          )}
          <button type="button" className="btn" onClick={() => answer(item, "denied")}>
            Deny
          </button>
        </div>
      ) : (
        <div className="muted small top6">{item.closed === "quit" ? "Closed when the app quit" : ANSWERS[item.state as keyof typeof ANSWERS]}</div>
      )}
    </div>
  );
}

function Composer({ agent }: { agent: Agent }) {
  const mode = useStore((s) => s.composerMode);
  const showShell = useLayout((l) => isOpen(l, "shell"));
  const text = useStore((s) => s.drafts[agent.id] ?? "");
  const setText = (value: string) => setDraft(agent.id, value);

  const busy = !agent.placeholder && (agent.status === "working" || agent.status === "waiting");
  const limited = agent.status === "limited";
  const send = () => {
    const body = text.trim();
    if (!body) return;
    // Emptied first: a message the agent refuses (at its daily limit, say) comes back into the box.
    setText("");
    if (agent.placeholder) sendToAgent(agent.id, body, mode === "task");
    else void sendToRealAgent(agent.id, body, mode === "task");
  };

  return (
    <>
      <div className="composer" data-hint={limited || undefined}>
        <textarea
          rows={2}
          aria-label={`Message ${agent.name}`}
          placeholder={mode === "task" ? `Give ${agent.name} a task ...` : `Message ${agent.name} ...`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <button type="button" className="square-btn" aria-label="Attach a file" onClick={() => notify("Attaching files comes in a later milestone.")}>
            <PlusIcon size={16} color="currentColor" width={2.2} />
          </button>
          <button
            type="button"
            className="square-btn"
            aria-label={`${showShell ? "Hide" : "Show"} ${agent.name}'s shell`}
            title={`${showShell ? "Hide" : "Show"} ${agent.name}'s shell (Ctrl+J)`}
            aria-pressed={showShell}
            onClick={toggleShell}
          >
            <TerminalIcon size={16} color="currentColor" />
          </button>
          <TasksButton agent={agent} />
          <span className="grow" />
          <Segmented
            label="Send as"
            value={mode}
            options={[
              { value: "chat", label: "Chat" },
              { value: "task", label: "Task" },
            ]}
            onChange={setComposerMode}
          />
          {busy && !text.trim() ? (
            <button type="button" className="square-btn send" aria-label={`Stop ${agent.name}`} title="Stop this turn" onClick={() => void cancelTurn(agent.id)}>
              <StopIcon />
            </button>
          ) : (
            <button type="button" className="square-btn send" aria-label="Send" disabled={!text.trim()} onClick={send}>
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      {limited && (
        <div className="composer-hint" role="status">
          {agent.name} reached today's limit.{" "}
          <button type="button" className="link-btn" onClick={() => showView({ kind: "agent-form", editingId: agent.id })}>
            Raise it in its settings.
          </button>
        </div>
      )}
    </>
  );
}
