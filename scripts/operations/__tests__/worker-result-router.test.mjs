/**
 * @file worker-result-router.test.mjs — item 117 slice S2: settle, the blocker.kind -> action router, the draft sink.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BLOCKER_KINDS, LEGACY_OUTCOME_MAP, ROLES, mapLegacyOutcome } from '../worker-result.mjs';
import { ENVELOPE_ROLES } from '../completion-record.mjs';
import {
  ACTION_TYPES, DRAFT_KINDS, blockerSignature, draftKeyFor, legacyOutcomeWord, listDraftKeys, redactResultText, resolvePostmortemMode,
  routeWorkerResult, settleWorkerResult, writeProductFixDraft,
} from '../worker-result-router.mjs';

const done = (over = {}) => ({ v: 1, outcome: 'done', summary: 'ok', blocker: null, findingsAddressed: [], filesTouched: [], learning: null, ...over });
const blocker = (over = {}) => ({
  kind: 'gate-red', component: 'check:standards', evidence: { text: 'red', refs: [] }, proposedFix: null, ruling: null,
  deniedCommand: null, retryable: true, ...over,
});
const blocked = (b) => done({ outcome: 'blocked', blocker: blocker(b) });
const RULING = { question: 'Tabs or spaces?', options: ['A tabs', 'B spaces'], recommendation: 'A, because it is shorter' };
const FIX_4228 = blocked({
  kind: 'needs-ruling', component: 'guard-lane daemon-clone registry',
  evidence: { text: 'The guard denied every push: a stale daemon-clone registry record makes the lane look foreign.', refs: ['job 33680d94', 'PR #4228'] },
  proposedFix: { summary: 'Prune the stale daemon-clone registry record and make the guard self-heal it.', scope: ['we:scripts/guard-lane.mjs'], size: 3 },
  ruling: { question: 'Should the stale registry record be fixed?', options: ['A fix the registry guard', 'B do not fix, retry later'], recommendation: 'A' },
  retryable: false,
});
const CTX = { role: 'fix', launcher: 'claude-p', session: 'fix-4228', pr: '4228', item: null, postmortemMode: 'draft' };
const route = (r, ctx = {}) => routeWorkerResult(r, { ...CTX, ...ctx });

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wr-router-')); dirs.push(d); return d; };

describe('settleWorkerResult (launcher output -> envelope result)', () => {
  it('a valid result is parsed ok and the D1 guard reroutes a code-path needs-ruling (fix-4228)', () => {
    const s = settleWorkerResult({ role: 'fix', launcher: 'claude-p', value: FIX_4228 });
    expect(s.parse).toEqual({ ok: true, reason: null });
    expect(s.result.blocker.kind).toBe('tooling-defect');
    expect(s.reroute).toMatchObject({ from: 'needs-ruling', to: 'tooling-defect' });
  });
  it('fails closed: no output, bad JSON, schema violation and a failed reader check are all contract-violation, never success', () => {
    const cases = [
      [{ }, 'no-structured-output'],
      [{ text: '{nope' }, 'invalid-json'],
      [{ value: { v: 1, outcome: 'done' } }, 'schema-violation'],
      [{ value: done(), role: 'build' }, 'schema-violation'], // a build that is done needs files
    ];
    for (const [input, why] of cases) {
      const s = settleWorkerResult({ role: 'fix', launcher: 'codex-exec', ...input });
      expect(s.parse).toEqual({ ok: false, reason: why });
      expect(s.result.outcome).toBe('unparseable');
      expect(s.result.blocker.kind).toBe('contract-violation');
      expect(route(s.result).type).toBe('product-fix-draft');
    }
  });
  it('an operator stop is aborted and makes no draft (D6)', () => {
    const s = settleWorkerResult({ role: 'fix', launcher: 'claude-p', aborted: true });
    expect(route(s.result).type).toBe('aborted');
    expect(writeProductFixDraft(route(s.result), { dir: tmp() }).written).toBe(false);
  });
  it('redacts token-like text in summary and evidence at the single write point', () => {
    const r = settleWorkerResult({ role: 'fix', launcher: 'claude-p', value: blocked({ evidence: { text: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnop12345" failed', refs: [] } }) }).result;
    expect(JSON.stringify(r)).not.toContain('ghp_abcdefghijklmnop12345');
    expect(redactResultText(done({ summary: 'token ghp_abcdefghijklmnop12345' })).summary).not.toContain('ghp_');
  });
});

describe('redactResultText: identifiers vs prose', () => {
  const TOKEN = 'ghp_abcdefghijklmnop12345';
  it('keeps a proposedFix.scope path (npm scope `@`) intact but still removes a token', () => {
    const r = redactResultText(blocked({ proposedFix: { summary: 's', scope: ['we:node_modules/@scope/pkg/x.mjs', `we:scripts/y.mjs ${TOKEN}`], size: 1 } }));
    expect(r.blocker.proposedFix.scope[0]).toBe('we:node_modules/@scope/pkg/x.mjs');
    expect(r.blocker.proposedFix.scope[1]).not.toContain(TOKEN);
  });
  it('leaves an opaque findingsAddressed ref alone, redacts one that is not, and keeps a null note null', () => {
    const r = redactResultText(done({ findingsAddressed: [
      { ref: 'F1', disposition: 'fixed', note: null }, { ref: `secret ${TOKEN}`, disposition: 'fixed', note: 'n' },
      { ref: TOKEN, disposition: 'fixed', note: 'n' }, // a token-shaped ref looks like an opaque id; it must still go
    ] }));
    expect(r.findingsAddressed[0]).toEqual({ ref: 'F1', disposition: 'fixed', note: null });
    expect(r.findingsAddressed[1].ref).not.toContain(TOKEN);
    expect(r.findingsAddressed[2].ref).not.toContain('ghp_');
  });
});

describe('routeWorkerResult (section 4 as code)', () => {
  const kindRoutes = {
    'infra-transient': 'retry-after-cooloff', 'host-load': 'quiet-host-reverify', 'permission-wall': 'product-fix-draft',
    'tooling-defect': 'product-fix-draft', 'spec-defect': 're-prepare', dependency: 'hold-until-ref', conflict: 'resolve-conflict',
    'gate-red': 'redispatch-with-output', 'needs-ruling': 'operator',
  };
  it('covers every blocker kind the schema allows, no more and no less', () => {
    expect(Object.keys(kindRoutes).sort()).toEqual([...BLOCKER_KINDS].sort());
    for (const kind of BLOCKER_KINDS) {
      const b = kind === 'needs-ruling' ? { kind, ruling: RULING } : { kind };
      const a = route(blocked(b));
      expect(a.type, kind).toBe(kindRoutes[kind]);
      expect(ACTION_TYPES).toContain(a.type);
    }
  });
  it('success shapes route to themselves', () => {
    expect(route(done()).type).toBe('done');
    expect(route(done({ outcome: 'no-change' })).type).toBe('no-change');
    expect(route(done({ outcome: 'not-applicable' })).type).toBe('not-applicable');
  });
  it('tooling-defect, permission-wall and contract-violation make a draft under postmortem.mode; an operator action only ever comes from a needs-ruling (a repeated conflict is promoted to one)', () => {
    expect(DRAFT_KINDS).toEqual(['tooling-defect', 'permission-wall', 'contract-violation']);
    for (const kind of BLOCKER_KINDS) {
      const a = route(blocked(kind === 'needs-ruling' ? { kind, ruling: RULING } : { kind }));
      expect(a.type === 'operator', kind).toBe(kind === 'needs-ruling');
    }
    const cv = route(settleWorkerResult({ role: 'fix', launcher: 'claude-p' }).result);
    expect(cv).toMatchObject({ type: 'product-fix-draft', mode: 'draft', draft: { kind: 'contract-violation' } });
    expect(route(blocked({ kind: 'tooling-defect' })).mode).toBe('draft');
    expect(route(blocked({ kind: 'tooling-defect' }), { postmortemMode: undefined }).mode).toBe('off');
  });
  it('the fix-4228 fixture routes to a product-fix draft and NOT to the operator', () => {
    const s = settleWorkerResult({ role: 'fix', launcher: 'claude-p', value: FIX_4228 });
    const a = route(s.result);
    expect(a.type).toBe('product-fix-draft');
    expect(a.hold).toBe('waiting-on-product-fix');
    expect(a.draft.signature).toBe('tooling-defect|guard-lane daemon-clone registry');
  });
  it('a genuine taste call still reaches the operator with question, options and recommendation', () => {
    const a = route(blocked({ kind: 'needs-ruling', component: 'style', ruling: RULING }));
    expect(a).toMatchObject({ type: 'operator', via: 'needs-you', ruling: RULING });
  });
  it('a second conflict becomes a ruling; infra-transient past its cap becomes a draft', () => {
    expect(route(blocked({ kind: 'conflict', ruling: null }), { priorConflicts: 1 }).type).toBe('operator');
    expect(route(blocked({ kind: 'infra-transient' }), { infraStreak: 3, infraCap: 3 }).type).toBe('product-fix-draft');
    expect(route(blocked({ kind: 'infra-transient' }), { infraStreak: 1, infraCap: 3 }).type).toBe('retry-after-cooloff');
  });
  it('fails closed on an unknown outcome, an unknown kind, a blocked result with no blocker and a missing result', () => {
    for (const bad of [{ outcome: 'weird' }, done({ outcome: 'blocked', blocker: { ...blocker(), kind: 'made-up' } }), done({ outcome: 'blocked', blocker: null }), null]) {
      const a = route(bad);
      expect(a.type).toBe('product-fix-draft');
      expect(a.draft.kind).toBe('contract-violation');
    }
  });
  it('keeps the role lists in sync with worker-result', () => {
    expect([...ENVELOPE_ROLES]).toEqual([...ROLES]);
  });
});

describe('legacyOutcomeWord (the way back for unmigrated readers)', () => {
  it('maps blocked kinds to the words the reconciler special-cases and never returns a success word for a failure', () => {
    expect(legacyOutcomeWord(blocked({ kind: 'infra-transient' }))).toBe('blocked-on-infra');
    expect(legacyOutcomeWord(blocked({ kind: 'permission-wall' }))).toBe('blocked-on-permission');
    expect(legacyOutcomeWord(blocked({ kind: 'host-load' }))).toBe('blocked-on-load-flake');
    expect(legacyOutcomeWord(done())).toBe('done');
    expect(legacyOutcomeWord(settleWorkerResult({ role: 'fix', launcher: 'agy' }).result)).toBe('blocked');
    expect(legacyOutcomeWord(null)).toBeNull();
  });
});

describe('redaction covers every free-text field, not just the ones the card named', () => {
  const TOKEN = 'ghp_abcdefghijklmnop12345';
  const leaves = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out)); return out; };
  it('no string leaf of a redacted result keeps a token, wherever the worker put it', () => {
    const dirty = blocked({
      kind: 'needs-ruling', component: `registry ${TOKEN}`, evidence: { text: `e ${TOKEN}`, refs: [`log ${TOKEN}`] },
      proposedFix: { summary: `s ${TOKEN}`, scope: [`we:scripts/x.mjs ${TOKEN}`], size: 1 },
      ruling: { question: `q ${TOKEN}`, options: [`a ${TOKEN}`, `b ${TOKEN}`], recommendation: `r ${TOKEN}` },
    });
    dirty.summary = `sum ${TOKEN}`;
    dirty.findingsAddressed = [{ ref: 'F1', disposition: 'fixed', note: `n ${TOKEN}` }];
    dirty.filesTouched = ['scripts/@scope/a b.mjs'];
    dirty.learning = { kind: 'friction', summary: `l ${TOKEN}`, area: `a ${TOKEN}`, suggestion: `g ${TOKEN}` };
    const clean = redactResultText(dirty);
    expect(leaves(clean).filter((x) => x.includes(TOKEN))).toEqual([]);
    expect(clean.blocker.component).toContain('registry');
    expect(clean.filesTouched).toEqual(['scripts/@scope/a b.mjs']); // paths are identifiers: never rewritten by the prose redactor
  });
});

describe('legacyOutcomeWord only speaks the briefs own vocabulary', () => {
  it('every word it can return is a LEGACY_OUTCOME_MAP key, a bare blocked, or a success/stop word', () => {
    const allowed = new Set([...Object.keys(LEGACY_OUTCOME_MAP), 'blocked', 'aborted']);
    for (const kind of BLOCKER_KINDS) expect(allowed.has(legacyOutcomeWord(blocked({ kind }))), kind).toBe(true);
    for (const o of ['done', 'no-change', 'not-applicable', 'aborted', 'unparseable']) expect(allowed.has(legacyOutcomeWord({ outcome: o })), o).toBe(true);
  });
  it('a blocked kind maps back to the same kind through mapLegacyOutcome (the word loses nothing the reconciler needs)', () => {
    for (const kind of BLOCKER_KINDS) expect(mapLegacyOutcome(legacyOutcomeWord(blocked({ kind })))?.kind, kind).toBe(kind);
  });
});

describe('draft sink (shared 114 store, one file per signature)', () => {
  it('mode off writes nothing; draft writes; replaying the fix-4228 fixture twice is exactly one draft', () => {
    const dir = tmp();
    const result = settleWorkerResult({ role: 'fix', launcher: 'claude-p', value: FIX_4228 }).result;
    expect(writeProductFixDraft(route(result, { postmortemMode: 'off' }), { dir })).toMatchObject({ written: false, reason: 'postmortem-off' });
    expect(listDraftKeys(dir)).toEqual([]);
    const a = route(result);
    expect(writeProductFixDraft(a, { dir, now: () => '2026-10-08T10:00:00.000Z' }).written).toBe(true);
    expect(writeProductFixDraft(a, { dir, now: () => '2026-10-08T11:00:00.000Z' }).grew).toBe(true);
    expect(listDraftKeys(dir)).toEqual([draftKeyFor(blockerSignature(result))]);
    const draft = JSON.parse(readFileSync(join(dir, 'cards', `${listDraftKeys(dir)[0]}.json`), 'utf8'));
    expect(draft).toMatchObject({ state: 'open', count: 1, firstSeen: '2026-10-08T10:00:00.000Z', lastSeen: '2026-10-08T11:00:00.000Z' });
  });
  it('a second session with the same signature grows the same draft instead of making another', () => {
    const dir = tmp();
    const result = settleWorkerResult({ role: 'fix', launcher: 'claude-p', value: FIX_4228 }).result;
    writeProductFixDraft(route(result), { dir });
    writeProductFixDraft(route(result, { session: 'fix-4300', pr: '4300' }), { dir });
    expect(listDraftKeys(dir)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'cards', `${listDraftKeys(dir)[0]}.json`), 'utf8')).count).toBe(2);
  });
  it('worker-controlled signatures cannot grow the store without bound: a NEW draft past the cap is refused, an existing one still grows', () => {
    const dir = tmp();
    const mk = (component) => route(settleWorkerResult({ role: 'fix', launcher: 'claude-p', value: blocked({ kind: 'tooling-defect', component }) }).result);
    const opts = { dir, maxDrafts: 3 };
    for (const c of ['a', 'b', 'c']) expect(writeProductFixDraft(mk(c), opts).written).toBe(true);
    expect(writeProductFixDraft(mk('d'), opts)).toMatchObject({ written: false, reason: 'draft-store-cap', cap: 3 });
    expect(listDraftKeys(dir)).toHaveLength(3);
    expect(writeProductFixDraft(mk('a'), opts)).toMatchObject({ written: true, grew: true });
  });
  it('a contract-violation flood dedupes on role|launcher|reason', () => {
    const dir = tmp();
    for (const pr of ['1', '2', '3']) {
      const r = settleWorkerResult({ role: 'fix', launcher: 'codex-exec', reason: 'timeout' }).result;
      writeProductFixDraft(route(r, { pr, session: `fix-${pr}` }), { dir });
    }
    expect(listDraftKeys(dir)).toHaveLength(1);
  });
  it('postmortem mode: env wins, a bad value fails closed to off, default is off', () => {
    expect(resolvePostmortemMode({ env: { WE_POSTMORTEM_MODE: 'draft' } })).toBe('draft');
    expect(resolvePostmortemMode({ env: { WE_POSTMORTEM_MODE: 'banana' } })).toBe('off');
    expect(resolvePostmortemMode({ env: {} })).toBe('off');
    const d = tmp();
    const readFile = () => JSON.stringify({ mode: 'file' });
    expect(resolvePostmortemMode({ env: {}, operationsDir: d, readFile })).toBe('file');
    expect(resolvePostmortemMode({ env: {}, operationsDir: d, readFile: () => '{bad' })).toBe('off');
  });
});
