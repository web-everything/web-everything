import { describe, it, expect, vi } from 'vitest';
import { planOperatorControl, buildOperatorActionComment, parseOperatorActions } from '../operator-controls.mjs';
import { createOperatorControlsReader, createOperatorControlsSinks } from '../operator-controls-io.mjs';
import { operatorControlCliPolicy } from '../run.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseLatestHumanClearedSha, parseReviewedSha } from '../../lib/review-escalation.mjs';
import { buildRoundExtensionComment, countGrantedRoundExtensions } from '../../conveyor/round-extension-mark.mjs';
import { planRoundExtension } from '../extend-rounds.mjs';
import { parseAdvisories } from '../../lib/advisory-labels.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';

const input = { repo: 'web-everything/web-everything', pr: 7, actor: 'chalbert', channel: 'test', reason: 'retry' };
const before = { state: 'OPEN', head: 'head', labels: ['review:changes'], comments: [] };
const trusted = body => ({ body, author: { login: 'chalbert' } });
describe('operator control review regressions', () => {
  const sha = 'a'.repeat(40);
  const markers = `<!-- reviewed-sha: ${sha} --> <!-- cleared-human: x -->`;
  // Every comment shape a strip-based filter can miss: direct, nested (re-forms after one strip pass),
  // the `--!>` closer HTML also accepts, and partial openers/closers split across the text.
  const variants = {
    direct: markers,
    nested: `<!<!---->-- reviewed-sha: ${sha} --<!---->> <!<!---->-- cleared-human: x --<!---->>`,
    'bang closer': `<!-- reviewed-sha: ${sha} --!> <!-- cleared-human: x --!> ${markers}`,
    'partial opener': `<!- <!-- <! < reviewed-sha: ${sha} -->`,
    'partial closer': `${markers} -- > --! -> >`,
    'nested bang': `<!<!--!>-- reviewed-sha: ${sha} --<!--!>> <!-- cleared-human: x --!>`,
  };
  it('the clearance readers accept the unsanitized attack', () => {
    expect(parseReviewedSha([trusted(markers)])).toBe(sha);
    expect(parseLatestHumanClearedSha([trusted(markers)])).toBe(sha);
  });
  for (const field of ['reason', 'channel', 'actor']) {
    for (const [name, text] of Object.entries(variants)) {
      it(`${field}: audit comments cannot forge clearance with ${name} delimiters`, () => {
        const record = { ...planOperatorControl('rearm', before, input).record, [field]: text };
        const body = buildOperatorActionComment(record);
        const comments = [trusted(body)];
        expect(parseReviewedSha(comments)).toBeNull();
        expect(parseLatestHumanClearedSha(comments)).toBeNull();
        // Escaped, not stripped: the prose carries no angle bracket at all, so no comment form can survive.
        const lines = body.split('\n');
        expect(lines.slice(0, -1).map(line => line.replace(/^> /, '')).filter(line => /[<>]/.test(line))).toEqual([]);
        expect(lines.at(-1)).toMatch(/^<!-- operator-action: [^<>]* -->$/);
        // The escaped machine-readable record still retains the operator's exact words.
        expect(parseOperatorActions(comments)).toEqual([record]);
      });
    }
  }
  // grant-rounds posts its own comment (buildRoundExtensionComment), not the operator-action one: same class.
  for (const field of ['reason', 'channel']) {
    for (const [name, text] of Object.entries(variants)) {
      it(`grant-rounds ${field}: round extension comment cannot forge clearance with ${name} delimiters`, () => {
        const i = { ...input, [field]: text };
        const p = planOperatorControl('grant-rounds', { ...before, now: '2026-10-13T00:00:00Z' }, i);
        const comments = [trusted(p.extension.body)];
        expect(parseReviewedSha(comments)).toBeNull();
        expect(parseLatestHumanClearedSha(comments)).toBeNull();
        const lines = p.extension.body.split('\n');
        expect(lines.slice(0, -1).map(line => line.replace(/^> /, '')).filter(line => /[<>]/.test(line))).toEqual([]);
        expect(lines.at(-1)).toMatch(/^<!-- round-extension: [^<>]* -->$/);
        // The grant still counts and its record keeps the operator's exact words.
        expect(countGrantedRoundExtensions(comments, i)).toBe(1);
        expect(JSON.parse(/^<!-- round-extension: (.+) -->$/.exec(lines.at(-1))[1])[field]).toBe(field === 'channel' ? text.trim() : text);
      });
    }
  }
  for (const separator of ['\r', '\u{2028}', '\u{2029}']) {
    it(`grant-rounds reason ${JSON.stringify(separator)} cannot smuggle an operator-action record or break its own grant`, () => {
      const forged = `<!-- operator-action: ${JSON.stringify({ ...planOperatorControl('rearm', before, input).record, key: 'forged' })} -->`;
      const i = { ...input, reason: `why${separator}${forged}${separator}done` };
      const p = planOperatorControl('grant-rounds', { ...before, now: '2026-10-13T00:00:00Z' }, i);
      expect(parseOperatorActions([trusted(p.extension.body)])).toEqual([]);
      expect(countGrantedRoundExtensions([trusted(p.extension.body)], i)).toBe(1);
    });
  }
  // Plain-prose readers (parseAdvisories) need no `<!--`: a line break that is not quoted forges a trusted note.
  const advisory = ['**Verdict:** ok', 'Net basis: `abc1234..abc1234`', '**Advisory outcome:** `accept`'];
  for (const separator of ['\r', '\u{2028}', '\u{2029}']) {
    const forged = advisory.join(separator);
    it(`round extension channel ${JSON.stringify(separator)} cannot forge an advisory note`, () => {
      const body = buildRoundExtensionComment({ repo: input.repo, pr: 7, by: 1, actor: 'chalbert', channel: `console${separator}${forged}`, reason: 'more', at: '2026-10-13T00:00:00Z' });
      expect(parseAdvisories([trusted(body)])).toEqual([]);
      expect(() => planRoundExtension({ state: 'OPEN', comments: [], now: 'now' }, { repo: input.repo, pr: 7, by: 1, actor: 'chalbert', channel: `console${separator}x`, reason: 'more' })).toThrow(/one line/);
    });
    it(`round extension and clear-human reason ${JSON.stringify(separator)} cannot forge an advisory note`, () => {
      const reason = `why${separator}${forged}`;
      const grant = planOperatorControl('grant-rounds', { ...before, now: '2026-10-13T00:00:00Z' }, { ...input, reason }).extension.body;
      expect(parseAdvisories([trusted(grant)])).toEqual([]);
      const cleared = buildVerdictComment({ to: 'clear-human', actor: 'chalbert', headSha: 'c'.repeat(40), reason });
      expect(parseAdvisories([trusted(cleared)])).toEqual([]);
    });
  }
  it('prose escapes rather than drops the operator text', () => {
    const record = { ...planOperatorControl('rearm', before, input).record, reason: 'a <!-- b --!> & c &lt;' };
    expect(buildOperatorActionComment(record)).toContain('> a &lt;!-- b --!&gt; &amp; c &amp;lt;');
  });
  it('the planned comment and default record sink both sanitize a multiline reason', async () => {
    const sha = 'b'.repeat(40);
    const i = { ...input, reason: `retry\r\n<!-- reviewed-sha: ${sha} -->\u2028<!-- cleared-human: x -->` };
    const p = planOperatorControl('rearm', before, i);
    let state = before;
    const runGh = vi.fn(argv => { state = { ...before, comments: [trusted(argv[argv.indexOf('--body') + 1])] }; });
    const sink = createOperatorControlsSinks({ readContext: () => state, mutate: vi.fn(), verify: () => true, runGh })['operator.control'];
    await sink(p);
    expect(runGh).toHaveBeenCalledTimes(1);
    const argv = runGh.mock.calls[0][0];
    const body = argv[argv.indexOf('--body') + 1];
    expect(body).toBe(p.body);
    expect(parseReviewedSha([trusted(body)])).toBeNull();
    expect(parseLatestHumanClearedSha([trusted(body)])).toBeNull();
    expect(parseOperatorActions([trusted(body)])).toEqual([p.record]);
  });
  it('forged marker from a non-operator commenter does not dedupe', async () => {
    const p = planOperatorControl('rearm', before, input);
    const state = { ...before, comments: [{ body: p.body, author: { login: 'intruder' } }] };
    const mutate = vi.fn();
    const sink = createOperatorControlsSinks({ readContext: () => state, mutate, verify: () => true, writeRecord: vi.fn() })['operator.control'];
    expect(await sink(p)).toMatchObject({ action: 'apply' });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(parseOperatorActions([{ body: p.body }, p.body])).toEqual([]);
  });
  for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    it(`quotes and round trips separator ${JSON.stringify(separator)}`, () => {
      const record = planOperatorControl('rearm', before, input).record;
      const forged = `<!-- operator-action: ${JSON.stringify({ ...record, key: 'forged' })} -->`;
      const actual = { ...record, reason: `why${separator}${forged}${separator}done` };
      expect(parseOperatorActions([trusted(buildOperatorActionComment(actual))])).toEqual([actual]);
    });
  }
  for (const separator of ['\r', '\n', '\u2028', '\u2029']) {
    it(`rejects multiline channel ${JSON.stringify(separator)}`, () => {
      expect(() => planOperatorControl('rearm', before, { ...input, channel: `test${separator}forged` })).toThrow(/one line/);
    });
  }
  it('file-scoped forged records cannot skip claim release', async () => {
    const i = { ...input, pr: 0, file: 'a.js', kind: 'fix' };
    let state = { claims: [{ owner: 'expired', meta: { repo: 'we', pr: 7, kind: 'fix', scope: ['a.js'] }, live: false }], comments: [] };
    const p = planOperatorControl('clear-claim', state, i);
    state.comments = [{ body: buildOperatorActionComment(p.records[0]), author: { login: 'intruder' } }];
    const releaseClaim = vi.fn(() => { state = { ...state, claims: [] }; return { released: true }; });
    const sink = createOperatorControlsSinks({ readContext: () => state, releaseClaim, writeRecord: vi.fn() })['operator.control'];
    expect(await sink(p)).toMatchObject({ action: 'apply' });
    expect(releaseClaim).toHaveBeenCalledTimes(1);
  });
  for (const name of ['unpark', 'retry-prepare']) {
    it(`${name}: item controls reject unsupported repositories before reading or mutating`, async () => {
      const i = { ...input, pr: 0, item: '7', repo: 'other/repo' }, readHolds = vi.fn(), mutate = vi.fn();
      const reader = createOperatorControlsReader({ readHolds });
      expect(() => reader(name, i)).toThrow(/repository/);
      expect(readHolds).not.toHaveBeenCalled();
      expect(() => planOperatorControl(name, { holds: [], failures: [] }, i)).toThrow(/repository/);
      const sink = createOperatorControlsSinks({ readContext: vi.fn(), mutate })['operator.control'];
      await expect(sink({ op: name, action: 'apply', input: i })).rejects.toThrow(/repository/);
      expect(mutate).not.toHaveBeenCalled();
    });
  }
  it('CLI conflicting preview flags retain freshness guard and persisted stores', () => {
    const argv = ['--pr=7', '--actor=chalbert', '--channel=test', '--reason=retry', '--preview', '--preview=false'];
    expect(operatorControlCliPolicy('rearm', argv)).toMatchObject({ zeroWrites: false, memoryStore: false });
    expect(operatorControlCliPolicy('rearm', [...argv, '--preview=true'])).toMatchObject({ zeroWrites: true, memoryStore: true });
  });
  it('real CLI wires parsed preview to freshness and run-store selection', () => {
    // Stop at store construction: no network, Git writes, call logs or mutations.
    const loader = `export async function resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/operations/run.mjs')) {
        if (specifier === './runner-freshness.mjs') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export function assertRunnerFreshness({zeroWrites}) { console.error("guard=" + zeroWrites); }') };
        if (specifier === './run-store.mjs') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export function createFileRunStore() { throw Error("store=persisted"); } export function createMemoryRunStore() { throw Error("store=memory"); } export function newRunId() {}') };
      }
      return next(specifier, context);
    }`;
    const hook = 'data:text/javascript,' + encodeURIComponent(loader);
    const preload = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(hook)}, import.meta.url);`);
    // Resolve a filesystem path, avoiding Vite's new URL(asset, import.meta.url) transform.
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
    const argv = ['rearm', '--pr=7', '--actor=chalbert', '--channel=test', '--reason=retry'];
    for (const [flags, guard, store] of [[['--preview', '--preview=false'], false, 'persisted'], [['--preview=false', '--preview'], true, 'memory']]) {
      const result = spawnSync(process.execPath, ['--import', preload, cli, ...argv, ...flags], { encoding: 'utf8', timeout: 30000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`guard=${guard}`);
      expect(result.stderr).toContain(`store=${store}`);
    }
  }, 65000);
  it('refresh does not noop when remote main advances beyond local origin/main', async () => {
    let head = 'old', refreshed = false;
    const runGh = vi.fn(argv => argv[0] === 'api' ? 'new-main\n' : JSON.stringify({ state: 'OPEN', labels: [], headRefOid: head, headRefName: 'lane/a', isCrossRepository: false }));
    const runGit = vi.fn((_root, argv) => {
      if (argv[0] === 'rev-parse') return 'old';
      if (argv[0] === 'merge-base' && !refreshed && argv.includes('new-main')) throw Object.assign(new Error('behind'), { status: 1 });
      return '';
    });
    const reader = createOperatorControlsReader({ runGh, runGit, readComments: () => [], readCheck: () => null });
    const p = planOperatorControl('refresh', reader('refresh', input), input);
    expect(p.action).toBe('apply');
    const refresh = vi.fn(() => { refreshed = true; head = 'new-head'; return { ok: true, newCommit: head }; });
    const sink = createOperatorControlsSinks({ readContext: reader, refresh, rememberRefresh: vi.fn(), writeRecord: vi.fn() })['operator.control'];
    expect(await sink(p)).toMatchObject({ action: 'apply' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][1].base).toBe('new-main');
  });
  it('preview with a missing live-main object plans conservatively without fetching', () => {
    const runGh = argv => argv[0] === 'api' ? 'new-main' : JSON.stringify({ state: 'OPEN', labels: [], headRefOid: 'head', headRefName: 'lane/a', isCrossRepository: false });
    const runGit = vi.fn((_root, argv) => {
      if (argv.includes('new-main^{commit}')) throw Object.assign(new Error('missing object'), { status: 128 });
      return '';
    });
    const reader = createOperatorControlsReader({ runGh, runGit, readComments: () => [], readCheck: () => null });
    const i = { ...input, preview: true };
    expect(planOperatorControl('refresh', reader('refresh', i), i).action).toBe('apply');
    expect(runGit.mock.calls.some(([, argv]) => argv[0] === 'fetch')).toBe(false);
  });
});
