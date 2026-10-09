#!/usr/bin/env node
/**
 * @file red-green.mjs — #4075 daemon soak harness (card x0zg44l). The regression PROOF for one break: run its
 * scenario against this tree (expected GREEN), then against a throwaway copy of this tree with the fix
 * reverse-applied (expected RED).
 *
 *   node scripts/conveyor/soak/red-green.mjs --break=<id> [--revert=<sha>[,<sha2>...]] [--paths=a,b]
 *
 * `--revert` defaults to the break's own `fixedBy.sha`, `--paths` to its `fixedBy.paths` (all files of the
 * commit when unset). The copy is `git ls-files -co --exclude-standard` of this tree (uncommitted work included)
 * with `git diff <sha>^ <sha> -- <paths>` applied in REVERSE (`git apply -R --3way`), plus a `node_modules`
 * symlink; the scenario then runs FROM the copy, so the simulator's template (`sim/world.mjs`, which snapshots
 * the tree its own files live in) is the pre-fix code. Nothing outside the scratch dir is touched.
 *
 * `--revert` accepts a COMMA-SEPARATED list of shas, reverse-applied in order onto the same copy (#4075
 * gh-shim-mid-rebuild: one commit's own fix can be independently masked by another commit's fix on the same
 * file, so reverting either alone stays GREEN — only reverting both reproduces the live break). `fixedBy.sha` may
 * itself be a comma-separated list for exactly this case; a single sha behaves exactly as before this note.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { breakById } from './breaks/index.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

function flag(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** The part of the tree the simulator runs (`sim/world.mjs#buildWeTemplate` snapshots exactly these) — the copy
 *  and the reverse-applied fix are both narrowed to it. */
export const RUNTIME_PATHS = Object.freeze(['scripts', 'skills-src', 'package.json', 'package-lock.json', '.gitignore', 'src/_data', 'schemas/worker-result.v1.json']);

/** Copy this tree's runtime part (tracked + untracked-not-ignored) into a fresh temp dir, git-init'd so `git apply` works. */
export function copyTree(root = REPO_ROOT) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...RUNTIME_PATHS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  // #4075 soak harness gap: NOT realpath-resolving this left every red-green run silently a no-op on macOS (found
  // building gh-shim-mid-rebuild, reproduces on the ALREADY-FINISHED unsupported-repo-dirt break too — pre-existing,
  // not specific to any one break). `os.tmpdir()` resolves under `/var/...`, a symlink to `/private/var/...`;
  // `run.mjs`'s own `IS_CLI` self-check compares `resolve(process.argv[1])` (the literal, un-canonicalized argv
  // string this file passes below) against `resolve(fileURLToPath(import.meta.url))` (which Node's ESM loader
  // canonicalizes via realpath) — left unresolved, the two permanently disagree, `IS_CLI` reads false, and the
  // RED-side `node run.mjs break <id>` silently exits 0 with NO output at all (`main()` never runs). Exactly the
  // footgun `sim/world.mjs#createWorld` already guards against for the very same reason — see its own comment.
  const dest = realpathSync(mkdtempSync(join(tmpdir(), 'soak-red-')));
  for (const rel of files) {
    const src = join(root, rel);
    if (!existsSync(src)) continue;
    const dst = join(dest, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try { writeFileSync(dst, readFileSync(src)); } catch { /* a directory entry (submodule) — skip */ }
  }
  execFileSync('git', ['init', '-q'], { cwd: dest });
  execFileSync('git', ['-c', 'user.email=soak@example.com', '-c', 'user.name=soak', 'add', '-A'], { cwd: dest });
  execFileSync('git', ['-c', 'user.email=soak@example.com', '-c', 'user.name=soak', 'commit', '-q', '-m', 'soak red copy'], { cwd: dest });
  if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(dest, 'node_modules'), 'dir');
  return dest;
}

/** Reverse-apply EACH of `shas` (in order) onto `dest`, narrowed to `paths` — #4075 gh-shim-mid-rebuild found a
 *  break whose crash is masked unless TWO commits are both reverted (6ec566884's missing-throttle-CLI guard
 *  independently prevents the crash `11661ed52`'s own revert alone would otherwise reproduce). `--revert` takes
 *  a comma-separated list for exactly that case; a single sha behaves exactly as before. */
/** `--at-parent` mode: overwrite each path in `dest` with its content at `<sha>^` (first sha only). */
export function restoreAtParent(dest, shas, paths, root = REPO_ROOT) {
  if (!paths.length) throw new Error('red-green: --at-parent needs --paths (or the break\'s fixedBy.paths)');
  for (const rel of paths) {
    const content = execFileSync('git', ['show', `${shas[0]}^:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(dest, rel), content);
  }
  return paths.map((p) => `${p}@${shas[0]}^`);
}

export function revertAllInto(dest, shas, paths = [], root = REPO_ROOT) {
  const reverted = [];
  for (const sha of shas) reverted.push(...revertInto(dest, sha, paths, root));
  return reverted;
}

/** Reverse-apply one commit's diff (optionally narrowed to `paths`) onto `dest`. Throws when it does not apply. */
export function revertInto(dest, sha, paths = [], root = REPO_ROOT) {
  const patch = execFileSync('git', ['diff', `${sha}^`, sha, '--', ...(paths.length ? paths : RUNTIME_PATHS)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!patch.trim()) throw new Error(`red-green: ${sha} changes nothing under ${paths.join(', ') || '(all paths)'}`);
  const patchFile = join(dest, '.soak-revert.patch');
  writeFileSync(patchFile, patch);
  const r = spawnSync('git', ['apply', '-R', '--3way', patchFile], { cwd: dest, encoding: 'utf8' });
  rmSync(patchFile, { force: true });
  if (r.status !== 0) throw new Error(`red-green: reverse-applying ${sha} failed:\n${r.stderr}`);
  return patch.split('\n').filter((l) => l.startsWith('diff --git')).map((l) => l.split(' b/')[1]);
}

function runBreak(cwd, id) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(cwd, 'scripts/conveyor/soak/run.mjs'), 'break', id], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
}

async function main(argv) {
  const b = breakById(flag(argv, 'break'));
  const shas = flag(argv, 'revert', b.fixedBy.sha).split(',').map((s) => s.trim()).filter(Boolean);
  const paths = (flag(argv, 'paths', (b.fixedBy.paths ?? []).join(',')) || '').split(',').filter(Boolean);
  const keep = argv.includes('--keep');

  process.stdout.write(`=== ${b.id}: GREEN side — this tree (${REPO_ROOT}) ===\n`);
  const green = runBreak(REPO_ROOT, b.id);
  process.stdout.write(green.out);

  const dest = copyTree();
  let red;
  try {
    // `--at-parent`: for a fix too old to reverse-apply onto today's tree (its hunks' context was rewritten since),
    // restore each of `paths` WHOLESALE to its content at `<sha>^` instead. Coarser — it also drops every later
    // change to those files — so the RED run proves "the pre-fix version of this file breaks", not "only this hunk".
    const reverted = argv.includes('--at-parent') ? restoreAtParent(dest, shas, paths) : revertAllInto(dest, shas, paths);
    process.stdout.write(`\n=== ${b.id}: RED side — copy with ${shas.join(', ')} reverse-applied (${reverted.join(', ')}) ===\n`);
    red = runBreak(dest, b.id);
    process.stdout.write(red.out);
  } finally {
    if (!keep) rmSync(dest, { recursive: true, force: true });
  }
  const ok = green.code === 0 && red.code === 1;
  process.stdout.write(`\n${b.id}: GREEN side exit ${green.code} (${(green.ms / 1000).toFixed(1)}s), RED side exit ${red.code} (${(red.ms / 1000).toFixed(1)}s) — ${ok ? 'PROVEN: red before the fix, green with it' : 'NOT PROVEN'}\n`);
  return ok ? 0 : 1;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`red-green: fatal: ${e?.stack || e}\n`); process.exitCode = 2; });
}
