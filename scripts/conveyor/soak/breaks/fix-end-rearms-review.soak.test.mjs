// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b from './fix-end-rearms-review.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
// origin/main before R618; keep the negative fixture stable after the fix merges.
const PRE_FIX_COMMIT = '163e9fe190bacdf6ebbcdc6786ddc9305e600aa6';
const CORE = 'scripts/conveyor/reconcile-core.mjs';
const SEND_BACKS = 'scripts/lib/operator-send-backs.mjs';

function withFixedSources(check) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-partial-'));
  try {
    for (const path of [CORE, SEND_BACKS]) {
      mkdirSync(resolve(sourceRoot, path, '..'), { recursive: true });
      writeFileSync(join(sourceRoot, path), readFileSync(join(ROOT, path), 'utf8'));
    }
    expect(b.fixPresent(sourceRoot)).toBe(true);
    check(sourceRoot);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
}

it.each([SEND_BACKS, CORE])('fixPresent refuses a root with %s reverted to pinned pre-fix origin/main', path => {
  withFixedSources(sourceRoot => {
    const original = execFileSync('git', ['show', `${PRE_FIX_COMMIT}:${path}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(sourceRoot, path), original);
    expect(b.fixPresent(sourceRoot)).toBe(false);
  });
});

it.each([
  ['post-fix review rearm', CORE, "reason: 'fix-pushed'"],
  ['release/review thread order', CORE, 'release.index > lastReview.index'],
  ['send-back/review thread order', CORE, 'item.index <= review.index'],
  ['one-shot consumption', CORE, 'operatorSendBackRearm(pr, { verdictId: pr.comments[item.index].id })'],
  ['conflict priority', CORE, "!withPhase.labels.includes(CONFLICT_LABEL) && String(pr?.mergeStateStatus ?? '').toUpperCase() !== 'DIRTY'"],
  ['strict release-head reader', CORE, 'const named = fixClaimReleaseHead(last.c.body)'],
  ['strict release sentence in core', CORE, String.raw`\.(?:[ \t]|\r?\n|$)/i.exec(body)`],
  ['strict release sentence in send-backs', SEND_BACKS, String.raw`\.(?:[ \t]|\r?\n|$)/i.exec(text)`],
  ['fix-end resolution', SEND_BACKS, 'head && (!item.head || differentHead(item.head, head))) return true;'],
])('fixPresent refuses an incomplete R618 delta without %s', (_name, path, marker) => {
  withFixedSources(sourceRoot => {
    const source = readFileSync(join(sourceRoot, path), 'utf8');
    expect(source).toContain(marker);
    writeFileSync(join(sourceRoot, path), source.replace(marker, '/* omitted safeguard */'));
    expect(b.fixPresent(sourceRoot)).toBe(false);
  });
});

it('pinned pre-fix main reproduces both the missing post-fix review and refused operator repair', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-main-'));
  try {
    // Archive to a file: the tree is ~74MB, over any sane execFileSync buffer (an ENOBUFS error would also OOM the worker).
    const tarball = join(sourceRoot, 'pre-fix.tar');
    execFileSync('git', ['archive', '-o', tarball, PRE_FIX_COMMIT, 'scripts', 'src/_data', 'schemas', 'package.json'], { cwd: ROOT });
    execFileSync('tar', ['-xf', tarball, '-C', sourceRoot]);
    symlinkSync(join(ROOT, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir');
    expect(b.fixPresent(sourceRoot)).toBe(false);
    // A child node process: importing the whole pre-fix tree through vite-node exhausts the worker heap.
    const script = `import(${JSON.stringify(new URL('./fix-end-rearms-review.mjs', import.meta.url).href)}).then(async m => {`
      + `const r = await m.default.run({ sourceRoot: ${JSON.stringify(sourceRoot)} });`
      + 'console.log(JSON.stringify(m.default.judge(r)));});';
    const out = execFileSync(process.execPath, ['--max-old-space-size=2048', '-e', script],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    expect(JSON.parse(out.trim().split('\n').at(-1))).toEqual([
      'trusted fix-end on a new head did not dispatch review',
      'newer operator send-back did not dispatch fix after the same-head advisory',
      'newer operator send-back was refused already-reviewed-head',
    ]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('missing source fails closed with a scenario violation', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-missing-'));
  try {
    expect(b.fixPresent(sourceRoot)).toBe(false);
    expect(b.judge(await b.run({ sourceRoot }))).toEqual([
      expect.stringContaining('scenario failed:'),
    ]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('incomplete reconcile source is not evidence of the fix', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-incomplete-'));
  try {
    mkdirSync(join(sourceRoot, 'scripts/conveyor'), { recursive: true });
    writeFileSync(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs'), 'function latestHeadReview() {}');
    expect(b.fixPresent(sourceRoot)).toBe(false);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});
