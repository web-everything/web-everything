/**
 * @file scripts/lib/__tests__/nnn-collision-heal.wiring.test.mjs
 * @description #2746 review — proves the #2546 content guard is WIRED INTO `planBaseCollisionHeal`, not merely
 *   importable beside it. The original tests called `assertContentPreserved` directly, so deleting both guard
 *   calls from the module would not have failed a single test — the PR's actual behavioural change was
 *   untested. Here `rewriteRefs` is mocked at the module boundary (the sanctioned seam — no test-only option
 *   on the production signature) to return blanked content, and the planner must THROW. Delete the guard call
 *   in `planBaseCollisionHeal` and this test goes red.
 */

import { describe, it, test, expect, mock } from 'bun:test';
const __actual0 = { ...(await import('../../../../scripts/backlog/renumber-collisions.mjs')) };
mock.module('../../../../scripts/backlog/renumber-collisions.mjs', () => {
  const actual = __actual0;
  return {
    ...actual,
    // a "broken rewrite" — exactly the #558 blank-on-rewrite failure the guard exists to catch
    rewriteRefs: (text, oldNum, newNum, slug) => {
      const real = actual.rewriteRefs(text, oldNum, newNum, slug);
      return real !== text ? '' : text;   // blanked ONLY when the sweep actually rewrote something
    },
  };
});

const { planBaseCollisionHeal, healNnnCollision, applyCollisionHealToIndex } = await import('../../../../scripts/lib/nnn-collision-heal.mjs');

const mk = (num, slug, body = '') => ({
  name: `${num}-${slug}.md`,
  text: `---\nkind: story\nstatus: open\n---\n\n# ${slug}\n\n${body}\n`,
});

describe('planBaseCollisionHeal — the #2546 guard is wired in (not just imported)', () => {
  it('THROWS when the rewrite blanks a referencing file', () => {
    const laneFiles = [
      mk('2219', 'drain-finding', 'the storm-collision finding'),
      { name: '1800-refs.md', text: '---\nkind: story\n---\n\n# refs\n\nAuthored body.\nSee #2219.\n' },
    ];
    expect(() => planBaseCollisionHeal(laneFiles, {
      baseNums: ['2218', '2219', '2221'],
      baseNames: ['2218-x.md', '2219-existing-item.md', '2221-z.md'],
    })).toThrow();
  });
});

// A scripted `run` that returns canned results per git subcommand (mirrors the harness in the sibling suite).
function scriptedRun(script) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, input: opts?.input });
    const handler = script[args[0]];
    const res = typeof handler === 'function' ? handler(args, opts) : handler;
    return { status: 0, stdout: '', stderr: '', ...(res || {}) };
  };
  return { run, calls };
}

const BASE_LS = 'backlog/2218-a.md\nbacklog/2219-existing.md\nbacklog/2221-c.md\n';
const LANE_LS = 'backlog/2219-drain-finding.md\nbacklog/1800-refs.md\n';
const BODY = {
  '2219-drain-finding.md': mk('2219', 'drain-finding', 'the storm-collision finding').text,
  '1800-refs.md': '---\nkind: story\n---\n\n# refs\n\nAuthored body.\nSee #2219.\n',
};
const catFile = (args) => ({ status: 0, stdout: BODY[args[2].split('backlog/')[1]] });

// #2746 review — the guard THROWS, but both callers are merge-boundary helpers contractually required to
// signal failure by RETURN value: an escaping throw kills the whole drain pass (no enclosing try around the
// per-PR loop in merge-ai-prs.mjs) and skips the write-tree/commit-tree that rebase-drop-manifest.mjs
// documents as "a heal FAILURE is non-fatal … it never aborts the whole rebuild".
describe('the #2546 guard degrades to an error RETURN at the merge boundary (never a throw)', () => {
  it('healNnnCollision returns { action: "error" } instead of throwing, and writes nothing', () => {
    const { run, calls } = scriptedRun({
      fetch: { status: 0 },
      'ls-tree': (args) => ({ status: 0, stdout: args.includes('origin/main') ? BASE_LS : LANE_LS }),
      'cat-file': catFile,
      'read-tree': { status: 0 },
    });
    let r;
    expect(() => { r = healNnnCollision({ laneRef: 'lane/x-2222', run }); }).not.toThrow();
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/collision-heal plan refused/);
    expect(r.reason).toMatch(/#2546/);
    // the rebuild never started — no tree written, no commit, no push (a clean skip, as before the guard).
    for (const step of ['write-tree', 'commit-tree', 'push']) {
      expect(calls.some((c) => c.args[0] === step)).toBe(false);
    }
  });

  it('applyCollisionHealToIndex returns { ok: false } instead of throwing, leaving the index untouched', () => {
    const { run, calls } = scriptedRun({
      'ls-tree': (args) => ({ status: 0, stdout: args.includes('origin/main') ? BASE_LS : LANE_LS }),
      'cat-file': catFile,
    });
    let r;
    expect(() => { r = applyCollisionHealToIndex({ run, env: { GIT_INDEX_FILE: '/tmp/idx' }, tree: 'deadbeef' }); }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/collision-heal plan refused/);
    // nothing was staged into the caller's temp index — the manifest drop can still commit its own fix.
    for (const step of ['hash-object', 'update-index', 'rm']) {
      expect(calls.some((c) => c.args[0] === step)).toBe(false);
    }
  });
});
