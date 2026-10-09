# Corrections check

The seven corrections in `making-features-solid.txt`, checked against primary
sources on 7 October 2026. These areas change monthly; recheck before relying
on a detail.

| # | Claim | Verdict |
|---|---|---|
| 1 | ACP v2 removes the file-system methods | Confirmed, and stronger |
| 2 | ACP v1 and v2 run side by side | Confirmed |
| 3 | MCP is stateless | Confirmed |
| 4 | Claude Code and Codex adapters lag | Mostly confirmed, two details wrong |
| 5 | Shared editor and per-agent copies conflict | Conflict stands; the Solo evidence is overstated |
| 6 | An agent's own report is not status | Confirmed |
| 7 | Rollback cannot be left to the agent | Confirmed |

## 1. Agent edits do not arrive through the host

- ACP v2 removes `fs/read_text_file`, `fs/write_text_file` and every
  `terminal/*` method. The decision is in an RFD, not the announcement:
  https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities
  (revised 2026-07-14). Its suggested replacement: "expose a special MCP
  server to the agent."
- In v1 these methods were opt-in, and agents mostly ignored them. The
  current Claude adapter never calls them for its own edits. So even under v1
  the host cannot see writes through ACP.
- Under v2 the host learns about edits only from the agent's own diff reports
  on tool calls, which miss shell commands.
- Because the terminal methods go too, the agent's shell view cannot come
  from ACP either.

## 2. ACP v1 and v2 side by side

- v2 draft published 2026-07-20, no stabilisation date. "Implementers should
  support both versions side by side", with v2 behind negotiation and feature
  flags, not on by default in production.
  https://agentclientprotocol.com/announcements/acp-v2-draft
- The four listed changes are all confirmed. Also removed in v2:
  `session/load`, session modes and the separate `tool_call` creation message.
  Latest draft schema: `schema-v2.0.0-alpha.7` (2026-09-30).
- Rust crate: `agent-client-protocol` 3.1.0 (2026-10-07). v1 is the default;
  v2 needs the `unstable_protocol_v2` feature. The SDK does not convert
  between versions, so v1 and v2 need separate handlers. No features are on
  by default; a host needs `process` and `stdio`. Major versions arrived in
  June, July and October 2026: pin it.
- Small date fixes for the features section: elicitation was published
  2026-07-24 (the updates page says 22 July). Session usage updates
  (stable 2026-06-05) carry an optional cumulative `cost`.
- Subagents: nothing stable, but a draft "Subagent Sessions" RFD (revised
  2026-10-05) adds an unstable `subagent_update`.
  https://agentclientprotocol.com/rfds/subagents

## 3. MCP is stateless

- The 2026-07-28 revision removes protocol-level sessions and the
  `initialize` handshake (replaced by `server/discover`), and deprecates
  Roots, Sampling and Logging for at least twelve months.
  https://modelcontextprotocol.io/specification/2026-07-28/changelog
- stdio is still a standard transport.
- Clients differ. Claude Code negotiates the new version by default (2.1.292).
  Codex has it only as an opt-in (since 0.147.0). OpenCode speaks only the old
  2025-11-25 version (1.18.35). Blixel's server must support both.
- `rmcp` 3.5.1 is the official Rust SDK, Tier 1, and serves both versions by
  default. It creates a fresh handler per request, so state lives in the app.
- Identity: `clientInfo` is self-reported and "SHOULD NOT" be used for
  security decisions. For stdio the spec says to take credentials from the
  environment.
  https://modelcontextprotocol.io/specification/2026-07-28/basic/index
- Caveat for Blixel: on Linux any process of the same user can read another
  process's environment (`/proc/<pid>/environ`). A per-agent token in the
  environment therefore does not stop one agent impersonating another. It
  needs a second check, such as which agent's process tree the connection
  comes from.

## 4. Adapters

- The ACP agents page lists Claude ("via Zed's SDK adapter") and Codex ("via
  ACP's adapter") as adapter-based. OpenCode is native (`opencode acp`), but
  /undo and /redo are unsupported over ACP. A Codex request for native ACP
  (openai/codex#30052) is open.
  https://agentclientprotocol.com/overview/agents
- claude-agent-acp: 76 open issues, not 68. #1196, #1181 and #1183 exist as
  described and are open. It is built on `@anthropic-ai/claude-agent-sdk` and
  needs Node 22 or later.
  https://github.com/agentclientprotocol/claude-agent-acp
- Zed's codex-acp was archived on 22 July 2026, but the move is done, not
  pending. Use `@agentclientprotocol/codex-acp` (2.1.1), built on the Codex
  App Server, which bundles a compatible Codex.
  https://github.com/agentclientprotocol/codex-acp

## 5. Shared editor and per-agent copies

- The conflict is a design point and stands on its own.
- The Solo evidence is overstated. https://soloterm.com/agents confirms
  "lease-based locks" and "shared key-value state", but never mentions a
  checkout and makes no claim to be the only tool doing this.

## 6. An agent's own report is not status

- Confirmed. https://news.ycombinator.com/item?id=47602986 (2026-04-01):
  "I've seen agents report "fixed!" when they just suppressed the error", and
  two other commenters say the same.

## 7. Rollback cannot be left to the agent

- Claude Code's checkpoints skip Bash changes, most subagent edits, other
  sessions and manual edits. Only the 100 most recent checkpoints keep file
  snapshots. https://code.claude.com/docs/en/checkpointing
- ACP has no rewind or restore method in v1 or v2. The open rewind proposal
  (PR #1321) leaves file-system rollback out of scope.

## Provider terms (from the brief, not a correction)

The brief's "Constraints from the model providers" section needs updating.

- Anthropic's legal and compliance page allows an end user to sign in "to
  the unmodified Claude Code binary with their own Claude subscription,
  including where a platform hosts Claude Code". The conditions the brief
  leaves out:
  - the host agrees to the Commercial Terms;
  - it removes, disables or restricts no sign-in method built into Claude Code;
  - it never collects, stores or passes on Claude.ai credentials or tokens,
    and sign-in completes through Anthropic's own flow.
  https://code.claude.com/docs/en/legal-and-compliance
- The Agent SDK page says: "Unless previously approved, Anthropic does not
  allow third party developers to offer claude.ai login or rate limits for
  their products, including agents built on the Claude Agent SDK."
  claude-agent-acp is built on that SDK. Whether the hosting exception covers
  the adapter is not stated anywhere: ask Anthropic before offering
  subscription login through it. JetBrains ships the adapter with API-key
  login only (the adapter's `--hide-claude-auth` flag).
  https://code.claude.com/docs/en/agent-sdk/overview
- OpenAI: plan usage through Sign in with ChatGPT is open to "open-source
  projects, personal projects that run locally, and selected private apps".
  "Paid or remotely hosted" apps join a waitlist. Blixel is MIT-licensed and
  runs locally, so it qualifies while it stays that way.
  https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
