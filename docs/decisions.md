# Decisions

Feature and architecture decisions made with the owner. Newest last. Where
these differ from the brief or the research, these win.

## 1. Agent edits and commands go through Blixel (2026-10-07)

Each agent's built-in file-editing and command-running tools are switched off,
and it gets Blixel's own tools instead, one tool server per agent. Blixel sees
and controls every edit and command before it happens.

- Why: safer than watching from outside, and agents can share files live as
  in the main screen design.
- Not chosen: watching each agent's own working copy from outside.
- Limits: without a sandbox a command still runs with the user's rights, so
  rules about what a command may do are checked, not guaranteed.
- How, per program: `tool-routing-check.md`.

## 2. One shared folder by default (2026-10-07)

All agents work in the project folder itself. One agent gets a separate copy
only when the user asks for it.

- Why: a branch and checkout per agent wastes disk and setup time on large
  projects, and means many merges.
- Replaces the research's "one agent, one branch, one working copy". Review
  and rollback work per author inside the folder.
- Agents coordinate edits with file leases, enforced by Blixel's edit tool.

## 3. Path limits per agent (2026-10-07)

The user can limit where each agent may edit, such as "docs/ only".

- Set by the user only, like every permission.
- Built for review with these defaults, not yet confirmed:
  - limits cover edits only; reading is not limited;
  - patterns are written like `.gitignore`, `!` excludes, empty means the
    whole project;
  - an edit outside the area is refused with a reason, not turned into Ask.
- Changes to agent settings and instruction files (`.claude/`, `.codex/`,
  `.opencode/`, `CLAUDE.md`, `AGENTS.md`) always ask the user first.

## 4. Build toward an MVP in milestones (2026-10-07)

The remaining features are easier to judge by using them, so build in
usable steps:

1. One agent working through Blixel. Started with scripted placeholder agents
   for a design review; the real Claude Code agent (API key) follows.
2. Several agents in one folder: leases, path limits, cursors, following.
3. Agents working together: messages, hand-offs, a group room.

Left out at first: installer and first-run setup, Codex and OpenCode, review
and rollback, checkpoints, connectors, review inbox, Windows and macOS.

## 5. Fixes after the first code review (2026-10-09)

The owner asked for the review's fixes and for their open choices to be made
by Claude together with a second agent, then reported. Chosen:

- **Agent edits and unsaved changes.** An agent's edit is placed in the
  buffer line by line, beside the user's unsaved changes. Where it touches
  lines the user changed, the file goes into conflict and the user picks
  "Keep mine" or "Use the version on disk"; nothing is dropped silently.
  Not chosen: refusing agent edits while the user has unsaved changes, or a
  recovery tab.
- **Saving.** A save only goes through if the disk still holds the text the
  buffer is based on (checked in the core, under a lock shared with agent
  edits). A save first finishes the file's queued agent edits. After every
  command, and when the window regains focus, open files are compared with the
  disk. Not chosen: blocking saves while edits are queued; comparing hashes
  instead of whole texts.
- **Settings for a running agent.** Model and thinking effort change on the
  live session through ACP config options. Instructions, project notes and
  Read rebuild the session between turns with `session/resume`, which keeps
  the conversation (the next turn then pays full price, since the prompt
  cache is invalidated). Not chosen: restarting the process, or applying only
  after a restart.
- **Messages sent mid-turn.** Queued in the core and sent together when the
  turn ends; the bubble shows "queued". Stop, or the agent stopping, hands
  them back to the message box unsent. Not chosen: steering into the running
  turn (the adapter would move a running Blixel command to the background),
  or blocking sending.
- **Controls not yet enforced for real agents** (daily limit, when idle,
  working with others) stay visible but disabled, with a note. Not chosen:
  hiding them, or building the daily limit now.
- **Claude Code's built-in tools.** An allowlist (Read, Grep, Glob, web
  fetch and search, its task list, tool search) plus the deny list, and skill
  shell lines off. Subagents (Agent) are off for now: they can run in a git
  worktree, on another model or in the background. Blixel's tools are always
  loaded rather than hidden behind tool search. Reads outside the project
  always ask; web lookups always ask; "Always allow" is offered only where it
  sets a setting.
- **Models** are stored under the ids the program takes. The form shows what
  the running program reports; before that, a fallback list that the network
  test checks against the pinned adapter (which offers Haiku 4.5, not 5.5).
- **Protected paths** come from one list shared by the core and the
  interface, now also covering `.git/` (hooks run code) and `.mcp.json`.
- **Output limits.** A command's output is kept as its start and end for the
  model; the shell receives it in batches; each shell keeps its last 1 MB.

## 6. A changeable layout (2026-10-09)

Decided by Claude with a planning agent, at the owner's request.

- **Model:** the navigation sits at the left or right edge; the rest is a row
  of columns, each a stack of views (chat, editor, the agent's shell, and
  views from mods), each view at most once. The approved main screen is the
  default. Not chosen: a free docking tree with tabs (VS Code style), which
  fights the calm look and is harder to keep valid; fixed presets only.
- **Rearranging:** a small "⋯" menu in each view's existing head, the
  Layout part of Settings, and commands in a command palette (Ctrl+Shift+P).
  Drag and drop comes later. No new header strips (the look has none).
- **Zen:** one view alone over the unchanged layout. Ctrl+. toggles it,
  Ctrl+1 and Ctrl+2 switch between chat and editor. Esc does not leave zen
  (the editor and menus need it). Agents waiting on the user show as avatars
  in a small chip in the corner, never a bar.
- **Sidebar side** is a setting that moves only the navigation; "Mirror
  columns" is a separate command.
- **Persistence:** in the web view's storage, versioned, with a migration
  from the old layout and a repair step (chat or editor always shows; views
  of missing mods keep their place). The theme choice is remembered too.
- **Pages** (an agent's settings, the Mods page, Settings) still replace the
  columns and keep the navigation.

## 7. Mods (2026-10-09)

Decided by Claude with a planning agent and a research agent, at the
owner's request ("no modern tool survives without community").

- **Unit:** a folder with `mod.json` (id `author.name`, version, `api` major
  version, permissions, contributions). The format names no product, so a
  rename never breaks mods.
- **What a mod can add in v1:** themes, rule packs for agents, layout
  presets, commands with keys, and views. Later: a settings schema, file
  writes, network, messages to agents, editor languages, avatar styles,
  connectors (MCP servers, which run native code), a registry and signing.
- **Code runs sandboxed:** a mod's logic runs in a worker started inside a
  sandboxed iframe with an opaque origin, its views in sandboxed iframes, all
  served from a `mod://` scheme with a strict per-mod content policy (no
  inline script, and no network by design: the policy blocks requests, and
  the webview's DNS prefetching and preconnects, which a policy does not
  cover, are turned off). They talk to the app only through a message
  port. Research on Tauri 2.12 found frames on Linux can still reach the IPC
  handler; only a per-run key stops them, which frames never see, so app
  commands are also limited to the main window and frame navigation is
  restricted. Windows needs testing before mods ship there. Not chosen:
  WASM in the core (safer, but views still need a page), running mods like
  VS Code extensions with full access (breaks the security rule), inline
  `srcdoc` frames (they inherit the app's content policy).
- **Permissions:** declared, shown and approved when the user turns a mod
  on: in v1 only reading project files and seeing agents' names and status.
  A mod can never answer a permission request, change an agent's settings,
  see keys, type into the message box or send messages.
- **Trust:** mods live in the app's data folder; installing copies a folder.
  The core records a hash of a mod's files at approval, and a changed mod
  stays off until approved again (agents with Run could otherwise alter a
  mod). Dev mods load in place from the author's folder. No mods load from a
  project folder by themselves. Three failures in ten minutes turn a mod off;
  `--no-mods` and a safe-start offer after an unclean exit keep a broken mod
  from locking the user out.
- **Rule packs cannot widen what an agent may do:** a smaller edit area (the
  agent's own area and every pack's must allow an edit) and more paths that
  always ask, enforced by the app like the agent's own settings. Their
  instructions are text the model reads, given to it as third-party guidance
  below the user's instructions; they cannot change what the agent is
  allowed to do but can steer it within that, so the user reads a pack
  before attaching it. Their texts may not contain hidden or reordering
  characters. They apply only when the user attaches one to an agent, and
  their content is copied in, so a mod update never changes an agent's rules
  without review.
- **After a security review (2026-10-09):** each frame's address carries a
  one-time key its page must send back before the app reads its port, and
  only a frame's first page is connected. The logic's worker holds its port
  itself, so its page relays nothing. A mod's messages are read at most 200
  and 4 MB a second (answers included), before anything is decoded; more
  wait, and a long queue, a stray answer to a check or a view going to
  another page counts as a failure. Storage writes are gathered per key and
  written at most twice a second. The window tells the core it is alive every
  2 seconds, so a frozen window counts as an unclean exit. A mod may run only
  its own commands and those marked open to mods. Names are at most 40
  characters and never the app's; titles and labels at most 60; mod notices,
  commands and views always name the mod. In the core: the webview's
  preconnect and DNS prefetching are off and its own network goes through a
  proxy that refuses everything; app commands answer only the app's own page;
  served files are checked against their approved hashes on every request;
  rule-pack text is fenced and cleaned before it reaches the model; storage
  exists only for installed mods.
- **Checked live** on Linux (WebKitGTK 2.52) with a copy of `test.escape`:
  every escape from a mod's logic and view was blocked, nothing reached a
  local listener (beacon, image, prefetch, preconnect, navigation), and a
  mod page could not become the window's page. Windows and macOS are not
  checked; mods must not ship there before they are.
- **A smaller core:** the six themes and the layout presets are built-in
  mods in the same format. Nothing security-related is a mod, because turning
  a mod off must never widen anything. The demo project stays as it is.

## 8. Settings and the Mods page (2026-10-10)

At the owner's request ("a prettier mods screen, a settings menu for the
layouts, and the mods in the sidebar"); design by Claude.

- **Sidebar:** "Mods" takes the place of the Layout item; the gear in the
  corner opens **Settings** (Ctrl+,). Theme stays in the sidebar as a quick
  switch. The Layout pop-up menu is gone; its options live in Settings, the
  view menus and the palette.
- **Settings** is a full page like the agent form: Appearance (each theme
  drawn as a small mock of the window in its own colours), Layout (sidebar
  side and collapse, arrangements drawn as small diagrams, show or hide each
  panel, mirror and reset, zen mode), Keys (every shortcut, read only for
  now), About; beside them a live map of the current window. Not chosen: a
  pop-up settings menu (too small for the arrangement diagrams), separate
  pages per section.
- **Mods page:** two columns like the agent form. Each mod is a card with
  its picture (below), what it adds (theme swatches included), its
  permissions in plain words, an on/off switch, and its state; turning one
  on opens the approval inside its card. Filters (All, On, Off, Needs you)
  and a side column on what mods can and never can do. Not chosen: a plain
  list, a dialog for approval (it hides the mod being approved).
- **Mod pictures (at the owner's request):** each mod shows a 16 by 16
  pixel-art picture on a 72 px tile instead of a creature avatar (those stay
  for agents). A mod may draw its own in `mod.json` (`icon`: rows of
  characters and hex colours, validated); without one, the app draws one for
  what the mod adds (a panel, a key, a scroll, a palette, a window layout,
  or a building block) in a colour from its id. Not chosen: image files
  (they would have to be served for mods that are off), generated
  identicons (they say nothing about the mod).
