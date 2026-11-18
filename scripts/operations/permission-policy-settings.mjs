/**
 * @file permission-policy-settings.mjs — render a Claude Code `--settings` JSON for one session kind (card 0j).
 *
 * Static `permissions.allow/ask/deny` rules cannot express the compound-command logic of `decide()`, so the
 * rendered file carries the literal-pattern subset: Bash allow patterns, Edit/Write allow paths, and the
 * always-ask / deny rules. The 0f launch module will pass it as `claude --settings <file>`; not wired in yet.
 *
 * CLI: node scripts/operations/permission-policy-settings.mjs --kind=<kind>
 */
import { pathToFileURL } from 'node:url';
import { KINDS, loadPolicy } from '../lib/permission-policy.mjs';

// Allow-rule path form for an edit regex source: only simple `@HOME@/<dir>/` prefixes translate to a glob.
function editGlobs(policy) {
  const out = [];
  for (const src of policy.allow.edit ?? []) {
    let m = /^\^@HOME@\\\/workspace\\\/tmp\\\/$/.exec(src);
    if (m) { out.push('~/workspace/tmp/**'); continue; }
    m = /^\^@HOME@\\\/workspace\\\/$/.exec(src);
    if (m) { out.push('~/workspace/**'); continue; }
    m = /^\^@HOME@\\\/\\\.plateau\\\/$/.exec(src);
    if (m) { out.push('~/.plateau/**'); continue; }
    m = /^\^@HOME@\\\/\\\.claude\\\/jobs\\\/$/.exec(src);
    if (m) { out.push('~/.claude/jobs/**'); continue; }
    m = /^\^@HOME@\\\/\\\.claude\\\/\(([^)]*)\)\\\/$/.exec(src);
    if (m) { for (const d of m[1].split('|')) out.push(`~/.claude/${d}/**`); continue; }
    if (src === '^\\/private\\/tmp\\/') { out.push('//private/tmp/**'); continue; }
    if (src === '^\\/tmp\\/') { out.push('//tmp/**'); continue; }
  }
  return [...new Set(out)];
}

/** @returns {object} a Claude Code settings object (JSON-serialisable) for `kind`. */
export function renderSettings(kind, { dir } = {}) {
  const policy = loadPolicy(kind, dir ? { dir } : undefined);
  const globs = editGlobs(policy);
  const allow = [
    ...policy.allow.bash.map((p) => `Bash(${p})`),
    ...globs.flatMap((g) => [`Edit(${g})`, `Write(${g})`]),
    'Read', 'Glob', 'Grep',
  ];
  return {
    permissions: {
      allow: [...new Set(allow)],
      ask: [...policy.settings.ask],
      deny: [...policy.settings.deny],
    },
  };
}

export function main(argv = process.argv.slice(2)) {
  const arg = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const kind = arg('kind');
  if (!kind || !KINDS.includes(kind)) {
    process.stderr.write(`usage: permission-policy-settings.mjs --kind=<${KINDS.join('|')}>\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(renderSettings(kind), null, 2)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
