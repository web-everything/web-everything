# Agent CLI capability map — Claude Code, Codex, Antigravity

This is the Rosetta Stone for the three coding-agent CLIs in active use in this repo: the flags,
configuration surfaces, and observed behavior that correspond across them. **Snapshot: 2026-09-15**;
all four source reports were gathered in the same session. Every comparison cell traces to those real
self-reports, grounded in actual help output, local files, tool schemas, or live probes, with the
evidence limits below. This merge adds no capability claims from general knowledge.

**Confidence is uneven.** Codex and Antigravity were audited against local help/configuration and probes;
help, schema, or binary evidence is identified separately from successful execution. Claude Code's
report is first-hand **session knowledge, not a fresh CLI/config audit**. Its sandbox boundaries,
main-CLI model selection, session marker, and output format have explicit verification gaps. Whether
four Claude subagent/task lifecycle events can block is still **open**. An unverified capability is not
an absent capability; “no equivalent found” below records only the reports' negative finding for this
session, not a claim that the product cannot do it.

## Source reports

The scratch inputs were merged here and removed. These source labels retain their filenames, section
numbers, and evidence provenance without linking to deleted files:

- **C — `codex-self-report.md`:** §§1–6 cover hooks, sandbox, tool-scoping, config, models, output.
  Observed binary: `/opt/homebrew/Caskroom/codex/0.153.4/bin/codex`, reached via
  `/opt/homebrew/bin/codex`; `codex --version` returned **codex-cli 0.153.4**. Evidence includes
  `codex --help`, `codex exec --help`, `codex features list`, `codex sandbox --help`, parsed TOML,
  MCP config probes, binary strings, and schemas generated with
  `codex app-server generate-json-schema --out /private/tmp/codex-self-report-schema`.
  Nested execution probes failed during initialization; no successful model turn was observed.
- **A — `antigravity-self-report.md`:** §§1–6 cover hooks, sandbox, tool-scoping, config, models,
  output. Evidence includes `agy --help`, `agy models`, local settings/config inspection, binary
  strings from `/opt/homebrew/bin/agy`, and successful JSON/stream-json print runs. Hook details
  cite `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`; resource
  permissions cite `~/.gemini/antigravity-cli/builtin/skills/permissioned-github/SKILL.md`.
  A successful print probe does not independently prove every documented hook or sandbox behavior.
- **AR — `antigravity-resume-addendum.md`:** separate same-session confirmation of continuation
  flags and UUID recovery from per-run transcripts. It explicitly records no confirmed equivalent
  for Codex CLI or Claude's Agent/Task tool unless their own reports supply one; neither does.
- **CC — `claude-code-self-report.md`:** §§1–3 cover hooks, sandbox, tool-scoping; §4 models;
  §5 identity; §6 output. Config locations occur in §§1, 3, 4. Evidence is the live Claude
  session's own tool schemas, settings/hook usage, and lane-ownership experience in this repo.
  No fresh `--help` audit or upstream verification was performed.

[C]: #source-reports
[A]: #source-reports
[AR]: #source-reports
[CC]: #source-reports

<!-- provenance-lint: off — external CLI identifiers transcribed from the self-reports cited here; their implementations are not in this checkout -->

## Comparison

Category links lead to the fuller notes. Source labels refer to the reports above; section numbers in
the notes are those of the original reports.

| Capability category | Claude Code (`claude`) — session knowledge | Codex CLI (`codex`) — local audit | Antigravity CLI (`agy`) — local audit + resume addendum |
|---|---|---|---|
| [Hooks / lifecycle event interception](#hooks--lifecycle-event-interception) | `hooks` in `.claude/settings.json`, `.claude/settings.local.json`, or `~/.claude/settings.json`; `PreToolUse` can allow/deny/ask. `PostToolUse`, `Stop`, session and compaction events reported. Blocking by four subagent/task events remains **open**. [CC] | `hooks stable true`; `--enable hooks` / `--disable hooks`. Generated protocol has 12 events and four handler types. Declaration syntax, discovery, payloads, and actual interception **unverified**. [C] | `.agents/hooks.json`, `~/.gemini/config/hooks.json`, plugin hooks; five events. `PreToolUse` can allow/deny/ask/force_ask and rewrite arguments; invocation/stop hooks can affect continuation. [A] |
| [Sandbox / permission modes](#sandbox--permission-modes) | `default`, `acceptEdits`, `bypassPermissions`, `plan`; Bash exposes `dangerouslyDisableSandbox`. Exact filesystem/network boundaries **unprobed**. [CC] | `-s, --sandbox`: `read-only`, `workspace-write`, `danger-full-access`; root `-a, --ask-for-approval`: `on-request`, `never`; `--add-dir <DIR>`, `--approve-for-me`. Enforcement **unverified**. [C] | `--sandbox`; `run_command.BypassSandbox`. Report describes `request-review`, `always-proceed`, `strict`, `proceed-in-sandbox`; `--dangerously-skip-permissions` auto-approves. [A] |
| [Tool-scoping](#tool-scoping) | `permissions.allow` / `deny` / `ask` in settings; matchers such as `Bash(git push:*)`; `/permissions`. Agent/Task roles declare separate tool allowlists. [CC] | `mcp_servers.<name>.enabled_tools` / `disabled_tools` parse successfully; enforcement untested. `shell_tool` feature switch; execpolicy `.rules` support exposed by `--ignore-rules`, grammar/discovery unverified. [C] | `permission.allow` / `ask` / `deny` (singular); `command(npm test)`; resource permission strings and `PreToolUse` decisions. `--mode <accept-edits\|plan>`, `--disable-slash-commands`. [A] |
| [Config file locations](#config-file-locations) | `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`; `.claude/agents/*.md` frontmatter for agent models. No freshly audited precedence. [CC] | `~/.codex/config.toml` / `$CODEX_HOME/config.toml`; `-p <name>` layers `$CODEX_HOME/<name>.config.toml`; project `.codex/` supported by schema, no project config found. `-c key=value` overrides. [C] | `~/.gemini/antigravity-cli/settings.json`; suite files under `~/.gemini/config/`; workspace `.agents/` with three aliases; hierarchical `GEMINI.md` / `AGENTS.md`. [A] |
| [Model selection](#model-selection) | Agent/Task `model`: `sonnet`, `opus`, `haiku`, `fable`; `.claude/agents/*.md` can pin models. Main CLI `--model` and `/model` **not re-verified**. [CC] | `-m, --model <MODEL>`; `-c 'model_reasoning_effort="high"'`; `--oss`, `--local-provider` (`lmstudio`, `ollama`). Model names/efforts from local cache, not successful access tests. [C] | `--model <name>`, `--effort <low\|medium\|high>`; `/model <name>` or one-prompt override. `agy models` returned Gemini, Claude, and `gpt-oss-120b-medium` slugs. [A] |
| [Output / event-stream format](#output--event-stream-format) | **not found / could not verify this session**; no CLI output schema asserted. [CC] | `codex exec --json` advertises JSONL; `-o, --output-last-message <FILE>`, `--output-schema <FILE>`. Live probes produced only startup errors on stderr; event schema **unverified**. [C] | `-p, --print <prompt>`; `--output-format <text\|json\|stream-json>`. JSON result and NDJSON `init`, `step_update`, `result` observed; `--json-schema <schema-or-file>`. [A] |
| [Session identity](#session-identity) | Session-based lane ownership observed; `CLAUDE_CODE_SESSION_ID`-style marker mentioned, **exact name and nested propagation unverified**. [CC] | **Not established by the report**; `session_index.jsonl` / `sessions/` were found, but no session-ID field or retrieval primitive was verified. [C] | `conversation_id` UUID in JSON/stream output; hook metadata uses `conversationId`; transcript filename also carries UUID. [A] [AR] |
| [Resume / continuation of an interrupted run](#resume--continuation-of-an-interrupted-run) | no equivalent found | no equivalent found | `agy --continue` resumes most recent conversation; `agy --conversation <UUID>` resumes a specific run. Confirmed separately in-session. [AR] |

## Hooks / lifecycle event interception

**Claude Code.** Settings group command handlers by event, with a `matcher` and `hooks` array of
`{"type":"command","command":"..."}` entries. The report describes `PreToolUse` JSON decisions
using `permissionDecision` (`allow`, `deny`, `ask`) with a reason; this is not a complete payload recipe.
`PostToolUse` is observational and does not undo a call; `Stop` supports continuation checks;
`SessionStart`, `SessionEnd`, and `PreCompact` were used/known in-session. **Open question:**
`SubagentStart`, `SubagentStop`, `TaskCreated`, and `TaskCompleted` were observed, but whether they
can block/deny/ask or are observation-only remains unresolved. [CC] §1.

**Codex.** The generated `HookEventName` values are `preToolUse`, `permissionRequest`, `postToolUse`,
`preCompact`, `postCompact`, `sessionStart`, `sessionEnd`, `userPromptSubmit`, `subagentStart`,
`subagentStop`, `stop`, `interrupt`. Schema handler types are `command`, `mcpTool`, `prompt`, `agent`;
execution modes are `sync`, `async`. `--enable hooks` / `--disable hooks` correspond to
`-c features.hooks=true` / `false`. Help also exposes `--dangerously-bypass-hook-trust` (not exercised).
Binary strings mention `hooks.json` and `hooks/hooks.json`, but no declaration was found or executed:
neither those strings nor the schema establish a working hook recipe or blocking semantics. [C] §1.

**Antigravity.** Hook identifiers wrap event specifications in `hooks.json`; `enabled: false` disables
one identifier's handlers. `PreToolUse` / `PostToolUse` use grouped tool-name matchers; `PreInvocation`,
`PostInvocation`, `Stop` use flat handler lists. Only `command` handlers are supported, with a default
30-second timeout and the hook file's directory as cwd. JSON stdin/stdout uses camelCase.
`PreToolUse` returns `decision` (`allow`, `deny`, `ask`, `force_ask`), optional `permissionOverrides`,
and `overwrite` for a shallow argument merge; `PostToolUse` expects `{}`. Invocation hooks can return
`injectSteps`; `PostInvocation.terminationBehavior` accepts `force_continue`, `terminate`, or an empty
string. `Stop` can return `{"decision":"continue","reason":"..."}`. These details come from bundled
hook documentation and binary changelog evidence, not a hook-execution probe. [A] §1.

## Sandbox / permission modes

**Claude Code.** The session report describes `default` as normal per-action approval, `acceptEdits`
as automatic file-edit acceptance with other actions still gated, `bypassPermissions` as skipping
prompts, and `plan` as advisory without executing mutations. Bash's `dangerouslyDisableSandbox`
parameter is direct tool-schema evidence of a sandbox override. The report did not probe the sandbox's
technology, filesystem boundaries, or network restrictions; no launch-flag spelling was audited. [CC] §2.

**Codex.** Sandbox and approval are separate controls. Main and exec help expose `--sandbox`; only
main help lists `--ask-for-approval`, as in `codex -a never exec -s read-only 'Reply OK.'`.
`-C, --cd <DIR>` sets the working root; `--add-dir <DIR>` adds writable directories.
`--approve-for-me` uses automatic review with `workspace-write`;
`--dangerously-bypass-approvals-and-sandbox` skips both controls (not exercised). Generated policy
defaults network access to false for read-only/workspace-write. Local guidance documents
`sandbox_workspace_write.network_access=true` and says `never` does not enable networking.
`codex sandbox --help` describes Seatbelt here; actual enforcement was not established. A mistaken
`codex sandbox macos --help` probe was treated as a command and failed with `Operation not permitted`,
which proves no sandbox boundary or cause. [C] §2.

**Antigravity.** The report describes `--sandbox` as workspace-confined terminal execution, with
`.git` read-only and network blocked by default; `run_command` can request `BypassSandbox: true`
with elevated permission. `request-review` reviews writes/destructive actions; `always-proceed`
auto-approves; `strict` prompts; `proceed-in-sandbox` auto-approves commands inside the sandbox and
asks for bypass. These mode names are reported, not a verified mode-selection CLI syntax.
`init.permission_mode: "request-review"` was observed live. In print mode, actions requiring
unavailable interactive review are denied into `denied_actions` unless
`--dangerously-skip-permissions` is supplied. Boundary details also rely on binary/tool-schema
evidence; the cited print probe is not an independent confinement test. [A] §2.

## Tool-scoping

**Claude Code.** Settings use plural `permissions` with `allow`, `deny`, `ask` arrays; examples in the
report are `Bash(git push:*)`, `Edit`, `WebFetch(domain:example.com)`. `/permissions` inspects/edits
them. Agent/Task definitions separately scope tools by role: the observed `Explore` role excludes
mutating tools, while `general-purpose` has `*`. [CC] §3.

**Codex.** Non-persisting `-c` overrides for a dummy MCP server returned `enabled_tools: ["read"]`
and `disabled_tools: ["write"]` through `codex mcp get report_probe --json`. This proves parsing,
not filtering enforcement or overlap precedence; the server never started. The real
`codex mcp list --json` returned `[]`. `--disable shell_tool` is a feature switch, not a command
denylist. `codex exec --ignore-rules` establishes user/project execpolicy `.rules` support, but no
actual rule files, complete grammar, discovery paths, or enforcement were verified. [C] §3.

**Antigravity.** Settings use singular `permission`; rules include `command(npm test)` and
`command(git status)`. Allowlisting `write_to_file` / `replace_file_content` bypasses write review;
`read_url_content` otherwise asks first. The reported resource grammar is
`<command-binary>.<action>(<resource_json>)`, including
`gh.update({"org":"...","repo":"...","pr":"123"})` and git/workflow scopes.
`PreToolUse` provides additional decisions and temporary grants. The report also identifies internal
protection of sensitive config/system paths and a policy against executing downloaded files.
`--mode` accepts `accept-edits` or `plan`; `--disable-slash-commands` disables slash-command/skill
expansion in print execution. These scoping details cite bundled docs and binary inspection. [A] §3.

## Config file locations

**Claude Code.** Project `.claude/settings.json`, local `.claude/settings.local.json`, and user
`~/.claude/settings.json` hold the reported hooks/permissions. `.claude/agents/*.md` frontmatter can
pin an agent model. The report supplies these locations from session usage, without a fresh
precedence/discovery audit. [CC] §§1, 3, 4.

**Codex.** `/Users/nicolasgilbert/.codex/config.toml` was found and parsed; `CODEX_HOME` was unset.
Help identifies `~/.codex/config.toml` / `$CODEX_HOME/config.toml`. This version's
`-p, --profile <CONFIG_PROFILE_V2>` layers `$CODEX_HOME/<name>.config.toml` over that base;
the example `research.config.toml` was not present. Generated config-layer schema supports `.codex/`
folders between cwd and project root, but no `.codex/config.toml` was found in the inspected ancestry.
`-c, --config <key=value>` parses TOML values (literal-string fallback); `--strict-config` rejects
unknown fields; `--ignore-user-config` still uses `CODEX_HOME` for auth. The actual config contained
project trust entries and a TUI model-availability marker, no model/hook/MCP/sandbox defaults.
Managed layers appeared in schema only; precedence and trust gating were not exercised. [C] §4.

**Antigravity.** CLI settings live in `~/.gemini/antigravity-cli/settings.json` (including
`modelProvider`, `permission`, `agentMode`, `pickerGrouping`). Suite files are
`~/.gemini/config/config.json` (`userSettings`, `plugins`), `mcp_config.json` (`mcpServers`),
`hooks.json`, and `projects/<project-id>.json` (project resource metadata). Workspace discovery walks
up toward the Git root for `.agents/`, also recognizing `.agent/`, `_agents/`, `_agent/`.
Reported files include `hooks.json`, `skills.json`, `plugins.json`, `rules/*.md`, and
`plugins/<name>/plugin.json`. Skills/plugins configs use `entries` / `inherits` with include/exclude
rules. `GEMINI.md` and `AGENTS.md` merge hierarchically. Plugin `hooks.json` files also participate;
hook definitions are merged and run sequentially. [A] §§1, 4.

## Model selection

**Claude Code.** The directly visible Agent/Task `model` enum is `sonnet`, `opus`, `haiku`, `fable`;
that parameter overrides the agent definition's frontmatter model and configured subagent default.
The report mentions main-CLI `--model` and `/model` only as **not independently re-verified**;
they are not confirmed equivalents in this snapshot. [CC] §4.

**Codex.** `-m, --model <MODEL>` has no enumerated names in help. The local model cache (client
0.153.4, fetched `2026-09-15T11:25:05.777168Z`) advertises `gpt-6-astra`, `gpt-reserve`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `codex-auto-review`.
All advertise `low`, `medium`, `high`, `xhigh`; all except `gpt-5.5` add `max`; Astra, Sol,
and Terra also add `ultra`. Cached default is `medium` except Sol's `low`.
`model_reasoning_effort` was found in the binary and can be expressed with the verified `-c`
override syntax; effort validation and end-to-end model selection were not established.
`--oss` / `--local-provider` name `lmstudio` and `ollama`. No model-selection environment variable
was verified; the cache is advertised availability, not proof of successful API access. [C] §5.

**Antigravity.** `--model <name>` and `--effort <low|medium|high>` select model/effort.
Effort is a model-id suffix OR the flag, never both; Argon has only effort-suffixed ids.
`/model <name>` switches the conversation; `/model <name> <prompt>` is a one-prompt override that
reverts afterward. `agy models` returned `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`,
`gemini-3.8-flash-low`, `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low`,
`gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-low`, `gemini-4-argon-high`,
`gemini-4-argon-medium`, `gemini-4-argon-low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.
`GEMINI_API_KEY` with `modelProvider: "gemini"` selects direct Gemini API access;
`GOOGLE_GEMINI_BASE_URL` overrides that endpoint. Listing a model does not establish a successful
turn for every listed model. [A] §5.

## Output / event-stream format

**Claude Code.** **Not found / could not verify this session.** The report explicitly declines to
assert a CLI output format or event schema without a fresh probe. [CC] §6.

**Codex.** Exec help advertises `--json` as JSONL on stdout; `-o, --output-last-message <FILE>`
writes the final agent message; `--output-schema <FILE>` shapes the final response separately from
events. `--ephemeral` avoids persisting session files. A missing prompt or `-` reads stdin;
piped stdin alongside a prompt is appended as a `<stdin>` block. Both plain and `--json` probes
using `--ephemeral --ignore-user-config -s read-only` exited **1** with empty stdout and plain
stderr, ending `failed to initialize in-process app-server client: Operation not permitted (os error 1)`.
No successful output, event ordering/schema, token stream, or tool-result payload was captured.
Generated app-server schemas are not evidence for the exec JSONL format. [C] §6.

**Antigravity.** Default is interactive; `-i, --prompt-interactive <prompt>` keeps the session open.
`-p, --print <prompt>` (alias `--prompt`) runs headlessly. `--output-format` accepts `text`, `json`,
`stream-json`; `--input-format <text|stream-json>` requires stream-json output.
`--json-schema <schema-or-file>` shapes the final response. Live JSON output contained
`conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, and token `usage`;
`denied_actions` is reported when review-dependent actions are refused. Observed NDJSON events use
an `event` discriminator: `init` contains cwd/tools/permission mode; `step_update` carries
`step_index`, `state`, `step_type`, and streaming `text_delta`; `result` wraps the final result.
`--print-timeout <duration>` defaults to `5m0s`; the report describes mid-turn timeout flushing
partial output with exit **0** and a stderr warning. The successful probes were
`agy -p "Say 'hello world'" --output-format json` and
`agy -p "Say 'hi'" --output-format stream-json`. [A] §6.

## Session identity

**Claude Code.** Identity-based lane ownership was observed through the repo's holder/occupant
session fields. The source calls the marker `CLAUDE_CODE_SESSION_ID`-style, explicitly leaving its
exact environment-variable spelling and propagation to nested subagents unverified. Do not treat
that spelling as an audited integration contract. [CC] §5.

**Codex.** The filesystem audit found `~/.codex/session_index.jsonl`, `history.jsonl`, and
`sessions/`, among other state files. It did not establish a session-ID field, lookup command,
environment marker, or propagation behavior. Those files' existence is not a verified identity
interface; the report has no dedicated identity section. [C] §§4, 6.

**Antigravity.** JSON results and streaming events expose a conversation UUID as `conversation_id`;
`step_update` and `result` examples carry it inside their nested objects. Hook input uses
`conversationId`. The addendum confirms the UUID in filenames of this session's judge transcripts,
`~/.antigravity-judge-transcripts/antigravity-judge-<UUID>.jsonl`, and in transcript lines. This is an
observed per-run log location, not a claim about the CLI's universal storage directory. [A] §§1, 6; [AR].

## Resume / continuation of an interrupted run

**Claude Code: no equivalent found. Codex CLI: no equivalent found.** This is the addendum's
same-session finding, not proof of product-wide absence: it compares Claude's Agent/Task tool and
Codex CLI, and neither main report supplies a confirmed resume primitive. No unreported CLI flags
are filled in from memory. [AR]; [CC]; [C].

**Antigravity.** The separately confirmed commands are `agy --continue` for the most recent
conversation and `agy --conversation <UUID>` for a specific stalled, timed-out, or interrupted run.
Recover the UUID from that run's transcript filename or `conversation_id` field as described above.
This resumes the recorded conversation instead of starting the task from scratch. [AR].

<!-- provenance-lint: on -->
