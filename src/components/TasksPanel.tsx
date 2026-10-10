import { useRef, useState } from "react";
import { MoreIcon } from "../layout/icons";
import { PopupMenu, type MenuItem } from "../layout/Menu";
import { ViewMenuButton } from "../layout/ViewMenu";
import { closeView, openView } from "../model/layout";
import { useStore } from "../model/store";
import { createTask, editTask, giveTask, removeTask, setTaskStatus, useOpenTaskCount, useTasksOpen } from "../model/tasks";
import type { Agent, Task, TaskStatus } from "../model/types";
import { ChevronDown, ChevronRight, CloseIcon, PlusIcon, TasksIcon } from "./icons";
import "./tasks.css";

const STATUS_LABEL: Record<TaskStatus, string> = { todo: "to do", doing: "doing", check: "check", done: "done" };
const ORDER: Record<TaskStatus, number> = { check: 0, doing: 1, todo: 2, done: 3 };

const FLAG_TEXT: Record<NonNullable<Task["flag"]>, string> = {
  stopped: "Stopped before it finished.",
  "agent-removed": "Its agent was removed.",
  quit: "The app quit while it ran.",
};

const byStatus = (a: Task, b: Task) => ORDER[a.status] - ORDER[b.status] || a.created - b.created;

/** The selected agent's tasks, then the ones for anyone. A view like the shell, under the chat. */
export function TasksPanel() {
  const agents = useStore((s) => s.agents);
  const agent = useStore((s) => s.agents.find((a) => a.id === s.selectedId));
  const tasks = useStore((s) => s.tasks);
  const [adding, setAdding] = useState(false);

  const byId = new Map(agents.map((a) => [a.id, a]));
  const mine = agent ? tasks.filter((t) => t.agentId === agent.id) : [];
  // A task whose agent is gone is for anyone, as removing an agent leaves it.
  const anyone = tasks.filter((t) => t.agentId === null || !byId.has(t.agentId));
  const open = mine.filter((t) => t.status !== "done").length;

  return (
    <section aria-label={agent ? `${agent.name}'s tasks` : "Tasks"} className="shell-card tasks-card">
      <div className="shell-head">
        <TasksIcon size={14} />
        <span className="who-name ellipsis">{agent ? `${agent.name}'s tasks` : "Tasks"}</span>
        {agent && <span className="tasks-count head-count">{open ? `${open} open` : "none open"}</span>}
        <span className="grow" />
        <span className="head-tools">
          <button
            type="button"
            className="icon-btn small muted"
            aria-label="New task"
            title="New task, for anyone"
            onClick={() => setAdding(true)}
          >
            <PlusIcon size={13} color="currentColor" />
          </button>
          <ViewMenuButton view="tasks" />
          <button type="button" className="icon-btn small muted" aria-label="Hide tasks" title="Hide tasks" onClick={() => closeView("tasks")}>
            <CloseIcon size={10} />
          </button>
        </span>
      </div>

      <div className="tasks-body">
        {agent && (
          <TaskGroup
            tasks={mine}
            agent={agent}
            agents={byId}
            empty={`Nothing for ${agent.name} yet. A message sent as a Task lands here.`}
          />
        )}
        <div className="tasks-group-head">
          <span>Unassigned</span>
          {anyone.length > 0 && <span className="tasks-count">{anyone.filter((t) => t.status !== "done").length}</span>}
        </div>
        {adding && <AddTask onDone={() => setAdding(false)} />}
        <TaskGroup
          tasks={anyone}
          agent={agent}
          agents={byId}
          unassigned
          empty={adding ? null : "Nothing here. + adds a task for anyone."}
        />
      </div>
    </section>
  );
}

function TaskGroup(props: {
  tasks: Task[];
  agent: Agent | undefined;
  agents: Map<string, Agent>;
  unassigned?: boolean;
  empty: string | null;
}) {
  const [showDone, setShowDone] = useState(false);
  const open = props.tasks.filter((t) => t.status !== "done").sort(byStatus);
  const done = props.tasks.filter((t) => t.status === "done").sort((a, b) => b.updated - a.updated);
  return (
    <div className="tasks-group">
      {open.length === 0 && done.length === 0 && props.empty && <div className="tasks-empty">{props.empty}</div>}
      {open.map((t) => (
        <TaskRow key={t.id} task={t} agent={props.agent} agents={props.agents} unassigned={props.unassigned} />
      ))}
      {done.length > 0 && (
        <button type="button" className="tasks-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
          {showDone ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <span>Done</span>
          <span className="tasks-count">{done.length}</span>
        </button>
      )}
      {showDone && done.map((t) => <TaskRow key={t.id} task={t} agent={props.agent} agents={props.agents} unassigned={props.unassigned} />)}
    </div>
  );
}

/** The inline add: a title, Enter to add, Escape to leave it. */
function AddTask({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const add = async () => {
    if (await createTask({ title, agentId: null })) setTitle("");
  };
  return (
    <div className="task-add">
      <input
        autoFocus
        className="task-input"
        aria-label="New task"
        placeholder="A task for anyone, Enter to add"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
        onBlur={() => {
          if (!title.trim()) onDone();
        }}
      />
    </div>
  );
}

function TaskRow(props: { task: Task; agent: Agent | undefined; agents: Map<string, Agent>; unassigned?: boolean }) {
  const { task, agent, agents, unassigned } = props;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const owner = task.agentId ? agents.get(task.agentId) : undefined;
  const from = task.createdBy === "user" ? null : (agents.get(task.createdBy.slice("agent:".length))?.name ?? "another agent");

  if (editing) return <EditTask task={task} onDone={() => setEditing(false)} />;

  return (
    <div className="task" data-status={task.status}>
      <div className="task-line">
        <span className="task-chip" data-status={task.status}>
          {task.status === "doing" && <i />}
          {STATUS_LABEL[task.status]}
        </span>
        <button
          type="button"
          className="task-title"
          title={task.title}
          aria-expanded={task.notes ? expanded : undefined}
          onClick={() => setExpanded(!expanded)}
        >
          {task.title}
        </button>
        {unassigned && agent && task.status !== "done" && (
          <button
            type="button"
            className="link-btn task-give"
            title={`Send it to ${agent.name} as a task`}
            onClick={() => void giveTask(task.id, agent.id)}
          >
            Give<span className="task-give-to"> to {agent.name}</span>
          </button>
        )}
        <TaskMenu task={task} owner={owner} onEdit={() => setEditing(true)} />
      </div>
      {task.status === "check" && (
        <div className="task-sub task-check">
          <span>{owner ? `${owner.name} says done:` : "Said done:"}</span>
          <span className="task-check-answers">
            <button type="button" className="btn tiny primary" onClick={() => setTaskStatus(task.id, "done")}>
              Done
            </button>
            <button type="button" className="btn tiny" onClick={() => setTaskStatus(task.id, "todo")}>
              Not yet
            </button>
          </span>
        </div>
      )}
      {task.flag && <div className="task-sub task-flag">{FLAG_TEXT[task.flag]}</div>}
      {from && expanded && <div className="task-sub">From {from}</div>}
      {expanded && task.notes && <div className="task-sub task-notes">{task.notes}</div>}
    </div>
  );
}

function TaskMenu({ task, owner, onEdit }: { task: Task; owner: Agent | undefined; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const items: MenuItem[] = [];
  if (task.status === "check") {
    items.push({ label: "Mark done", run: () => setTaskStatus(task.id, "done") });
    items.push({ label: "Not yet", run: () => setTaskStatus(task.id, "todo") });
  } else if (task.status === "done") {
    items.push({ label: "Open again", run: () => setTaskStatus(task.id, "todo") });
  } else {
    items.push({ label: "Mark done", run: () => setTaskStatus(task.id, "done") });
    if (owner && task.status === "todo") {
      items.push({ label: task.sentItemId ? `Send to ${owner.name} again` : `Send to ${owner.name}`, run: () => void giveTask(task.id, owner.id) });
    }
  }
  items.push({ label: "Edit…", run: onEdit }, "separator", { label: "Remove", run: () => removeTask(task.id) });
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn small muted task-more"
        aria-label={`Options for ${task.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon />
      </button>
      {open && <PopupMenu anchor={button.current} label="Task options" items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

function EditTask({ task, onDone }: { task: Task; onDone: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const save = () => {
    editTask(task.id, { title, notes: notes.trim() });
    onDone();
  };
  return (
    <div
      className="task task-edit"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <input
        autoFocus
        className="task-input"
        aria-label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <textarea className="task-input area" aria-label="Notes" placeholder="Notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="task-edit-actions">
        <button type="button" className="btn tiny" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn tiny primary" disabled={!title.trim()} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

/** The message box's tasks button: the agent's open tasks, and the Tasks view on and off. */
export function TasksButton({ agent }: { agent: Agent }) {
  const shown = useTasksOpen();
  const count = useOpenTaskCount(agent.id);
  const label = `${shown ? "Hide" : "Show"} ${agent.name}'s tasks`;
  return (
    <button
      type="button"
      className="square-btn tasks-btn"
      aria-label={count ? `${label}, ${count} open` : label}
      title={label}
      aria-pressed={shown}
      onClick={() => (shown ? closeView("tasks") : openView("tasks"))}
    >
      <TasksIcon size={16} color="currentColor" />
      {count > 0 && <span className="tasks-badge">{count}</span>}
    </button>
  );
}
