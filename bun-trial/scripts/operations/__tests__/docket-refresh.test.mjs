/**
 * @file docket-refresh.test.mjs — the `docket-refresh` operation (#3723, under epic #3383): the pure parts (the
 * clock-free content hash, the hand-off decision, the plan and the trailer) and the REAL mechanism in a temp
 * workspace: a bare origin, a lane clone and a primary clone (on the shared `helpers/real-repo.mjs` harness),
 * real `git`, the real reader and sink driven through the real CLI adapter.
 *
 * The one stub is the checkout's `scripts/gen-decision-docket.mjs`: the real one ranks through `check-readiness` over a
 * whole backlog. The stub keeps the real generator's contract that matters here (`data --ref --out`, `render --data
 * --out`, paths resolved against its own checkout, a `generatedAt` and an `ageInDays` that change on every run) and
 * reads each card off `--ref`, so a `preparedDate` landing on the ref is what changes its record.
 *
 * The story (Done when #1): an unchanged backlog is a no-op with no hand-off; a `preparedDate` landing on `origin/main`
 * yields exactly one hand-off, and only once the checkout is at that ref; no run writes anything inside any checkout;
 * a primary checkout is refused before any effect. Plus this repo's own additions over the ported prototype: the
 * publish-owed record and stdout carry the tracked Artifact URL (never fabricated when the file is absent), the
 * stdout trailer surfaces the parseOk:false item numbers at a glance, and `--force` hands off even on an unchanged
 * hash.
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/operations/__tests__/docket-refresh.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOCKET_REFRESH_EFFECT, DOCKET_REFRESH_OP, PUBLISH_VIA,
  buildPublishOwed, countItems, decideHandoff, docketRefreshOperation, finishDocketOutcome, formatState, parseState,
  planDocketRefresh, shapeDocketRead, stableDocketData,
} from '../../../../scripts/operations/docket-refresh.mjs';
import {
  createDocketRefreshReader, createDocketRefreshSinks, docketDataHash, docketPaths, isPrimaryCheckout,
  readDocketArtifact,
} from '../../../../scripts/operations/docket-refresh-io.mjs';
import { createRegistry } from '../../../../scripts/operations/registry.mjs';
import { createMemoryRunStore } from '../../../../scripts/operations/run-store.mjs';
import { runOperationCli } from '../../../../scripts/operations/cli-adapter.mjs';
import { importGraph } from '../../../../scripts/operations/__tests__/import-graph.mjs';
import { git as realGit, withBareOrigin } from '../../../../scripts/operations/__tests__/helpers/real-repo.mjs';

const HERE = dirname(fileURLToPath(__ORIG_URL));
const NOW = '2026-09-21T13:00:00.000Z';

describe('the content hash', () => {
  const data = (o = {}) => ({ generatedAt: NOW, generatedFromRef: 'origin/main', items: [{ num: '3675', prepared: false, forks: [], ageInDays: 3, ...o }] });

  it('ignores the clock fields (generatedAt, ageInDays), the sha read (generatedFromRef) and key order', () => {
    const a = data();
    const b = { items: [{ ageInDays: 90, forks: [], prepared: false, num: '3675' }], generatedFromRef: '8a7583b8f', generatedAt: '2030-01-01T00:00:00Z' };
    expect(stableDocketData(a)).toBe(stableDocketData(b));
    expect(docketDataHash(a)).toBe(docketDataHash(b));
    expect(docketDataHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a record changes: a preparedDate and forks appearing', () => {
    expect(docketDataHash(data({ prepared: true, preparedDate: '2026-09-19', forks: ['Fork 1'] }))).not.toBe(docketDataHash(data()));
  });
});

describe('the hand-off decision and records', () => {
  it('hands off when nothing was recorded or the hash differs, and not when it is equal', () => {
    expect(decideHandoff({ hash: 'a', state: null }).changed).toBe(true);
    expect(decideHandoff({ hash: 'a', state: { lastHash: 'b' } }).changed).toBe(true);
    expect(decideHandoff({ hash: 'a', state: { lastHash: 'a' } }).changed).toBe(false);
    expect(() => decideHandoff({ hash: '' })).toThrow(/no content hash/);
  });

  it('--force hands off even when the hash equals the last recorded one', () => {
    const decision = decideHandoff({ hash: 'a', state: { lastHash: 'a' }, force: true });
    expect(decision.changed).toBe(true);
    expect(decision.reason).toMatch(/--force/);
  });

  it('round-trips the state file and tolerates a broken one', () => {
    expect(parseState(formatState({ lastHash: 'h', lastChangedAt: NOW }))).toEqual({ lastHash: 'h', lastChangedAt: NOW });
    expect(parseState('not json')).toBeNull();
    expect(parseState('')).toBeNull();
  });

  it('the publish-owed record names the publish path it defers to, and invents none', () => {
    const owed = buildPublishOwed({ hash: 'h', ref: 'origin/main', headSha: 's', dataPath: '/d', htmlPath: '/p', now: NOW, counts: { decisions: 1 } });
    expect(owed).toMatchObject({ owed: 'publish', hash: 'h', owedSince: NOW, publishVia: PUBLISH_VIA, artifactUrl: null, artifactTitle: null });
    expect(PUBLISH_VIA).toMatch(/#3277/);
  });

  it('the publish-owed record carries the Artifact URL when one was read, never inventing one when absent', () => {
    const withArtifact = buildPublishOwed({ hash: 'h', now: NOW, counts: {}, artifact: { url: 'https://claude.ai/artifact/x', title: 'Decision Docket' } });
    expect(withArtifact).toMatchObject({ artifactUrl: 'https://claude.ai/artifact/x', artifactTitle: 'Decision Docket' });
    const withoutArtifact = buildPublishOwed({ hash: 'h', now: NOW, counts: {}, artifact: null });
    expect(withoutArtifact).toMatchObject({ artifactUrl: null, artifactTitle: null });
  });

  it('counts decisions, prepared, prepared-with-a-parse-warning, AND which item numbers those are', () => {
    expect(countItems({
      items: [
        { num: '10', prepared: true, parseOk: false },
        { num: '20', prepared: true, parseOk: true },
        { num: '30', prepared: false },
        { num: '40', prepared: true, parseOk: false },
      ],
    })).toEqual({ decisions: 4, prepared: 3, parseWarnings: 2, parseWarningNums: ['10', '40'] });
  });
});

describe('reading the tracked Artifact pointer', () => {
  const made = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'docket-artifact-'));
    made.push(dir);
    return dir;
  };
  afterEach(() => { while (made.length) rmSync(made.pop(), { recursive: true, force: true }); });

  it('reads {url, title} off skills-src/decision-docket/artifact.json', () => {
    const root = tmp();
    mkdirSync(join(root, 'skills-src', 'decision-docket'), { recursive: true });
    writeFileSync(join(root, 'skills-src', 'decision-docket', 'artifact.json'), JSON.stringify({ url: 'https://claude.ai/artifact/abc', title: 'Decision Docket' }));
    expect(readDocketArtifact(root)).toEqual({ url: 'https://claude.ai/artifact/abc', title: 'Decision Docket' });
  });

  it('returns null (never throws, never fabricates) when the file is absent, unparseable, or has no url', () => {
    expect(readDocketArtifact(tmp())).toBeNull();
    const root = tmp();
    mkdirSync(join(root, 'skills-src', 'decision-docket'), { recursive: true });
    writeFileSync(join(root, 'skills-src', 'decision-docket', 'artifact.json'), 'not json');
    expect(readDocketArtifact(root)).toBeNull();
    const root2 = tmp();
    mkdirSync(join(root2, 'skills-src', 'decision-docket'), { recursive: true });
    writeFileSync(join(root2, 'skills-src', 'decision-docket', 'artifact.json'), JSON.stringify({ title: 'no url here' }));
    expect(readDocketArtifact(root2)).toBeNull();
  });
});

describe('the declaration', () => {
  it('reaches nothing that can act (no fs, child_process or crypto): the io is injected', () => {
    expect(importGraph(resolve(HERE, '..', 'docket-refresh.mjs')).external).toEqual([]);
  });

  it('refuses to be built without a reader', () => {
    expect(() => docketRefreshOperation()).toThrow(/readFacts/);
  });

  it('plans the sequence, and refuses a primary checkout in the plan (no effect is declared)', () => {
    const read = shapeDocketRead({ root: '/lane', primary: false, ...docketPaths('/state'), state: null, now: NOW });
    expect(read.dataPath).toBe('/state/docket/decision-docket-data.json');
    const plan = planDocketRefresh(read, { apply: true });
    expect(plan).toMatchObject({ apply: true, refused: null, force: false });
    expect(plan.steps[0]).toBe('git fetch origin main');
    const refused = planDocketRefresh({ ...read, primary: true }, { apply: true });
    expect(refused.apply).toBe(false);
    expect(refused.refused).toMatch(/primary checkout/);
    expect(() => shapeDocketRead({})).toThrow(/no checkout/);
  });

  it('the plan names --force in its steps when passed', () => {
    const read = shapeDocketRead({ root: '/lane', primary: false, ...docketPaths('/state'), state: null, now: NOW });
    const plan = planDocketRefresh(read, { apply: true, force: true });
    expect(plan.force).toBe(true);
    expect(plan.steps.some((s) => /--force/.test(s))).toBe(true);
  });

  it('the trailer: a refused or failed run prints no publish line', () => {
    const plan = planDocketRefresh(shapeDocketRead({ root: '/lane', ...docketPaths('/s') }), { apply: true });
    expect(finishDocketOutcome({ run: { verdict: { ...plan, refused: 'x' } }, code: 0, lines: [] }).lines.join('\n')).not.toMatch(/^publish:/m);
    const failed = finishDocketOutcome({ run: { verdict: plan, effects: [{ type: DOCKET_REFRESH_EFFECT, status: 'failed', error: 'boom' }] }, code: 0, lines: [] });
    expect(failed.code).toBe(1);
    expect(failed.lines.join('\n')).not.toMatch(/^publish:/m);
  });

  it('the trailer surfaces the parseOk:false item numbers at a glance and the artifact URL (or its absence)', () => {
    const plan = planDocketRefresh(shapeDocketRead({ root: '/lane', ...docketPaths('/s') }), { apply: true });
    const result = {
      fetched: 'fetched origin/main', dataPath: '/s/docket/decision-docket-data.json', htmlPath: '/s/docket/decision-docket.html',
      hash: 'a'.repeat(64), reason: 'no refresh has been recorded yet', owedPath: '/s/docket/publish-owed.json',
      artifactUrl: 'https://claude.ai/artifact/xyz',
      counts: { decisions: 2, prepared: 1, parseWarnings: 1, parseWarningNums: ['3123'] },
    };
    const out = finishDocketOutcome({ run: { verdict: plan, effects: [{ type: DOCKET_REFRESH_EFFECT, status: 'applied', result }] }, code: 0, lines: [] });
    expect(out.lines.join('\n')).toMatch(/parseOk:false — 1 item\(s\): #3123/);
    expect(out.lines.join('\n')).toMatch(/artifact https:\/\/claude\.ai\/artifact\/xyz/);
    expect(out.lines.at(-1)).toBe('publish: owed');

    const clean = finishDocketOutcome({
      run: {
        verdict: plan,
        effects: [{
          type: DOCKET_REFRESH_EFFECT, status: 'applied',
          result: { ...result, owedPath: null, artifactUrl: null, counts: { decisions: 2, prepared: 1, parseWarnings: 0, parseWarningNums: [] } },
        }],
      },
      code: 0, lines: [],
    });
    expect(clean.lines.join('\n')).toMatch(/parseOk:false — 0 items \(no hand-fill needed\)/);
    expect(clean.lines.at(-1)).toBe('publish: none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The real mechanism.

const GENERATOR_STUB = `import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(__ORIG_URL)), '..');
const flags = Object.fromEntries(process.argv.slice(3).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const write = (p, s) => { const out = resolve(ROOT, p); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, s); };
const sub = process.argv[2];
if (sub === 'data') {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  if (process.env.STUB_SELF_FETCH) git('fetch', '--quiet', 'origin', 'main');
  const files = git('ls-tree', '--name-only', flags.ref, 'backlog/').split('\\n').filter(Boolean);
  const items = files.map((f) => {
    const t = git('show', flags.ref + ':' + f);
    const pd = /^preparedDate: "?([0-9-]+)"?/m.exec(t);
    return { num: /backlog\\/(\\d+)/.exec(f)[1], prepared: !!pd, preparedDate: pd ? pd[1] : null, forks: pd ? [...t.matchAll(/^## Fork \\d+.*$/gm)].map((m) => m[0]) : [], parseOk: true, ageInDays: Math.floor(Math.random() * 1e6) };
  });
  write(flags.out ?? 'reports/decision-docket-data.json', JSON.stringify({ generatedAt: new Date().toISOString(), generatedFromRef: flags.ref ?? null, items }, null, 2));
} else if (sub === 'render') {
  const d = JSON.parse(readFileSync(resolve(ROOT, flags.data), 'utf8'));
  write(flags.out ?? 'reports/decision-docket.html', '<html>' + d.items.map((i) => i.num + ':' + i.forks.length).join(',') + '</html>');
} else process.exit(2);
`;

const CARD_3675 = '---\nkind: decision\nstatus: open\n---\n\n# Decide the review seat\n';
const CARD_3675_PREPARED = '---\nkind: decision\nstatus: open\npreparedDate: "2026-09-19"\n---\n\n# Decide the review seat\n\n## Fork 1: seat\n\n## Fork 2: model\n\n## Fork 3: budget\n\n## Fork 4: fallback\n';
const ARTIFACT_JSON = JSON.stringify({ url: 'https://claude.ai/artifact/KjSHDBsszGcJ6cTX8fHedG', title: 'Decision Docket' });

const gitIn = (cwd, ...args) => realGit(args, { cwd }).trim();

let savedEnv;
beforeEach(() => {
  savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  // The sink shells real `git`; keep the operator's global config (hooks, url rewrites) out of the temp repos.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/**
 * A workspace on the shared real-repo harness: a bare origin whose `main` holds the generator, the tracked
 * artifact pointer, and two cards, a lane clone at `<tmp>/.lanes/web-everything/lane-1`, a primary clone at
 * `<tmp>/webeverything`, and a state root outside all of them. `land(files)` advances the origin's `main` (a PR
 * merging).
 */
function scenario(fn, { generator = GENERATOR_STUB, artifact = ARTIFACT_JSON } = {}) {
  return withBareOrigin(async (ctx) => {
    ctx.seedOriginBranch('main', {
      'scripts/gen-decision-docket.mjs': generator,
      'backlog/3675-decide-the-review-seat.md': CARD_3675,
      'backlog/3700-other.md': '---\nkind: decision\nstatus: open\n---\n\n# Other\n',
      ...(artifact ? { 'skills-src/decision-docket/artifact.json': artifact } : {}),
    });
    const lane = join(ctx.tmp, '.lanes', 'web-everything', 'lane-1');
    mkdirSync(dirname(lane), { recursive: true });
    gitIn(ctx.tmp, 'clone', '--quiet', ctx.origin, lane);
    const primary = join(ctx.tmp, 'webeverything');
    gitIn(ctx.tmp, 'clone', '--quiet', ctx.origin, primary);
    const stateRoot = join(ctx.tmp, 'coordination');
    return fn({ tmp: ctx.tmp, lane, primary, stateRoot, paths: docketPaths(stateRoot), land: (files) => ctx.seedOriginBranch('main', files) });
  });
}

/** One real run through the CLI adapter, the real reader and the real sink; returns the trailer and the effect result. */
async function refresh(ws, checkout, argv = ['--apply']) {
  const declaration = docketRefreshOperation({
    readFacts: createDocketRefreshReader({ stateRoot: () => ws.stateRoot, isPrimary: (root) => isPrimaryCheckout(root, { workspace: ws.tmp }), now: () => NOW }),
  });
  const registry = createRegistry();
  registry.register(declaration);
  const outcome = await runOperationCli({
    declaration, argv: [`--checkout=${checkout}`, ...argv], registry, store: createMemoryRunStore(), sinks: createDocketRefreshSinks(), newRunId: () => `run-docket-${Math.random().toString(36).slice(2)}`,
  });
  const { code, lines } = finishDocketOutcome({ run: outcome.run, code: outcome.code, lines: outcome.lines });
  const effect = (outcome.run?.effects ?? []).find((e) => e.type === DOCKET_REFRESH_EFFECT);
  return { code, lines, last: lines.at(-1), result: effect?.result ?? null };
}

const clean = (checkout) => gitIn(checkout, 'status', '--porcelain', '--untracked-files=all', '--ignored');
const owedRecord = (ws) => JSON.parse(readFileSync(ws.paths.owedPath, 'utf8'));
const record3675 = (ws) => JSON.parse(readFileSync(ws.paths.dataPath, 'utf8')).items.find((i) => i.num === '3675');

describe('docket-refresh (real git, real reader and sink)', () => {
  it('a dry run writes nothing anywhere', () => scenario(async (ws) => {
    const r = await refresh(ws, ws.lane, []);
    expect(r.lines[0]).toMatch(/dry run — would run: /);
    expect(r.lines.join('\n')).not.toMatch(/^publish:/m);
    expect(existsSync(ws.stateRoot)).toBe(false);
    expect(clean(ws.lane)).toBe('');
  }));

  it('an unchanged backlog is a no-op; a preparedDate landing yields exactly one hand-off; no checkout is ever written', () => scenario(async (ws) => {

    // First refresh: nothing recorded yet, so the first data is a hand-off.
    const first = await refresh(ws, ws.lane);
    expect(first.code).toBe(0);
    expect(first.last).toBe('publish: owed');
    expect(record3675(ws)).toMatchObject({ prepared: false, forks: [] });
    const firstOwed = owedRecord(ws);
    expect(firstOwed).toMatchObject({ owed: 'publish', ref: 'origin/main', hash: first.result.hash, publishVia: PUBLISH_VIA, artifactUrl: 'https://claude.ai/artifact/KjSHDBsszGcJ6cTX8fHedG', artifactTitle: 'Decision Docket' });

    // Unchanged backlog: same hash (the clock fields moved), no hand-off, the record is untouched.
    const second = await refresh(ws, ws.lane);
    expect(second.last).toBe('publish: none');
    expect(second.result).toMatchObject({ hash: first.result.hash, owedPath: null, htmlPath: null });
    expect(owedRecord(ws)).toEqual(firstOwed);

    // #3675's preparedDate lands on origin/main (the #2339 case). The lane has not moved yet: refused, no hand-off.
    ws.land({ 'backlog/3675-decide-the-review-seat.md': CARD_3675_PREPARED });
    const behind = await refresh(ws, ws.lane);
    expect(behind.code).toBe(1);
    expect(behind.lines[0]).toMatch(/REFUSED — HEAD .* is not origin\/main/);
    expect(behind.lines.join('\n')).not.toMatch(/^publish:/m);
    expect(owedRecord(ws)).toEqual(firstOwed);

    // The lane at the new origin/main: exactly one hand-off, and #3675 now carries its four forks.
    gitIn(ws.lane, 'merge', '--quiet', '--ff-only', 'origin/main');
    const changed = await refresh(ws, ws.lane);
    expect(changed.last).toBe('publish: owed');
    expect(changed.result.hash).not.toBe(first.result.hash);
    expect(record3675(ws)).toMatchObject({ prepared: true, preparedDate: '2026-09-19' });
    expect(record3675(ws).forks).toHaveLength(4);
    expect(owedRecord(ws)).toMatchObject({ hash: changed.result.hash, headSha: gitIn(ws.lane, 'rev-parse', 'HEAD') });
    expect(readFileSync(ws.paths.htmlPath, 'utf8')).toContain('3675:4');

    // And once only: the next run is a no-op again.
    const after = await refresh(ws, ws.lane);
    expect(after.last).toBe('publish: none');

    // Across the whole story the lane never got a file: every output is under the state root.
    expect(clean(ws.lane)).toBe('');
    expect(readdirSync(ws.paths.dir).sort()).toEqual(['decision-docket-data.json', 'decision-docket.html', 'publish-owed.json', 'state.json']);
  }));

  it('--force hands off on an otherwise-unchanged backlog, so a session that explicitly asked for a refresh still gets a page', () => scenario(async (ws) => {
    const first = await refresh(ws, ws.lane);
    expect(first.last).toBe('publish: owed');

    // Without --force: unchanged, no hand-off (the baseline this test contrasts with).
    const noForce = await refresh(ws, ws.lane);
    expect(noForce.last).toBe('publish: none');

    // With --force: same unchanged backlog, but hands off anyway.
    const forced = await refresh(ws, ws.lane, ['--apply', '--force']);
    expect(forced.last).toBe('publish: owed');
    expect(forced.result.hash).toBe(first.result.hash); // the DATA didn't change...
    expect(forced.result.owedPath).not.toBeNull(); // ...but the hand-off still fired.
    expect(forced.lines.join('\n')).toMatch(/--force requested a refresh/);
  }));

  it('when the checkout has no tracked artifact.json, the owed record and stdout say so plainly rather than inventing a URL', () => scenario(async (ws) => {
    const r = await refresh(ws, ws.lane);
    expect(r.last).toBe('publish: owed');
    expect(owedRecord(ws)).toMatchObject({ artifactUrl: null, artifactTitle: null });
    expect(r.lines.join('\n')).toMatch(/no skills-src\/decision-docket\/artifact\.json found/);
  }, { artifact: null }));

  it('an older generator that joins --out onto its root (main as of 2026-09-19) still writes outside the checkout', () => scenario(async (ws) => {
    const r = await refresh(ws, ws.lane);
    expect(r.last).toBe('publish: owed');
    expect(existsSync(ws.paths.dataPath)).toBe(true);
    expect(clean(ws.lane)).toBe('');
  }, { generator: GENERATOR_STUB.replace('const out = resolve(ROOT, p);', 'const out = join(ROOT, p);').replace('resolve(ROOT, flags.data)', 'join(ROOT, flags.data)') }));

  it('reads the sha it checked even when the generator fetches by itself (older check-readiness): no newer card leaks in', () => scenario(async (ws) => {
    // A preparedDate lands on origin AFTER the lane's last fetch; the refresh runs without fetching.
    ws.land({ 'backlog/3675-decide-the-review-seat.md': CARD_3675_PREPARED });
    process.env.STUB_SELF_FETCH = '1';
    try {
      const r = await refresh(ws, ws.lane, ['--apply', '--fetch=false']);
      expect(r.last).toBe('publish: owed');
      expect(record3675(ws)).toMatchObject({ prepared: false, forks: [] });
      expect(JSON.parse(readFileSync(ws.paths.dataPath, 'utf8')).generatedFromRef).toBe(gitIn(ws.lane, 'rev-parse', 'HEAD'));
    } finally { delete process.env.STUB_SELF_FETCH; }
  }));

  it('refuses to run from the primary checkout, before any effect', () => scenario(async (ws) => {
    expect(isPrimaryCheckout(ws.primary, { workspace: ws.tmp })).toBe(true);
    expect(isPrimaryCheckout(ws.lane, { workspace: ws.tmp })).toBe(false);
    const r = await refresh(ws, ws.primary);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/REFUSED — .*webeverything is a primary checkout/);
    expect(r.result).toBeNull();
    expect(existsSync(ws.stateRoot)).toBe(false);
    expect(clean(ws.primary)).toBe('');
  }));

  it('is registered on the command line under its name', async () => {
    const { resolveOperation } = await import('../../../../scripts/operations/run.mjs');
    expect(resolveOperation(DOCKET_REFRESH_OP).declaration.name).toBe(DOCKET_REFRESH_OP);
  });
});
