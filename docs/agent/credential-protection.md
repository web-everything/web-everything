# Credential protection (R1082)

An agent reading credentials can copy them into tracked files and leak them through
commit/push. Four layers reduce that risk:

- User-level `permissions.deny` blocks Read/Edit/Write on protected paths.
- The separate PreToolUse hook denies matching Bash and file-tool requests from
  agents (`agent_id`, `agent_type`, or `WE_CONVEYOR_WORKER=1`); operator requests ask.
- Git hooks run gitleaks on staged content and each actual pushed range. New refs
  scan their reachable history, including older commits. Findings/scanner errors block.
- GitHub push protection provides a server-side backstop.

Configure `scripts/settings/credential-protection.json` (R528). Settings resolve
standard → platform `credentialProtection` → tool → environment (`WE_GITLEAKS_MODE`
only, and only to select `require`), reporting effective values and sources.
Scanner mode retains the strictest value across all layers (`off` < `auto` < `require`);
Bash decisions likewise retain `pass` < `ask` < `deny`. The standard `auto`/`deny`
floor cannot be weakened by platform, tool, or environment settings. Weaker
environment values are ignored with a notice. Invalid/unreadable settings restore
the strict defaults, including requiring gitleaks; repair settings to recover.
`auto` runs an installed gitleaks or prints **secret scan SKIPPED** with an install
hint and returns success when the scanner is missing: this is the intended operator
policy. Set `mode: "require"` for the strict option, which refuses missing scanners.
`off` visibly disables scanning with a one-line notice when selected in settings.
Both missing-scanner success in `auto` and disable in `off` are deliberate operator
settings, not modes a caller may silently toggle. The environment can only tighten
the resolved mode to `require`; it cannot select `auto` or `off`.

Custom `protectedPaths` always extend the built-in floor: `~/.ssh`, `~/.gnupg`,
`~/.aws`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.secrets`,
`~/.config/gh/hosts.yml`, and `.env*`. Platform and file lists are unioned with the built-in floor; later layers cannot remove earlier paths.
`.env*` matches the basename in any directory, including outside the repository.

Empty, malformed, unreadable, or oversized pre-push evidence refuses both `auto`
and `require`: coverage is unverifiable. Retry through Git with valid ref evidence;
for oversized input, the operator must inspect refs before retrying. Only `off`
skips this validation. No guessed Git range substitutes for actual push evidence.
Valid deletion-only evidence introduces no content and passes without scanning.
With valid content evidence, a missing scanner still prints **secret scan SKIPPED**
and exits successfully in `auto`; `require` refuses it.

Apply deliberately with `node scripts/bootstrap-session.mjs install`; preview with
`node scripts/bootstrap-session.mjs install --dry-run`, verify with `--check`, and
undo owned entries with `node scripts/bootstrap-session.mjs uninstall` (also supports
`--dry-run`). Settings and hooks merge without replacing foreign entries. An external
ownership manifest in `~/.plateau/hooks/` records additions; modified hook files
require operator review. Use a scratch `HOME` for tests, never the real HOME.

SSH commands permit protected paths only as plain `-i <key>` / `-F <config>`
operands; other protected-path references deny, including remote command text and
bare `ssh-add` key operands. `ProxyCommand`, `LocalCommand`, backticks, command/process
substitution, and unrecognized `-o` options deny. The safe `-o` names are
StrictHostKeyChecking, BatchMode, ConnectTimeout, UserKnownHostsFile, IdentityFile,
Port, and User; their values still undergo protected-path checks. Directory listings
(`ls`, including `-l`) pass. Redirects and all command/process substitution bodies remain checked independently
of the outer command, including nested backticks and substitutions inside listings.
Shell word escapes, locale `$"..."` quotes, adjacent quote fragments, and ANSI-C
`$'...'` escapes (hex, octal, Unicode, and control characters) normalize before matching; HOME,
repeated separators, dot segments and lexical parent segments resolve. Glob patterns
that can reach protected paths also deny. Git, gh, scp, rsync, and curl deny protected path arguments;
Git/gh commands without those arguments follow normal permission flow. Content
reads, copies, archives, transforms, interpreters referencing protected paths and input
redirections deny. The Bash matcher exempts exact `.env.example`, `.env.sample`,
`.env.template`; permission deny globs cannot express exceptions and cover these too.
This lexical guard is not OS isolation: computed paths, aliases, symlinks and programs
opening unnamed secrets remain outside its proof. Direct Git hook bypass remains
possible; combine these layers with restricted worker credentials and server protection.

Manually enable GitHub **Repo Settings > Code security > Secret protection > Push
protection**. For Enterprise, configure the corresponding organization-level secret
protection policy as well. Confirm availability and enforcement in the repository's
settings; this bootstrap does not change GitHub configuration.
