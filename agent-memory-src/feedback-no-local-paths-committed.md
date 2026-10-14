---
name: feedback-no-local-paths-committed
description: Never commit a host-local absolute path (a home dir like /Users/<name>/ or /home/<name>/); reference host resources by NAME and resolve them on the host through an env var
metadata:
  type: feedback
---

The operator ruled on 2026-10-13 ~12:00 ET: "no local path should be committed ever".

**Rule:** a tracked file never carries a host-local absolute path. Reference a host resource by NAME and resolve it
on the host only, through an env var set in the daemons' local launchd plists and the operator shell, never in the
repo. Example: a GitHub App key is committed as `key: {name: "plateau-reviewer"}` and resolved as
`$WE_GITHUB_APP_KEY_DIR/<name>.pem` (we:scripts/lib/github-app-identity.mjs). When you report an env line, write it
with `$HOME`, not a literal home dir.

**Why:** PR #5182 committed a literal key path into we:scripts/settings/delivery-identity.json. It leaked the
operator's home layout, only worked on one machine, and broke ~8 CI tests that read the real repo settings.

**How to apply:** use a name + host env var (or `$HOME`). In tests and fixtures use an obvious placeholder
(`/Users/x/`, `/home/user/`) or build the string. The gate is we:scripts/lint-host-paths.mjs (CI `test` job),
ratcheted by we:scripts/settings/host-path-baseline.json: a new file or a higher count fails, and the baseline may
only shrink.
