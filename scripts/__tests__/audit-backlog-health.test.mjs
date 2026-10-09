/**
 * @file scripts/__tests__/audit-backlog-health.test.mjs
 * @description Unit harness for the `A1` missing-done-when-proof predicate (#2949) — the first test
 * file `audit-backlog-health.mjs` has ever had. `missingDoneWhenProof` is exported specifically so this
 * file can exercise it directly against synthetic fixture bodies, rather than round-tripping through the
 * whole live audit (which reads the real backlog dir and writes `audits/backlog-health-audit.md`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { missingDoneWhenProof, forkLeansOnUnruled, PROSE_PREREQ, ANY_REF } from '../audit-backlog-health.mjs';

// #3522: exercise the live extractors so G1/D2 cannot silently lose short or long ids.
describe('PROSE_PREREQ — G1', () => {
  it.each(['blocked on', 'blocked by'])('recognizes repeated 4-digit citations in a %s enumeration without an extra G1 flag', (phrase) => {
    // Execute the production G1 block without changing the CLI's exports or auditing live fixtures.
    const source = readFileSync('scripts/audit-backlog-health.mjs', 'utf8');
    const g1 = source.slice(source.indexOf('  // G1 edge-gap'), source.indexOf('  // G2 ruling-after-build'));
    const flags = { G1: [] };
    runInNewContext(g1, {
      it: { id: '9999', status: 'open', body: `Requires #2209. ${phrase} #2209, ${phrase} #3512.` },
      blocked: new Set(),
      items: new Map([['2209', { status: 'open' }], ['3512', { status: 'open' }]]),
      PROSE_PREREQ,
      norm: String,
      isDecision: () => false,
      title: () => 'Enumeration regression',
      flags,
    });
    expect(flags.G1.map(flag => flag.ref)).toEqual(['2209']);
  });

  it('hits on 1-2 digit prerequisite ids', () => {
    const body = 'Requires #7 and builds on #39.';
    expect([...body.matchAll(PROSE_PREREQ)].map(m => m[2])).toEqual(['7', '39']);
  });

  it('hits on a 4-digit prerequisite id without truncating it', () => {
    const body = 'Gated on #3512.';
    expect([...body.matchAll(PROSE_PREREQ)].map(m => m[2])).toEqual(['3512']);
  });

  it('accepts longer prerequisite ids, including citations without a hash', () => {
    const body = 'Depends on #12345 and requires 123456.';
    expect([...body.matchAll(PROSE_PREREQ)].map(m => m[2])).toEqual(['12345', '123456']);
  });

  it('requires a right word boundary instead of reading a numeric prefix', () => {
    const body = 'Requires #2209suffix and builds on #3512_suffix.';
    expect([...body.matchAll(PROSE_PREREQ)]).toEqual([]);
  });
});

describe('ANY_REF — D2 (also G3/G7)', () => {
  it('hits on 1-2 digit ids in hash and backlog-path citations', () => {
    const body = 'See #7, #39, /backlog/7 and /backlog/39.';
    expect([...body.matchAll(ANY_REF)].map(m => m[1])).toEqual(['7', '39', '7', '39']);
  });

  it('hits on 4-digit ids in hash and backlog-path citations without truncating them', () => {
    const body = 'See #2209 and /backlog/3512-gate-fix/.';
    expect([...body.matchAll(ANY_REF)].map(m => m[1])).toEqual(['2209', '3512']);
  });

  it('accepts longer ids in hash and backlog-path citations', () => {
    const body = 'See #12345 and /backlog/123456.';
    expect([...body.matchAll(ANY_REF)].map(m => m[1])).toEqual(['12345', '123456']);
  });

  it('requires a right word boundary instead of reading a numeric prefix', () => {
    const body = 'See #2209suffix, #3512_suffix, /backlog/2209suffix and /backlog/3512_suffix.';
    expect([...body.matchAll(ANY_REF)]).toEqual([]);
  });
});

describe('missingDoneWhenProof — A1 (#2949)', () => {
  it('hits when the body has neither a `## Done when` nor `## Acceptance` heading', () => {
    const it_ = { body: '# Title\n\nSome digest paragraph with no proof section at all.\n' };
    expect(missingDoneWhenProof(it_)).toEqual({ hit: true, reason: 'no-section' });
  });

  it('hits when the section exists but carries no backticked path/command-shaped token', () => {
    const it_ = {
      body: '# Title\n\ndigest.\n\n## Done when\n\nIt works when it feels done and the reviewer agrees.\n',
    };
    expect(missingDoneWhenProof(it_)).toEqual({ hit: true, reason: 'no-executable-token' });
  });

  it('does not hit when the section names a real, path-shaped token', () => {
    const it_ = {
      body:
        '# Title\n\ndigest.\n\n## Done when\n\n1. **Executable** — a vitest case in `scripts/__tests__/audit-backlog-health.test.mjs` passes.\n',
    };
    expect(missingDoneWhenProof(it_)).toEqual({ hit: false, reason: null });
  });

  it('does not hit when the section carries an explicit exemption phrase', () => {
    const it_ = {
      body: '# Title\n\ndigest.\n\n## Done when\n\ndoc-only — pure prose change, no tier-1 command applies.\n',
    };
    expect(missingDoneWhenProof(it_)).toEqual({ hit: false, reason: null });
  });

  it('reads `## Acceptance` exactly as `## Done when` — the shared task-agreement heading rule (#5399 S7)', () => {
    for (const items of ['1. Looks right on review.', '- [A1] `scripts/x.mjs` exists.', '- [A1] doc-only — prose.', ''])
      expect(missingDoneWhenProof({ body: `# T\n\nd.\n\n## Acceptance\n\n${items}\n` }))
        .toEqual(missingDoneWhenProof({ body: `# T\n\nd.\n\n## Done when\n\n${items}\n` }));
  });

  it('also recognizes `## Acceptance` and `## Acceptance criteria` headings', () => {
    const noToken = { body: '# Title\n\ndigest.\n\n## Acceptance\n\nLooks right on review.\n' };
    expect(missingDoneWhenProof(noToken)).toEqual({ hit: true, reason: 'no-executable-token' });
    const withToken = {
      body: '# Title\n\ndigest.\n\n## Acceptance criteria\n\n`scripts/check-standards.mjs` reports 0 errors.\n',
    };
    expect(missingDoneWhenProof(withToken)).toEqual({ hit: false, reason: null });
  });
});

// ── G8 unruled-premise (#1935's deterministic backstop) ──────────────────────────────────────────
// A prepared decision whose `## Fork` default leans on a still-open sibling decision, with no
// `blockedBy` edge recording it. Real miss this was built from: #2249's default cited #2209's
// attribute set as its merit ground while #2209 was itself unruled, and the card carried only
// `relatedTo` — so readiness ranked #2249 top of the queue, ahead of its own premise.

const ranges = (b) => {
  const out = []; const idx = [...b.matchAll(/^## /gm)].map((m) => m.index);
  for (let i = 0; i < idx.length; i += 1) out.push({ start: idx[i], end: idx[i + 1] ?? b.length });
  return out;
};
const norm = (x) => String(x);

describe('forkLeansOnUnruled — G8', () => {
  it('hits when a fork cites a still-open decision with no blockedBy edge', () => {
    const body = '## Fork 1 — a vs b\n\nDefault (a), matching #2209 attributes.\n';
    expect(forkLeansOnUnruled(body, new Set(), (r) => r === '2209', ranges, norm)).toEqual(['2209']);
  });

  it('does not hit when the dependency is already recorded on blockedBy', () => {
    const body = '## Fork 1 — a vs b\n\nDefault (a), matching #2209 attributes.\n';
    expect(forkLeansOnUnruled(body, new Set(['2209']), (r) => r === '2209', ranges, norm)).toEqual([]);
  });

  it('does not hit on a citation outside a fork — Context is background, not the default leaning', () => {
    const body = '## Context\n\nSee #2209 for the attribute set.\n';
    expect(forkLeansOnUnruled(body, new Set(), (r) => r === '2209', ranges, norm)).toEqual([]);
  });

  it('does not hit when the cited decision is already resolved', () => {
    const body = '## Fork 1 — a vs b\n\nPrecedent: #2112 settled the delimiter policy.\n';
    expect(forkLeansOnUnruled(body, new Set(), () => false, ranges, norm)).toEqual([]);
  });

  it('collects several leaned-on decisions from one fork without duplicating', () => {
    const body = '## Fork 1\n\nRests on #3010 and #3129, and again on #3010.\n';
    const hits = forkLeansOnUnruled(body, new Set(), (r) => ['3010', '3129'].includes(r), ranges, norm);
    expect(hits.sort()).toEqual(['3010', '3129']);
  });

  // #1957 review, correctness/coverage-gap: the citation regex was `\d{3,4}`, fitted to the id shape of
  // every open decision at the time. `norm` strips leading zeros, so `backlog/039-*.md` has id `39` — a
  // 1-2 digit referent the bound could never see, and 98 items carry one. These two pin both ends of the
  // range so a future re-narrowing reddens instead of going quietly blind.
  it('hits on a 1-2 digit id — `norm` strips the leading zeros off `039-*.md`, so the referent is `39`', () => {
    const body = '## Fork 1 — a vs b\n\nDefault (a), matching #39 attributes.\n';
    expect(forkLeansOnUnruled(body, new Set(), (r) => r === '39', ranges, norm)).toEqual(['39']);
  });

  it('still hits on a 4-digit id — widening the low end did not drop the high end', () => {
    const body = '## Fork 1 — a vs b\n\nDefault (a), matching #3512 attributes.\n';
    expect(forkLeansOnUnruled(body, new Set(), (r) => r === '3512', ranges, norm)).toEqual(['3512']);
  });
});

// #x7xv2xt — importing the module must not run the audit. The script body used to run at import time, so this
// very test file paid for a full audit (the backlog read plus git history walks, ~10 min on a loaded host) and
// rewrote the report. A plain import in a fresh process must print nothing and return quickly.
describe('import has no side effects', () => {
  it('importing the module prints no audit summary', () => {
    const url = pathToFileURL('scripts/audit-backlog-health.mjs').href;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('imported');`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(out.trim()).toBe('imported');
  }, 30_000);
});
