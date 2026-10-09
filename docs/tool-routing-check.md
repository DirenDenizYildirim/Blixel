# Tool routing check

Can Blixel switch off each agent program's built-in file-editing and
command-running tools, and give it Blixel's own tools (an MCP server per
agent) instead? Checked from source and docs on 7 October 2026. None of the
recipes below has been run end to end yet.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Built-ins removable | Yes, per session | Yes, per adapter process | Yes, per session |
| Where it is set | ACP `session/new` `_meta` | Environment of the adapter process | OpenCode's own server API, not ACP |
| Project or user config can undo it | No | Not the shell; can add tools | Config can; the session rules cannot |
| Keeps the tool names the model knows | Yes (`toolAliases`) | No | No |
| Weakest point | Hooks in settings files | Removing apply_patch | Project plugins and custom tools |

All three need one process and one Blixel tool server per agent.

## Claude Code (claude-agent-acp 0.87.0, Agent SDK 0.3.287)

- Tools that write or run: `Edit`, `Write`, `NotebookEdit`, `Bash`,
  `PowerShell`, `Monitor`. Skills can run shell lines unless
  `disableSkillShellExecution` is set. `EnterWorktree` creates git worktrees.
- Recipe, in `session/new`:
  - `mcpServers`: Blixel's server, as http/sse or stdio **without** a `type`
    field (`type: "stdio"` is silently dropped).
  - `_meta.claudeCode.options`:
    - `tools`: an allowlist without the tools above;
    - `disallowedTools`: `["Bash","PowerShell","Monitor","Edit","Write","NotebookEdit"]`;
    - `toolAliases`: map `Bash`, `Edit`, `Write` to Blixel's tools, so the
      model keeps calling the names it was trained on;
    - `settingSources`: narrowed, `strictMcpConfig: true`,
      `allowDangerouslySkipPermissions: false`.
- A tool denied at any level cannot be re-enabled by another level, and
  subagents inherit both the denies and the MCP tools.
- Gap: hooks in user or project settings run shell commands outside Blixel.
  Either drop those settings sources (Claude Code then stops reading
  `CLAUDE.md` itself, so Blixel passes the instructions in) or keep them with
  hooks turned off (untested).
- Calls to Blixel's tools still go through the adapter's permission request
  unless pre-approved. Blixel enforces its rules inside its own server anyway.
- Do not use the adapter's `--hide-claude-auth`; hiding a sign-in method may
  conflict with Anthropic's hosting conditions.
- Native inputs to mirror:
  - `Bash`: `command`, `timeout?` (ms, at most 600000), `description?`,
    `run_in_background?`, `dangerouslyDisableSandbox?`
  - `Edit`: `file_path` (absolute), `old_string`, `new_string`, `replace_all?`
  - `Write`: `file_path` (absolute), `content`
  - `NotebookEdit`: `notebook_path`, `cell_id?`, `new_source`, `cell_type?`,
    `edit_mode?`

## Codex (codex-acp 2.1.1, bundling Codex rust-v0.160.1)

- Tools that write or run: `exec_command` and `write_stdin`, `apply_patch`,
  code mode (`exec`/`wait`, which can only call registered tools), plus MCP
  servers, plugins and apps from config, and `spawn_agent` children.
- codex-acp reads no per-session settings (`_meta` only for
  `additionalRoots`). Configure each adapter process through its environment:
  - `CODEX_CONFIG='{"features":{"shell_tool":false,"apps":false,"plugins":false}}'`
    removes the shell tools completely.
  - `apply_patch` has no switch. Either point `model_catalog_json` at a copy
    of the model catalog with `"apply_patch_tool_type": null` on every model
    (set when the app-server starts), or set `CODEX_EXEC_SERVER_URL=none`
    (removes all machine tools; side effects unverified).
  - Pass Blixel's server in ACP `mcpServers` under a unique name. A same-named
    server in any config layer wins unless `DISABLE_MCP_CONFIG_FILTERING=true`.
- User and project config cannot turn the shell back on; only admin files
  can. They can still add MCP servers, plugins and apps: switch those off, or
  give Codex its own `CODEX_HOME` (which also moves its login).
- codex-acp marks every session folder trusted, so a project's `.codex/`
  config and hooks load. Blixel's file tool must refuse writes to `.codex/`.
- Subagents copy the parent's config. They may use another model, so null
  `apply_patch` on every model, or set `features.multi_agent=false`.
- Tell the model about Blixel's tools in `developer_instructions`; its built-in
  instructions may still push it toward `apply_patch`.
- Native inputs to mirror:
  - `exec_command`: `cmd`, `workdir?`, `tty?`, `yield_time_ms?`,
    `max_output_tokens?`, `shell?`, `login?`
  - `write_stdin`: `session_id`, `chars?`, `yield_time_ms?`,
    `max_output_tokens?`
  - `apply_patch`: one string in Codex's patch grammar
    (`codex-rs/core/assets/tools/apply_patch.lark`): `*** Begin Patch`, then
    `*** Add File:`, `*** Delete File:` or `*** Update File:` hunks (optional
    `*** Move to:`, `@@` context, `+`/`-`/space lines), then `*** End Patch`.

## OpenCode (1.18.35, native ACP via `opencode acp`)

- Tools that write or run: `bash`, `edit`, `write`, `apply_patch`, plus
  `task` (subagents), experimental code mode, custom tools and plugins in
  `.opencode/`, and slash-command templates that run shell lines directly.
- Recipe, one `opencode acp --port N` per agent:
  - environment: `OPENCODE_SERVER_PASSWORD`,
    `OPENCODE_DISABLE_PROJECT_CONFIG=true`, and `OPENCODE_CONFIG_CONTENT` with
    `permission: {edit: "deny", bash: "deny"}`;
  - before the first prompt, `PATCH /session/{id}` with
    `permission: [{permission:"edit",pattern:"*",action:"deny"},{permission:"bash",pattern:"*",action:"deny"}]`.
    The ACP session id is OpenCode's session id.
- Only the session rules always win and carry into subagents. Config-level
  denies can be undone by project or agent config, and there is no flag to
  skip the global config.
- A `"*"` deny removes the tool from the model's list; a narrower pattern only
  refuses matching calls. `edit` covers edit, write and apply_patch. The old
  `tools` key is deprecated: use `permission`.
- `mcpServers` from ACP are registered, but errors are ignored, MCP state is
  per folder rather than per session, and tool calls carry no session id.
- Unverified: whether `OPENCODE_DISABLE_PROJECT_CONFIG` also blocks
  `.opencode/` custom tools and plugins, and whether session load or fork
  keeps the session rules.
- Native inputs to mirror:
  - `edit`: `filePath`, `oldString`, `newString`, `replaceAll?`
  - `write`: `filePath`, `content`
  - `bash`: `command`, `timeout?` (ms), `workdir?`
  - `apply_patch`: `patchText`
