import { useEffect, useLayoutEffect, useRef } from "react";
import { Avatar } from "../avatars/Avatar";
import { answerPermission, sendToAgent } from "../model/mock-agent";
import { answerRealPermission, cancelTurn, sendToRealAgent } from "../model/real-agent";
import { ViewMenuButton } from "../layout/ViewMenu";
import { isOpen, setChatOpen, setEditorOpen, toggleShell, useLayout } from "../model/layout";
import { agentById, hueOf, notify, setComposerMode, setDraft, showView, useStore } from "../model/store";
import type { ActivityEntry, Agent, ChatItem } from "../model/types";
import { agentColor } from "../theme/theme";
import { Segmented } from "./controls";
import { ChevronDown, CloseIcon, CodeIcon, PlusIcon, SendIcon, StopIcon, TerminalIcon } from "./icons";
import { agentSubline, avatarMode } from "./Sidebar";

const NO_ITEMS: ChatItem[] = [];

export function ChatPanel() {
  const editorOpen = useLayout((l) => isOpen(l, "editor"));
  const agent = useStore((s) => s.agents.find((a) => a.id === s.selectedId));
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
            {agent.name}, {agentSubline(agent)}
          </span>
          <ChevronDown size={11} color="currentColor" width={2.6} />
        </button>
        {tools}
      </div>

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
        <div key={e.id} className={"activity-row" + (e.refused ? " refused" : "")}>
          <span className="activity-dot" />
          <span className="activity-verb">{e.verb}</span>
          <span className="grow min0 ellipsis">{e.target}</span>
          <span className={e.live ? "pulse" : "muted"} style={e.live ? { color } : undefined}>
            {e.result}
          </span>
        </div>
      ))}
    </div>
  );
}

const ANSWERS = { allowed: "Allowed once", always: "Always allowed", denied: "Denied" } as const;

function answer(item: Extract<ChatItem, { kind: "permission" }>, value: keyof typeof ANSWERS) {
  if (agentById(item.agentId)?.placeholder === false) answerRealPermission(item.agentId, item.id, value);
  else answerPermission(item.agentId, item.id, value);
}

function PermissionRequest({ item }: { item: Extract<ChatItem, { kind: "permission" }> }) {
  const open = item.state === "open";
  return (
    <div className={"bubble card" + (open ? " asking" : "")}>
      <div className="perm-title">{item.title}</div>
      <div className="perm-detail">{item.detail}</div>
      {open ? (
        <div className="perm-actions">
          <button type="button" className="btn primary" onClick={() => answer(item, "allowed")}>
            Allow once
          </button>
          {item.alwaysOffered && (
            <button
              type="button"
              className="btn"
              title="Sets this tool to Allow for this agent"
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
        <div className="muted small top6">{ANSWERS[item.state as keyof typeof ANSWERS]}</div>
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
  const send = () => {
    const body = text.trim();
    if (!body) return;
    if (agent.placeholder) sendToAgent(agent.id, body, mode === "task");
    else void sendToRealAgent(agent.id, body, mode === "task");
    setText("");
  };

  return (
    <div className="composer">
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
  );
}
