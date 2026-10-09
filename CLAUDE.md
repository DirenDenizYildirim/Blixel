# Blixel

A desktop workspace where one person and several AI agents work on a project
together. Milestone 1 is in progress: scripted placeholder agents play out
the design in an in-memory demo project, and real Claude Code agents (API key)
run on an opened folder through Blixel's own tools.

## Run and check

- `npm install`, then `npm run tauri dev` for the desktop app.
- `npm run dev` serves the interface alone in a browser (demo project only).
- `npm run build` type-checks and bundles; `cd src-tauri && cargo test` runs
  the Rust tests. `cargo test -- --ignored` also starts the real Claude adapter
  with a dummy key (network, about 250 MB on first run) and checks the fallback
  model ids against it.

## Code map

- `src/model/`: state (`store.ts`), types, path rules, the demo project and
  the scripted placeholder agents (`mock-agent.ts`). `protected-paths.json`
  is shared with the Rust core; its adapter test checks `fallback-models.json`.
- `src/editor/`: CodeMirror buffers shared by the user and agents, agent
  cursors and line marks, the typing replay, and conflicts between agent
  edits and unsaved changes (`sessions.ts`).
- `src/avatars/`: the avatar generator ported from the avatar lab.
- `src/components/`: the screens. `src/theme/`: theme tokens and the
  compiled-in fallback theme (the six themes are a built-in mod).
- `src/layout/`: the changeable layout (columns of views, zen, view menus);
  state in `src/model/layout.ts`, views registered in `views.ts`.
- `src/commands/`: every runnable command, the key dispatcher and the palette.
- `src/settings/`: the Settings page (appearance, layout, keys).
- `src/mods/`: mods. `types.ts` is the format, `registry.ts` loads built-in
  and installed mods, `runtime/` runs mod code sandboxed (its `frame/` files
  are served by the core), `builtin/` holds the built-in themes and layouts.
  Author docs: `docs/mods.md`, `docs/host-api.d.ts`; examples in
  `examples/mods/` (`test.escape` is the sandbox regression check).
- `src-tauri/src/workspace.rs`: file access for an opened folder, confined to
  that folder.
- `src-tauri/src/agents/`: real agents. `session.rs` runs the Claude adapter
  over ACP with its built-in edit and shell tools off; `tools.rs` is Blixel's
  MCP tool server (edit, write, bash) that enforces each agent's settings;
  `permissions.rs` holds questions for the user. `src/model/real-agent.ts` is
  the interface side.
- `src-tauri/src/secrets.rs`: API keys in the system keychain.
- `src-tauri/src/mods/`: installed mods, approvals and file hashes, mod
  storage, the `mod://` scheme with its per-mod content policy, and the
  navigation guard. `build.rs` lists every app command for the permission
  manifest; a new command must be added there and in `capabilities/`.

## Read first

- `blixel-kit/prompt/project-brief.md`: the idea, concepts, decided tech
  stack, provider constraints and known pitfalls. It is background, not a
  task list. The owner says what to work on and in what order.
- `blixel-kit/README.md`: what each file in the kit is.
- `docs/making-features-solid.txt`: research on how comparable tools fail,
  with acceptance criteria per feature. Its evidence IDs (S, G, R) point to a
  "feature gaps and user requests" document that is not in the repo.
- `docs/corrections-check.md`: its seven corrections and the brief's provider
  terms, checked against primary sources on 7 October 2026.
- `docs/tool-routing-check.md`: how to switch off each agent program's
  built-in edit and shell tools and route them through Blixel's own.

The brief and the research are inputs, not a final spec. Features are being
decided in discussion with the owner, and agreed decisions are recorded in
`docs/decisions.md`, which wins where they differ.

## Design references

- `blixel-kit/designs/screenshots/`: approved screens and the six themes.
- `blixel-kit/designs/preview-html/`: the same screens as static HTML, for
  exact sizes, spacing and colours.
- `blixel-kit/designs/themes.json`: colour tokens for every theme.
- `blixel-kit/avatar-lab/avatar-lab.html`: the working avatar generator; its
  script is the code to port.
- `blixel-kit/designs/canvas-source/`: backup only, do not edit.

## Rules

- Never commit or push. The owner reviews and commits every change.
- Build nothing that has not been agreed with the owner.
- Library APIs in this stack change quickly. Check current documentation
  instead of relying on memory.
- Blixel is a working name. Keep it in one place in the code.
