/**
 * @file reconcile-finding.test.mjs — PURE logic tests for the body/actor builders + IO-shell tests over injected
 * fakes (no real `gh`, no real filesystem — mirrors `we:scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs`
 * and `we:scripts/__tests__/review-set-label.test.mjs`'s own process.exit-capture harness).
 */
import { describe, it, expect } from 'vitest';

import {
  RECONCILE_FINDING_BANNER,
  DEFAULT_RECONCILE_CHANNEL,
  buildReconcileFindingBody,
  defaultReconcileActor,
  runReconcileFindingCli,
} from '../reconcile-finding.mjs';

describe('buildReconcileFindingBody — PURE', () => {
  it('prefixes the caller write-up with the fixed banner', () => {
    const body = buildReconcileFindingBody('the actual finding text');
    expect(body.startsWith(RECONCILE_FINDING_BANNER)).toBe(true);
    expect(body).toContain('the actual finding text');
  });

  it('trims the write-up and never renders a literal undefined for a missing one', () => {
    expect(buildReconcileFindingBody(undefined)).not.toContain('undefined');
    expect(buildReconcileFindingBody('  padded  \n')).toContain('padded');
  });

  it('names this as a sequencing/cross-cutting concern, distinct from a correctness/security verdict', () => {
    expect(RECONCILE_FINDING_BANNER).toMatch(/[Ss]equencing/);
    expect(RECONCILE_FINDING_BANNER).toMatch(/not a correctness\/security review verdict/);
  });
});

describe('defaultReconcileActor — PURE', () => {
  it('folds a supplied agent name into the generic label', () => {
    expect(defaultReconcileActor('the #1920 rebase agent')).toBe('the #1920 rebase agent (a mechanical reconciliation pass)');
  });

  it('falls back to the generic label alone when no agent name is given', () => {
    expect(defaultReconcileActor()).toBe('a mechanical reconciliation pass');
    expect(defaultReconcileActor('')).toBe('a mechanical reconciliation pass');
    expect(defaultReconcileActor('   ')).toBe('a mechanical reconciliation pass');
  });
});

describe('runReconcileFindingCli — the real incident, PR #1920 (2026-09-05)', () => {
  const FINDING_TEXT = [
    "main's own resolution of sibling item #2412 deliberately deferred the exact feature this PR builds "
      + '(`blockedBy: ["2410"]`, because nothing writes `redteam:accepted` to a live PR yet). This PR builds that '
      + 'feature anyway — landing it as-is introduces a hard-block on every engine-tier PR with no way to satisfy '
      + 'it. Cited: #2412, #2410.',
  ].join('\n');

  /**
   * Records the ORDER + payload of port calls, mirroring review-set-label.test.mjs's own stub shape. STATEFUL —
   * `setLabels` mutates the live label set, and `readLabels` (the harness's post-swap RE-READ, per
   * `runReviewLabelCli`'s `newLabels = provider.readLabels(...)`) reflects it, so `payload.labels` in a test
   * asserts what the swap actually left rather than the PR's state before it.
   */
  function stubProvider({ labels = [] } = {}) {
    const calls = [];
    let live = [...labels];
    return {
      calls,
      name: 'stub',
      currentRepo: () => 'web-everything/web-everything',
      readPrState: () => {
        calls.push(['readPrState']);
        return { labels: live.map((name) => ({ name })), headRefOid: 'a'.repeat(40), headRefName: 'lane/2412c-engine-tier-redteam-gate', state: 'OPEN', body: '' };
      },
      readLabels: () => { calls.push(['readLabels']); return live.map((name) => ({ name })); },
      setLabels: (repo, pr, spec) => {
        calls.push(['setLabels', repo, pr, spec]);
        const remove = new Set(spec?.remove || []);
        live = live.filter((l) => !remove.has(l));
        if (spec?.add && !live.includes(spec.add)) live.push(spec.add);
      },
      postComment: (repo, pr, body) => { calls.push(['postComment', repo, pr, body]); },
    };
  }

  /** Run the shell with stdout + process.exit captured, mirroring review-set-label.test.mjs's own harness. */
  function run({ argv, readFile, provider, locateBodyFile, roots }) {
    const chunks = [];
    const realExit = process.exit.bind(process);
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = 0;
    let threw = null;
    try {
      runReconcileFindingCli({
        argv, readFile, provider, locateBodyFile, roots,
        emit: (line) => chunks.push(String(line)),
      });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else threw = e; }
    finally { process.exit = realExit; }
    if (threw) throw threw;
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }

  const okLocate = () => ({ ok: true });
  const fakeReadFile = (contents) => (path) => { if (contents === undefined) throw new Error('ENOENT'); return contents; };

  it('posts the finding + applies review:changes on a clean, review:pending PR (the happy path)', () => {
    const provider = stubProvider({ labels: ['review:pending'] });
    const { exitCode, payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/finding.md', '--agent=the #1920 rebase agent'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider,
      locateBodyFile: okLocate,
    });
    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({ ok: true, pr: 1920, to: 'changes', kind: 'reconcile-finding' });
    expect(payload.labels).toContain('review:changes');

    const posted = provider.calls.find((c) => c[0] === 'postComment');
    expect(posted[3]).toContain(RECONCILE_FINDING_BANNER);
    expect(posted[3]).toContain('#2412');
    expect(posted[3]).toContain('#2410');
    expect(posted[3]).toContain('the #1920 rebase agent (a mechanical reconciliation pass)');
    expect(posted[3]).toContain(DEFAULT_RECONCILE_CHANNEL);

    const swapped = provider.calls.find((c) => c[0] === 'setLabels');
    expect(swapped[3].add).toBe('review:changes');
  });

  it('NEVER reaches review:accepted or clear-human — fixedTo pins the target regardless of --to on argv', () => {
    const provider = stubProvider({ labels: ['review:pending'] });
    const { payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/finding.md', '--to=accepted'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider,
      locateBodyFile: okLocate,
    });
    expect(payload.to).toBe('changes');
    expect(payload.labels).not.toContain('review:accepted');
  });

  it('keeps review:human in place — a bounce never clears the gate-self hold', () => {
    const provider = stubProvider({ labels: ['review:human'] });
    const { payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/finding.md'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider,
      locateBodyFile: okLocate,
    });
    expect(payload.ok).toBe(true);
    expect(payload.labels).toContain('review:human');
    expect(payload.labels).toContain('review:changes');
  });

  it('strips a stale review:accepted / ready-to-merge — a re-raised finding must not look landable', () => {
    const provider = stubProvider({ labels: ['review:accepted', 'ready-to-merge'] });
    const { payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/finding.md'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider,
      locateBodyFile: okLocate,
    });
    expect(payload.labels).toContain('review:changes');
    expect(payload.labels).not.toContain('review:accepted');
    expect(payload.labels).not.toContain('ready-to-merge');
  });

  it('refuses with no --body-file — this is always a bounce, never a silent no-op', () => {
    const { exitCode, payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider: stubProvider(),
      locateBodyFile: okLocate,
    });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/usage/);
  });

  it('refuses the bare `--body-file <path>` space-separated form', () => {
    const { exitCode, payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file', '/tmp/finding.md'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider: stubProvider(),
      locateBodyFile: okLocate,
    });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/=-form/);
  });

  it('refuses a --body-file outside the allowed roots, before any gh call', () => {
    const provider = stubProvider({ labels: ['review:pending'] });
    const { exitCode, payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/etc/passwd'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider,
      locateBodyFile: () => ({ ok: false, roots: ['/repo', '/tmp'] }),
    });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/must live under the repo root or a temp dir/);
    expect(provider.calls).toEqual([]);
  });

  it('refuses an unreadable --body-file', () => {
    const { exitCode, payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/missing.md'],
      readFile: fakeReadFile(undefined),
      provider: stubProvider(),
      locateBodyFile: okLocate,
    });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/unreadable/);
  });

  it('refuses an empty --body-file — no fabricated finding', () => {
    const { exitCode, payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/finding.md'],
      readFile: fakeReadFile('   \n  '),
      provider: stubProvider(),
      locateBodyFile: okLocate,
    });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/empty/);
  });

  it('a hand-written finding is NEVER refused as a reasonless bounce, however short', () => {
    // #3334's guard only fires on a RENDERED `### Findings (N)` heading claiming zero findings. A hand-written
    // prose finding (this file's whole shape) carries no such heading, so bounceEvidenceFromWriteUp reads an
    // UNKNOWN finding count, which never refuses — see that function's own doc.
    const provider = stubProvider({ labels: ['review:pending'] });
    const { exitCode, payload } = run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/finding.md'],
      readFile: fakeReadFile('short but real'),
      provider,
      locateBodyFile: okLocate,
    });
    expect(exitCode).toBe(0);
    expect(payload.ok).toBe(true);
  });

  it('--repo is optional — derives from cwd via provider.currentRepo() (a reconciliation agent runs in its own lane clone)', () => {
    const provider = stubProvider({ labels: ['review:pending'] });
    const { exitCode, payload } = run({
      argv: ['1920', '--body-file=/tmp/finding.md'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider,
      locateBodyFile: okLocate,
    });
    expect(exitCode).toBe(0);
    expect(payload.ok).toBe(true);
  });

  it('a --channel override renders in the attribution instead of the default', () => {
    const provider = stubProvider({ labels: ['review:pending'] });
    run({
      argv: ['1920', '--repo=web-everything/web-everything', '--body-file=/tmp/finding.md', '--channel=the drain rebase pass'],
      readFile: fakeReadFile(FINDING_TEXT),
      provider,
      locateBodyFile: okLocate,
    });
    const posted = provider.calls.find((c) => c[0] === 'postComment');
    expect(posted[3]).toContain('the drain rebase pass');
    expect(posted[3]).not.toContain(DEFAULT_RECONCILE_CHANNEL);
  });
});
