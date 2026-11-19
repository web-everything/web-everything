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
only, and only to select `require`), reporting effective values and sources. Weaker
environment values are ignored with a notice. Invalid/unreadable settings restore
the strict defaults, including requiring gitleaks; repair settings to recover.
`auto` runs an installed gitleaks or prints **secret scan SKIPPED** with an install
hint and returns success when the scanner is missing: this is the intended operator
policy. Set `mode: "require"` for the strict option, which refuses missing scanners.
`off` visibly disables scanning when selected in the settings file.

Custom `protectedPaths` always extend the built-in floor: `~/.ssh`, `~/.gnupg`,
`~/.aws`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.secrets`,
`~/.config/gh/hosts.yml`, and `.env*`. They cannot remove these protections.
`.env*` matches the basename in any directory, including outside the repository.

When pre-push evidence yields no ranges (including deletion-only input), `require`
refuses the push and asks for ref evidence. `auto` prints a notice and scans
`HEAD~1..HEAD`, or `HEAD` for a single commit. That fallback does not verify all
pushed history. Malformed evidence still refuses the operation.

Apply deliberately with `node scripts/bootstrap-session.mjs install`; preview with
`node scripts/bootstrap-session.mjs install --dry-run`, verify with `--check`, and
undo owned entries with `node scripts/bootstrap-session.mjs uninstall` (also supports
`--dry-run`). Settings and hooks merge without replacing foreign entries. An external
ownership manifest in `~/.plateau/hooks/` records additions; modified hook files
require operator review. Use a scratch `HOME` for tests, never the real HOME.

Only `ssh` (including `ssh -i` and remote command text), `ssh-add`, and directory
listings (`ls`, including `-l`) bypass argument checks. Redirects and nested local
commands remain checked. Git, gh, scp, rsync, and curl deny protected path arguments;
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
