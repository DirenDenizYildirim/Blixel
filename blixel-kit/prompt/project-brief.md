# Project brief: Blixel

This brief describes what the product is, what has already been decided, and
what the reference material shows. It is background, not a task list. I will
tell you what to work on and in what order.

## The idea

A desktop workspace where one person and several AI agents work on a project
together, built so that you never have to leave the app to finish the job. It
starts as an IDE-like place for code, but the aim is any kind of work.

The agents are teammates, not a chat box. Each one has a name, an avatar and a
visible state. You can talk to it, hand it a task, or leave it idle. Agents
edit in the same editor you do, with their own cursors, and when allowed they
talk to each other and pass work between themselves.

## Priorities

- First release: the agent system and the shared editor.
- Most important after that: connectors and source control.
- A built-in browser is wanted, but later, and mainly for viewing.
- A task board, a review inbox and the other features below come after.

## Core concepts

**Agents.** An agent has a name, an avatar, a colour, a short role ("what it's
for"), instructions, a set of permissions, and a status: idle, working, or
waiting on you. A sidebar lists every agent with its status.

**How an agent runs.** There are three ways, chosen when the agent is created:
- Hosted agent: an existing agent program such as Claude Code or Codex, which
  the user signs in to with their own account.
- API key: any provider, billed per use.
- Self-hosted: a model on the user's own machine or server.

We do not build our own agent loop. The app hosts existing agent programs and
adds the workspace around them.

**What can be customised per agent.** Identity (name, avatar, colour, role,
typing speed) is ours and unlimited. Model, thinking effort, instructions,
tools and connectors come from the agent program, and not every program offers
every option, so the app should only show what the chosen agent reports.

**Chat and tasks.** Each agent has its own chat. A message is sent either as
chat or as a task. The chat shows the agent's replies, a log of what it did
(read, ran, edited), tasks it handed to other agents, and permission requests.

**Permissions.** Each tool or connector is set to Off, Ask or Allow per agent.
Ask means the agent stops and the user answers Allow once, Always allow or
Deny. In the designs the tools are: read files, edit files, run commands,
commit to its own branch, push and open pull requests, plus each connector.

**Agents working together.** Per agent: whether it can message other agents,
whether it takes tasks from other agents, and which agents it may give tasks
to. The app is the switchboard and enforces these rules.

**The shared editor.** The user and agents edit the same files at once. Each
agent has a named, coloured cursor. Agent edits are replayed as typing at a
slowed, adjustable speed (2 to 40 characters per second, default 12) so it
feels like working beside someone. Lines an agent added are marked as its own.
The file list shows which agents are in which file, and the user can follow an
agent's cursor.

**Shells.** The user has a shell, and each agent has its own, visible to the
user.

**Limits.** Per agent: typing speed, a daily spending limit, and what it does
when it has nothing to do (wait, or pick up queued tasks).

## Screens designed so far

**Main screen.** Three columns: a sidebar (search, new agent, the agent list,
files, tasks, terminal, theme), the selected agent's chat in the centre, and
an editor panel on the right with file tabs, the editor, the agent's shell,
and a small bar showing who is being followed, typing speed and cursor
position.

**Create-agent page.** Seven sections: identity, runs on, instructions, tools
and connectors, working with others, limits, and an optional first task. A
preview column shows the agent as it will appear in the sidebar, editor and
chat, with a plain summary of what it is allowed to do, what it asks about
first, and what is off.

## Planned features

Making several agents usable:
- Task board shared by the user and agents, with status that follows real
  progress.
- Review inbox: one place for everything waiting on the user.
- Source control with a branch and working copy per agent, so agents never
  overwrite each other; the user reviews a diff and merges.

Staying inside the app:
- Connectors to outside services (code hosting, issue trackers, chat, email,
  calendar), usable by agents as well as the user.
- Notes and docs that agents read as shared project memory.
- Search and a command palette across files, chats, tasks, agents and commands.
- Browser pane (later).

Managing agents:
- Group rooms with several agents and the user.
- Schedules, so an agent runs a task at set times.
- History with checkpoints the user can roll back to.
- Usage and cost per agent and per task.

Later: more than one person in a workspace, phone notifications, plugins.

## Avatars

Avatars are generated from the agent's name, so the same name always gives the
same creature and nothing is uploaded or stored. Colour also comes from the
name; each theme sets how light and how saturated avatar colours are.

There are four types for now:
- Blob: a soft wobbling body with eyes.
- Goo: a core with droplets that split off and merge back.
- Pixel blob and Pixel goo: the same two creatures drawn on a pixel grid.

A smooth type and its pixel twin are built from the same recipe, so one name
gives the same creature in both. The product name, Blixel, is blob plus pixel.

Motion shows the agent's state. Idle: slow, eyes nearly shut. Working: quick,
eyes darting. Waiting on you: it bounces, pulses a ring, and looks at the
pointer. Avatars must stay readable at 32 px (sidebar) and 20 px (chat), and
hold still when the user prefers reduced motion.

## Look

Calm and roomy with a terminal flavour, not a terminal and not a conventional
code editor. One monospace font (Fira Code) for everything, a soft slate
background, near-black panels, rounded cards with thin borders, and a single
accent colour. No title bar, breadcrumb strip or status bar.

Default theme, Slate: background #282c34, sidebar #111111, card #131519,
editor #1e2228, divider #2c3640, border #355a66, text #9cdef2, strong text
#c4eefb, muted #7fa3ae, accent #e06c75.

Five more themes exist: Paper (light), Forest, Midnight, Copper and Terminal.
Themes are sets of colour tokens only; layout and font never change.

## Technical decisions already made

- Desktop app on Tauri 2, with the core in Rust on Tokio.
- Interface in React and TypeScript with Vite, Zustand for state, and plain
  CSS variables for themes.
- Editor: CodeMirror 6, with Yjs for shared editing and cursors.
- Terminal: xterm.js in the interface, portable-pty in the core.
- Agents are hosted through the Agent Client Protocol (the
  `agent-client-protocol` crate), each as a child process.
- Agent-to-agent messaging is a small MCP server (the `rmcp` crate) that ships
  beside the app and is given to each agent session. It offers listing agents,
  sending a message and assigning a task.
- Connectors are MCP servers too.
- Storage in SQLite. Secrets in the operating system's keychain.
- The Rust core owns files and the queue of agent edits. Yjs is used only for
  files open in the editor.

## Constraints from the model providers

As of October 2026. These have changed several times, so check current terms.

- Anthropic does not allow other apps to offer Claude account login or to send
  requests through a user's Free, Pro or Max plan. Products use API keys.
  Hosting the unmodified Claude Code program, where each user signs in to it
  themselves, is allowed under conditions: the program is not modified, and
  the app does not pay for, resell or sit in the middle of the user's usage.
- OpenAI lets ChatGPT Plus and Pro subscribers use their plan in other apps
  through "Sign in with ChatGPT". It is open to open-source projects, apps
  that run locally and selected partners; commercial products join a waitlist.

So the app never collects, stores or forwards anyone's subscription
credentials, and never modifies an agent's program.

## Known pitfalls

- Several agent programs need Node on the user's machine. Tauri does not ship
  it, so the app must detect it or bundle it.
- Every agent supports MCP servers it launches itself, which is why the
  agent-to-agent server is a separate small program and not part of the main
  process.
- The interface runs in the system's web view, which differs between Windows,
  macOS and Linux. Linux is usually the weakest; the editor and terminal need
  testing there.
- Library APIs in this area change quickly. Check current documentation
  instead of relying on memory.

## Reference files in this kit

- `designs/screenshots/`: the approved screens, and the main screen in all six
  themes.
- `designs/preview-html/`: the same screens as plain web pages with inline
  styles, for exact sizes, spacing and colours.
- `designs/themes.json`: every colour token for the six themes.
- `avatar-lab/avatar-lab.html`: the working avatar generator and its script.

Agent names, the sample project and the code shown in the designs are
placeholder content.

## Still open

- The name. Blixel is the working name and may change, so keep it in one
  place in the code. No trademark search has been done.
- Whether the first audience is developers or anyone doing any kind of work.
- Which avatar type is the default, or whether the user picks per agent.
- How the task board, review inbox, connectors page and source control look.
  None of these has been designed yet.
