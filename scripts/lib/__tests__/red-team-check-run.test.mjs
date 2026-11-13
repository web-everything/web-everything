// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { readRedTeamGateSource } from '../red-team-check-run.mjs';
import { REVIEW_HOLD_LABELS } from '../review-escalation.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

let lockDir;
beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'red-team-lock-'));
  vi.stubEnv('WE_RED_TEAM_CHECK_LOCK_DIR', lockDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(lockDir, { recursive: true, force: true });
});

describe('redTeamGate.source cutover cascade', () => {
  it.each(['both', 'check-run', 'drain-scan'])('accepts mode %s from the environment', source => {
    expect(readRedTeamGateSource({ env: { WE_RED_TEAM_GATE_SOURCE: source }, tool: {}, platform: {} }))
      .toMatchObject({ value: { source }, sources: { source: 'env' } });
  });
  it('defaults to both and logs an invalid override with its fallback reason', () => {
    const lines = [];
    expect(readRedTeamGateSource({ env: {}, tool: {}, platform: {} }))
      .toMatchObject({ value: { source: 'both' }, sources: { source: 'standard' } });
    expect(readRedTeamGateSource({ env: { WE_RED_TEAM_GATE_SOURCE: 'unsafe' }, tool: {}, platform: {}, log: line => lines.push(line) }))
      .toMatchObject({ value: { source: 'both' }, sources: { source: 'standard' } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/source="both".*standard.*ignored invalid.*unsafe/);
  });
  it('resolves platform then tool then env, ignoring invalid higher layers', () => {
    const layers = { platform: { source: 'drain-scan' }, tool: { redTeamGate: { source: 'both' } } };
    expect(readRedTeamGateSource({ ...layers, env: {} }).sources.source).toBe('tool');
    expect(readRedTeamGateSource({ ...layers, env: { WE_RED_TEAM_GATE_SOURCE: 'check-run' } }).value.source).toBe('check-run');
    expect(readRedTeamGateSource({ platform: layers.platform, tool: {}, env: {} }))
      .toMatchObject({ value: { source: 'drain-scan' }, sources: { source: 'platform' } });
    expect(readRedTeamGateSource({ ...layers, env: { WE_RED_TEAM_GATE_SOURCE: 'invalid' } }).sources.source).toBe('tool');
  });
});

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const APP_ID = 5037855; // WE_APP_ID repository variable
let api;

describe('red-team check run contract', () => {
  beforeAll(async () => { api = await import('../red-team-check-run.mjs'); });
  const run = (over = {}) => ({ id: 10, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7',
    app: { id: APP_ID }, status: 'completed', conclusion: 'success',
    started_at: '2026-11-07T10:00:00Z', ...over });

  describe('publishRedTeamCheckFromLive', () => {
    const resultComment = (rev = HEAD) => ({ author: { login: 'web-everything', type: 'Bot' },
      created_at: '2026-11-07T12:00:00Z',
      body: renderRedTeamComment({ pr: 7, rev, provider: 'codex', model: 'fixture',
        findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }) });
    // Reader contract: live PR object, complete comment array, verified standing-ruling scope.
    // Check history stays behind the injected gh boundary; no test can reach GitHub.
    function fixture() {
      const checkRuns = [run({ conclusion: 'failure', completed_at: '2026-11-07T11:00:00Z' })];
      const io = { repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, env: { WE_RED_TEAM_CHECK_LOCK_DIR: lockDir },
        readLive: vi.fn(() => ({ headRefOid: HEAD, labels: [] })),
        readComments: vi.fn(() => [resultComment()]),
        readStandingRuling: vi.fn(() => null),
        holdFn: vi.fn(() => null),
        gh: vi.fn((args, options) => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
          if (args.includes('POST')) {
            checkRuns.push(run({ ...JSON.parse(options.input), id: 20 }));
            return JSON.stringify({ id: 20 });
          }
          if (args.includes(`repos/o/r/commits/${HEAD}/check-runs?check_name=red-team&filter=all&per_page=100`))
            return JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns });
          throw Error(`unexpected GitHub read: ${JSON.stringify(args)}`);
        }),
      };
      return io;
    }
    const allPosts = io => io.gh.mock.calls.filter(([args]) => args.includes('POST'));
    const posts = io => allPosts(io).filter(([args]) => args.includes('repos/o/r/check-runs'));
    const statusPosts = io => allPosts(io).filter(([args]) => args.includes(`repos/o/r/statuses/${HEAD}`));
    const payloads = io => posts(io).map(([, options]) => JSON.parse(options.input));
    const publish = io => api.publishRedTeamCheckFromLive(io);

    it.each(['', '\n', '\n### Post-accept red team — no break found', '\nrecorded verdict `accept`.'])
    ('refuses an advisory marker without completed review content: %j', async suffix => {
      const io = fixture();
      io.readComments.mockReturnValue([{ ...resultComment(), body: `<!-- we:red-team-advisory pr=7 rev=${HEAD} -->${suffix}` }]);
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(allPosts(io)).toEqual([]);
    });

    it('posts success and re-inspects without reading or writing publication statuses', () => {
      const io = fixture();
      expect(publish(io)).toMatchObject({ ok: true });
      expect(allPosts(io)).toHaveLength(1);
      expect(io.gh.mock.calls.some(([args]) => args[1].includes('/status'))).toBe(false);
      expect(io.readLive).toHaveBeenCalledTimes(2);
    });

    it.each(['helper', 'poster', 'policy-clear'])('%s times out without reads or POSTs while the lock is held', kind => {
      const io = { ...fixture(), lockTimeoutMs: 10 };
      const result = api.withRedTeamCheckLock(io, () => {
        if (kind === 'helper') return publish(io);
        if (kind === 'policy-clear') return api.publishRedTeamPolicyClearCheck(io);
        return api.postRedTeamCheckRun({ ...io, payload: api.redTeamCheckRunPayload({ ...io, status: 'finished', hold: null }) });
      });
      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/lock.*retry|lock.*operator/i) });
      expect(io.gh).not.toHaveBeenCalled();
      expect(io.readLive).not.toHaveBeenCalled();
    });

    it('the last-resort publication hold is NOT behind the check lock and posts while the lock is held', () => {
      const io = { ...fixture(), lockTimeoutMs: 10 };
      const out = api.withRedTeamCheckLock(io, () => api.postRedTeamPublicationHold({ ...io, held: true, reason: 'x' }));
      expect(out).toEqual({ ok: true });
      expect(io.gh).toHaveBeenCalled();
    });

    it.each(['live', 'failure'])('serializes a concurrent %s writer behind the live helper across processes', async secondMode => {
      const statePath = join(lockDir, 'checks.json');
      const eventsPath = join(lockDir, 'events.jsonl');
      writeFileSync(statePath, '[]');
      writeFileSync(eventsPath, '');
      const source = String.raw`
        import * as api from ${JSON.stringify(new URL('../red-team-check-run.mjs', import.meta.url).href)};
        import { withFileLock } from ${JSON.stringify(new URL('../atomic-json-file.mjs', import.meta.url).href)};
        import { renderRedTeamComment } from ${JSON.stringify(new URL('../../operations/review-extra-seats.mjs', import.meta.url).href)};
        import { readFileSync, writeFileSync, appendFileSync, unlinkSync, readSync } from 'node:fs';
        const [mode, first, statePath, eventsPath] = process.argv.slice(1);
        const headSha = ${JSON.stringify(HEAD)};
        const event = value => appendFileSync(eventsPath, JSON.stringify({ mode, first, ...value }) + '\n');
        const io = { repo: 'o/r', pr: 7, headSha, appId: ${APP_ID}, lockTimeoutMs: 5000,
          lock: (path, fn, options) => {
            process.stdout.write('attempting\n');
            return withFileLock(path, () => {
              // Independent O_EXCL observer: overlapping callbacks fail even if both POSTs succeed.
              const active = path + '.active';
              writeFileSync(active, '', { flag: 'wx' });
              event({ phase: 'enter' });
              process.stdout.write('entered\n');
              try {
                if (first === 'yes') readSync(0, Buffer.alloc(1), 0, 1, null);
                return fn();
              } finally { event({ phase: 'exit' }); unlinkSync(active); }
            }, options);
          },
          readLive: () => ({ headRefOid: headSha, labels: [] }),
          readComments: () => [{ author: { login: 'web-everything', type: 'Bot' },
            created_at: '2026-11-07T12:00:00Z',
            body: renderRedTeamComment({ pr: 7, rev: headSha, provider: 'codex', model: 'fixture',
              findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }) }],
          readStandingRuling: () => null, holdFn: () => null,
          gh: (args, options) => {
            const runs = JSON.parse(readFileSync(statePath, 'utf8'));
            if (!args.includes('POST')) {
              event({ phase: 'read', count: runs.length });
              return JSON.stringify({ total_count: runs.length, check_runs: runs });
            }
            const payload = JSON.parse(options.input);
            if (args[1] !== 'repos/o/r/check-runs') throw Error('unexpected status write');
            const run = { ...payload, id: runs.length + 1, app: { id: ${APP_ID} },
              completed_at: '2026-11-07T13:00:00Z' };
            runs.push(run);
            writeFileSync(statePath, JSON.stringify(runs));
            return JSON.stringify(run);
          },
        };
        const out = mode === 'live' ? api.publishRedTeamCheckFromLive(io)
          : api.postRedTeamCheckRun({ ...io, payload: api.redTeamCheckRunPayload({ ...io,
              status: 'finished', hold: 'another path found a break' }) });
        process.stdout.write(JSON.stringify(out) + '\n');
        if (!out.ok) process.exitCode = 1;
      `;
      const children = [];
      function launch(mode, first) {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source, mode, first, statePath, eventsPath],
          { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
        children.push(child);
        let output = '', errors = '';
        const signals = new Map();
        const signal = line => {
          if (!signals.has(line)) {
            let resolve;
            const promise = new Promise(done => { resolve = done; });
            signals.set(line, { promise, resolve });
          }
          return signals.get(line);
        };
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.length > 65536) child.kill();
          for (const line of output.split('\n').slice(0, -1)) signal(line).resolve();
        });
        child.stderr.on('data', chunk => { errors += chunk; if (errors.length > 65536) child.kill(); });
        const done = new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolve(output) : reject(Error(errors + output)));
        });
        // Observe failures immediately even while awaiting a synchronization signal.
        done.catch(() => {});
        return { child, done, wait: line => Promise.race([signal(line).promise, done.then(() => { throw Error('child exited before ' + line); })]) };
      }
      const timeout = setTimeout(() => children.forEach(child => child.kill()), 12000);
      try {
        const first = launch('live', 'yes');
        await first.wait('entered');
        const second = launch(secondMode, 'no');
        await second.wait('attempting');
        first.child.stdin.end('x');
        await Promise.all([first.done, second.done]);
        const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(events.filter(e => ['enter', 'exit'].includes(e.phase)).map(e => [e.first, e.phase]))
          .toEqual([['yes', 'enter'], ['yes', 'exit'], ['no', 'enter'], ['no', 'exit']]);
        if (secondMode === 'live') expect(events.find(e => e.first === 'no' && e.phase === 'read').count).toBe(1);
        // A second live writer, serialized behind the first, re-validates and settles on the first's confirmed success
        // (#6606 red team on c639d9ba108e: a success per attempt exhausts the check history); a failure writer posts.
        expect(JSON.parse(readFileSync(statePath, 'utf8')).map(run => run.conclusion))
          .toEqual(secondMode === 'live' ? ['success'] : ['success', 'failure']);
      } finally {
        clearTimeout(timeout);
        children.forEach(child => child.kill());
      }
    }, 15000);

    it.each([{ pr: 8 }, { headSha: OLD_HEAD }, { repo: 'o/other' }])('different identities do not contend: %j', identity => {
      const io = fixture();
      expect(api.withRedTeamCheckLock(io, () => api.withRedTeamCheckLock({ ...io, ...identity, lockTimeoutMs: 0 },
        () => ({ ok: true })))).toEqual({ ok: true });
    });

    it('uses a private recursive directory and a SHA-256 identity filename', () => {
      const dir = join(lockDir, 'nested', 'locks');
      let observed;
      const io = { ...fixture(), env: { WE_RED_TEAM_CHECK_LOCK_DIR: dir }, lock: (path, fn, options) => {
        observed = { path, options };
        return fn();
      } };
      expect(api.withRedTeamCheckLock(io, () => ({ ok: true }))).toEqual({ ok: true });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(observed.path).toBe(join(dir, createHash('sha256').update(`o/r#7@${HEAD}`).digest('hex') + '.lock'));
      expect(observed.options.timeoutMs).toBe(3000);
    });

    it('directory creation errors fail closed before publication', () => {
      const dir = join(lockDir, 'not-a-directory');
      writeFileSync(dir, 'blocked');
      const io = { ...fixture(), env: { WE_RED_TEAM_CHECK_LOCK_DIR: join(dir, 'locks') } };
      expect(publish(io)).toMatchObject({ ok: false, reason: expect.stringMatching(/lock.*operator/i) });
      expect(io.gh).not.toHaveBeenCalled();
    });

    it.each(['helper', 'poster', 'policy-clear'])('%s fails closed on lock errors', kind => {
      const io = { ...fixture(), lock: () => { throw Error('permission denied'); } };
      const out = kind === 'helper' ? publish(io) : kind === 'poster' ? api.postRedTeamCheckRun(io)
        : api.publishRedTeamPolicyClearCheck(io);
      expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('permission denied') });
      expect(io.gh).not.toHaveBeenCalled();
    });

    it.each([[null, 'in_progress'], [null, 'completed'], [10, 'in_progress'], [10, 'completed']])
    ('detects a run hidden between the pre-read (%s) and our success (status=%s)', async (beforeId, status) => {
        const intervening = run({ id: 15, status, conclusion: status === 'completed' ? 'success' : null });
        const io = fixture();
        let posted = false;
        const prior = beforeId === null ? [] : [run({ id: beforeId })];
        io.gh.mockImplementation(args => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
          if (args.includes('POST')) { posted = true; return JSON.stringify({ id: 20 }); }
          const check_runs = posted ? [...prior, intervening, run({ id: 20 })] : prior;
          return JSON.stringify({ total_count: check_runs.length, check_runs });
        });
        expect(await publish(io)).toMatchObject({ ok: false, reason: expect.stringMatching(/raced publication/) });
        expect(payloads(io).map(payload => payload.conclusion)).toEqual(['success', 'failure']);
    });

    it.each([null, 10])('accepts exactly the pre-read runs (%s) followed by our success', async beforeId => {
      const io = fixture();
      let posted = false;
      const prior = beforeId === null ? [] : [run({ id: beforeId })];
      io.gh.mockImplementation(args => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
        if (args.includes('POST')) { posted = true; return JSON.stringify({ id: 20 }); }
        const check_runs = posted ? [...prior, run({ id: 20 })] : prior;
        return JSON.stringify({ total_count: check_runs.length, check_runs });
      });
      expect(await publish(io)).toMatchObject({ ok: true });
      expect(payloads(io).map(payload => payload.conclusion)).toEqual(['success']);
    });

    it.each([
      '1. [**confirmed**] edge-case broken — missing parenthesised class.',
      '   1. [**confirmed**] (edge-case, broken) `a.mjs:1` — indented finding.',
      '1. [**CONFIRMED**] (edge-case, broken) `a.mjs:1` — wrong case.',
      '1. [not confirmed] malformed advisory finding.',
      '1. [unverifiable] malformed evidence.',
    ])('refuses unparsed finding evidence despite a clear enqueue hold: %s', async line => {
      const io = fixture();
      const comment = resultComment();
      io.readComments.mockReturnValue([{ ...comment, body: `${comment.body}\n${line}` }]);
      expect(await publish(io)).toMatchObject({ ok: false,
        reason: expect.stringMatching(/unparsed|malformed/i) });
      expect(posts(io)).toEqual([]);
    });

    it.each(['supersede-succeeds', 'supersede-fails', 'both-fail'])
    ('a lost success response attempts failure supersession and falls back to a hold: %s', async mode => {
      const io = fixture();
      const baseGh = io.gh.getMockImplementation();
      io.gh.mockImplementation((args, options) => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) {
          if (mode === 'both-fail') throw Error('hold response timed out');
          return '{}';
        }
        if (!args.includes('POST')) return baseGh(args, options);
        const payload = JSON.parse(options.input);
        if (payload.conclusion === 'success') throw Error('success response timed out');
        if (payload.conclusion === 'failure') {
          if (mode !== 'supersede-succeeds') throw Error('failure response timed out');
          return JSON.stringify({ id: 21 });
        }
        if (mode === 'both-fail') throw Error('hold response timed out');
        return '{}';
      });
      const out = await publish(io);
      expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('success response timed out') });
      expect(payloads(io).slice(0, 2).map(payload => payload.conclusion)).toEqual(['success', 'failure']);
      expect(posts(io).slice(0, 2).map(([args]) => args[1])).toEqual(['repos/o/r/check-runs', 'repos/o/r/check-runs']);
      if (mode === 'supersede-succeeds') expect(posts(io)).toHaveLength(2);
      else {
        expect(posts(io)).toHaveLength(2);
        expect(statusPosts(io)).toHaveLength(1);
        expect(statusPosts(io)[0][0]).toContain(`repos/o/r/statuses/${HEAD}`);
        expect(JSON.parse(statusPosts(io).at(-1)[1].input)).toMatchObject({ state: 'failure', context: 'red-team/publication #7',
          description: expect.stringMatching(/^held:/) });
        expect(out.reason).toContain('failure response timed out');
        if (mode === 'both-fail') expect(out.reason).toContain('hold response timed out');
      }
    });

    it.each([
      ['older result', '2026-11-07T09:00:00Z', '2026-11-07T11:00:00Z', '2026-11-07T08:00:00Z', false],
      ['newer result', '2026-11-07T12:00:00Z', '2026-11-07T11:00:00Z', '2026-11-07T08:00:00Z', true],
      ['equal timestamps', '2026-11-07T11:00:00Z', '2026-11-07T11:00:00Z', undefined, false],
      ['missing result timestamp', undefined, '2026-11-07T11:00:00Z', undefined, false],
      ['invalid result timestamp', 'unreadable', '2026-11-07T11:00:00Z', undefined, false],
      ['missing run timestamps', '2026-11-07T12:00:00Z', undefined, undefined, false],
      ['invalid completion timestamp', '2026-11-07T12:00:00Z', 'unreadable', '2026-11-07T08:00:00Z', false],
      ['missing completed_at despite an earlier started_at', '2026-11-07T12:00:00Z', undefined, '2026-11-07T11:00:00Z', false],
    ])('requires a demonstrably newer trusted result before replacing failure: %s', async (_name, created_at, completed_at, started_at, ok) => {
      const io = fixture();
      io.readComments.mockReturnValue([{ ...resultComment(), created_at }]);
      const check_runs = [run({ conclusion: 'failure', completed_at, started_at })];
      io.gh.mockImplementation((args, options) => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
        if (args.includes('POST')) {
          check_runs.push(run({ ...JSON.parse(options.input), id: 20 }));
          return JSON.stringify({ id: 20 });
        }
        return JSON.stringify({ total_count: check_runs.length, check_runs });
      });
      expect(await publish(io)).toMatchObject({ ok });
      expect(payloads(io).map(payload => payload.conclusion)).toEqual(ok ? ['success'] : []);
    });

    it('a newer untrusted or other-head result cannot date an older trusted live-head result', async () => {
      const io = fixture();
      io.readComments.mockReturnValue([
        { ...resultComment(), created_at: '2026-11-07T09:00:00Z' },
        { ...resultComment(), author: { login: 'outsider' } }, resultComment(OLD_HEAD),
      ]);
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    // A verdict carry posts ONE comment: carried marker, prose, then the re-keyed result. The clock evidence must
    // read the same carried record the disposition reader recognises, or a valid carry can never clear a failure.
    const carryComment = (created_at, author = { login: 'web-everything', type: 'Bot' }) => ({ author, created_at,
      body: [`<!-- review-verdict-carried from=${OLD_HEAD} to=${HEAD} patch-id=${'c'.repeat(40)} -->`,
        'Review verdict carried across an identical contribution.', resultComment().body].join('\n') });
    it.each([
      ['a trusted carry newer than the failed check publishes', '2026-11-07T12:00:00Z', undefined, true],
      ['a trusted carry older than the failed check refuses', '2026-11-07T10:00:00Z', undefined, false],
      ['a carry with an unreadable time refuses', 'not-a-date', undefined, false],
      ['an untrusted newer carry refuses', '2026-11-07T12:00:00Z', { login: 'outsider' }, false],
    ])('%s', async (_, created_at, author, ok) => {
      const io = fixture();
      io.readComments.mockReturnValue([carryComment(created_at, author)]);
      expect(await publish(io)).toMatchObject({ ok });
      expect(payloads(io).map(payload => payload.conclusion)).toEqual(ok ? ['success'] : []);
    });

    // #6606 red team (round 5): a carried policy-clear result (the skip settlement's marker plus one "not required"
    // line) carries no review verdict, yet it is a complete result. It must publish its check, or the carried head
    // stays blocked and every recovery retry refuses the same way. Bodies are built the way the producers build them.
    describe('carried policy-clear results', () => {
      const clearBody = (rev = HEAD, reason = 'not owed (stored review)') =>
        `<!-- we:red-team-advisory pr=7 rev=${rev} -->\n\nRed team not required on this head: ${reason}`;
      // review-job's carry: carried marker, prose, then the source head's body re-keyed to the carried-to head.
      const carriedClear = (advisory = clearBody(OLD_HEAD), created_at = '2026-11-07T12:00:00Z') => ({
        author: { login: 'web-everything', type: 'Bot' }, created_at,
        body: [`<!-- review-verdict-carried from=${OLD_HEAD} to=${HEAD} patch-id=${'c'.repeat(40)} -->`,
          'Review verdict carried across an identical contribution.',
          advisory.replace(`rev=${OLD_HEAD}`, `rev=${HEAD}`)].join('\n') });
      it.each([
        ['a carried policy-clear publishes', () => [carriedClear()]],
        ['a carried card-only policy-clear publishes', () => [carriedClear(clearBody(OLD_HEAD, 'card-only diff (policy redTeam.skipCardOnly)'))]],
        ['a direct policy-clear on the head publishes', () => [{ ...carriedClear(), body: clearBody() }]],
      ])('%s, with the real hold reader', async (_, comments) => {
        const io = fixture();
        io.holdFn = redTeamEnqueueHold;
        io.readComments.mockReturnValue(comments());
        expect(await publish(io)).toMatchObject({ ok: true });
        expect(payloads(io).map(payload => payload.conclusion)).toEqual(['success']);
      });
      it.each([
        ['extra prose after the reason', `${clearBody(OLD_HEAD)}\nAnd one more line.`],
        ['an empty reason', clearBody(OLD_HEAD, '')],
        ['a whitespace-only reason', clearBody(OLD_HEAD, '\t ')],
        ['a line separator in the reason', clearBody(OLD_HEAD, `not owed${String.fromCodePoint(0x2028)}Second line`)],
        ['a paragraph separator in the reason', clearBody(OLD_HEAD, `not owed${String.fromCodePoint(0x2029)}Second line`)],
        ['a lone CR in the reason', clearBody(OLD_HEAD, 'not owed\rSecond line')],
        ['a control character in the reason', clearBody(OLD_HEAD, 'not owed\u001b[2J')],
        ['a finding beside the reason', `${clearBody(OLD_HEAD)}\n1. [**confirmed**] (failing-input, broken) \`x.mjs:1\` — breaks`],
        ['a finding-shaped line beside the reason', `${clearBody(OLD_HEAD)}\n 1. [confirmed] x`],
        ['the reason line without its prefix', `<!-- we:red-team-advisory pr=7 rev=${OLD_HEAD} -->\n\nnot owed (stored review)`],
        ['an upper-case marker', clearBody(OLD_HEAD).replace('<!-- we:red-team-advisory', '<!-- WE:RED-TEAM-ADVISORY')],
      ])('refuses a carried policy-clear with %s', async (_, advisory) => {
        const io = fixture();
        io.readComments.mockReturnValue([carriedClear(advisory)]);
        expect(await publish(io)).toMatchObject({ ok: false });
        expect(posts(io)).toEqual([]);
      });
      it('a carried policy-clear older than the failed check still refuses', async () => {
        const io = fixture();
        io.readComments.mockReturnValue([carriedClear(clearBody(OLD_HEAD), '2026-11-07T10:00:00Z')]);
        expect(await publish(io)).toMatchObject({ ok: false });
        expect(posts(io)).toEqual([]);
      });
      it('a carried policy-clear from an untrusted author refuses', async () => {
        const io = fixture();
        io.readComments.mockReturnValue([{ ...carriedClear(), author: { login: 'outsider' } }]);
        expect(await publish(io)).toMatchObject({ ok: false });
        expect(posts(io)).toEqual([]);
      });
    });

    it('a newer carry whose gate line names another head is not a carry and cannot date the live result', async () => {
      const io = fixture();
      const forged = { ...carryComment('2026-11-07T12:00:00Z'),
        body: `<!-- we:red-team-gate pr=7 rev=${OLD_HEAD} outcome=no-send-back -->\n${carryComment('x').body}` };
      io.readComments.mockReturnValue([{ ...resultComment(), created_at: '2026-11-07T10:00:00Z' }, forged]);
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    it('a newer carry to another head cannot date an older live-head result', async () => {
      const io = fixture();
      const otherHead = { ...carryComment('2026-11-07T12:00:00Z'),
        body: carryComment('x').body.replaceAll(HEAD, OLD_HEAD).replace(`from=${OLD_HEAD}`, `from=${'d'.repeat(40)}`) };
      io.readComments.mockReturnValue([{ ...resultComment(), created_at: '2026-11-07T10:00:00Z' }, otherHead]);
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    // #6606 red team: a transient verification failure makes the helper supersede its own success. That failure is
    // newer than the carry, but it is the helper's own publication record, not a round's: a retry with restored reads
    // must republish. A round's failure newer than the carry must still refuse, wherever it sits.
    describe('retry after the helper superseded its own success', () => {
      const LIVE_FAIL = { status: 'finished', hold: 'live red-team check not clear: gh pr view timed out' };
      function retryFixture(initial = []) {
        const io = fixture();
        io.readComments.mockReturnValue([carryComment('2026-11-07T12:00:00Z')]);
        const check_runs = [...initial];
        let nextId = 40;
        io.gh.mockImplementation((args, options) => {
          if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
          if (args.includes('POST')) {
            const id = nextId++;
            check_runs.push(run({ ...JSON.parse(options.input), id, completed_at: '2026-11-07T13:00:00Z' }));
            return JSON.stringify({ id });
          }
          return JSON.stringify({ total_count: check_runs.length, check_runs });
        });
        let reads = 0;
        io.readLive.mockImplementation(() => {
          if (++reads === 2) throw Error('gh pr view timed out');
          return { headRefOid: HEAD, labels: [] };
        });
        return { io, check_runs };
      }
      const ownFailure = (id, completed_at = '2026-11-07T13:00:00Z') => run({ id, completed_at,
        ...api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, ...LIVE_FAIL, liveCheck: true }) });
      const fact = runs => api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: runs });

      it('a retry with restored reads republishes success over the helper\'s own failure', () => {
        const { io, check_runs } = retryFixture();
        expect(publish(io)).toMatchObject({ ok: false, reason: expect.stringMatching(/timed out/) });
        expect(check_runs.map(r => r.conclusion)).toEqual(['success', 'failure']);
        expect(fact(check_runs)).toMatchObject({ ok: false });
        expect(publish(io)).toMatchObject({ ok: true });
        expect(check_runs.map(r => r.conclusion)).toEqual(['success', 'failure', 'success']);
        expect(fact(check_runs)).toMatchObject({ ok: true });
      });
      it('the helper\'s success and supersede are both marked as its own, and no round writer\'s payload is', () => {
        const { io, check_runs } = retryFixture();
        publish(io);
        expect(check_runs.map(api.isLiveCheckRun)).toEqual([true, true]);
        for (const payload of [api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: 'break' }),
          api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null }),
          api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null, sendBack: true }),
          api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'in_progress', hold: null, liveCheck: true }),
          api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: 'x', policyClear: true })])
          expect(api.isLiveCheckRun(payload)).toBe(false);
      });
      // Self-review of this fix: a round's final failure created after the first read but before the success POST gets
      // a LOWER id than that unverified success. The retry must not treat its own success as evidence over it.
      it('a retry never lets its own unverified success hide a round failure that raced the first attempt', () => {
        const { io, check_runs } = retryFixture();
        const baseGh = io.gh.getMockImplementation();
        let raced = false;
        io.gh.mockImplementation((args, options) => {
          if (args.includes('POST') && !raced) {
            raced = true;
            check_runs.push(run({ id: 30, conclusion: 'failure', completed_at: '2026-11-07T12:30:00Z' }));
          }
          return baseGh(args, options);
        });
        io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [] }));
        // The after-read refuses (the raced failure is newer than the carry) and supersedes the success.
        expect(publish(io)).toMatchObject({ ok: false, reason: expect.stringMatching(/not demonstrably newer|raced publication/) });
        expect(check_runs.map(r => `${r.id}:${r.conclusion}`)).toEqual(['30:failure', '40:success', '41:failure']);
        expect(publish(io)).toMatchObject({ ok: false, reason: expect.stringMatching(/not demonstrably newer/) });
        expect(check_runs).toHaveLength(3);
        expect(fact(check_runs)).toMatchObject({ ok: false });
      });
      it.each([
        ['a round failure newer than the carry, after the helper\'s failure', () => [run({ id: 20 }), ownFailure(21),
          run({ id: 22, conclusion: 'failure', completed_at: '2026-11-07T14:00:00Z' })]],
        ['a round failure newer than the carry, behind the helper\'s failure', () => [run({ id: 20 }),
          run({ id: 21, conclusion: 'failure', completed_at: '2026-11-07T12:30:00Z' }), ownFailure(22)]],
        ['a round still in progress behind the helper\'s failure', () => [run({ id: 20 }),
          run({ id: 21, status: 'in_progress', conclusion: null }), ownFailure(22)]],
        ['a round failure newer than the carry, under the helper\'s own success and failure', () => [
          run({ id: 20, conclusion: 'failure', completed_at: '2026-11-07T12:30:00Z' }),
          run({ id: 21, completed_at: '2026-11-07T13:00:00Z',
            ...api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null, liveCheck: true }) }),
          ownFailure(22)]],
        ['a round-writer failure with the same summary but no supersede marker', () => [run({ id: 20 }), run({ id: 21,
          completed_at: '2026-11-07T13:00:00Z', ...api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, ...LIVE_FAIL }) })]],
      ])('still refuses: %s', (_name, build) => {
        const initial = build();
        const { io, check_runs } = retryFixture(initial);
        io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [] }));
        expect(publish(io)).toMatchObject({ ok: false });
        expect(check_runs).toHaveLength(initial.length);
      });
      // Red team on c639d9ba108e: the recovery pass retries an unsettled carry once per cooldown, uncapped. A retry
      // whose newest run is this helper's own confirmed success re-validates and settles on it, posting nothing.
      it('a retry over its own newest success re-validates and settles without posting another check', () => {
        const { io, check_runs } = retryFixture();
        io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [] }));
        const onConfirmed = vi.fn(() => ({ ok: false, reason: 'publication hold not cleared' }));
        for (let attempt = 0; attempt < 5; attempt++)
          expect(publish({ ...io, onConfirmed })).toMatchObject({ ok: true, settled: { ok: false } });
        expect(check_runs.map(r => `${r.id}:${r.conclusion}`)).toEqual(['40:success']);
        expect(onConfirmed).toHaveBeenCalledTimes(5);
        expect(fact(check_runs)).toMatchObject({ ok: true });
      });
      it.each([
        ['the live evidence is now held', io => io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [{ name: 'red-team:pending' }] }))],
        ['the head moved', io => io.readLive.mockImplementation(() => ({ headRefOid: 'f'.repeat(40), labels: [] }))],
        ['the trusted result is gone', io => io.readComments.mockReturnValue([])],
      ])('a retry over its own newest success still refuses (and posts nothing) when %s', (_name, change) => {
        const { io, check_runs } = retryFixture();
        io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [] }));
        expect(publish(io)).toMatchObject({ ok: true });
        change(io);
        const onConfirmed = vi.fn();
        expect(publish({ ...io, onConfirmed })).toMatchObject({ ok: false });
        expect(onConfirmed).not.toHaveBeenCalled();
        expect(check_runs).toHaveLength(1);
      });
      it('a round run newer than the helper\'s own success is not reused: a fresh success is posted over it', () => {
        const { io, check_runs } = retryFixture();
        io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [] }));
        expect(publish(io)).toMatchObject({ ok: true });
        // A round writer's success lands after the helper's (GitHub ids only grow, so it takes the next id).
        io.gh(['api', 'repos/o/r/check-runs', '--method', 'POST'],
          { input: JSON.stringify(api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null })) });
        expect(publish(io)).toMatchObject({ ok: true });
        expect(check_runs.map(r => `${r.id}:${api.isLiveCheckRun(r)}`)).toEqual(['40:true', '41:false', '42:true']);
      });
      it.each([
        ['its own trusted hold is cleared', { description: 'held: live red-team check not clear: x', login: 'web-everything' }, true, true],
        ['an untrusted look-alike hold is left', { description: 'held: live red-team check not clear: x', login: 'outsider' }, true, false],
        ['a round writer\'s hold is left', { description: 'held: finished round not confirmed published', login: 'web-everything' }, true, false],
        ['an unreadable history is not ok', null, false, false],
      ])('clearLivePublicationHold: %s', (_name, newest, ok, cleared) => {
        const gh = vi.fn(args => {
          if (args.includes('POST')) return '{}';
          if (!newest) throw Error('HTTP 502');
          const history = [{ id: 5, state: 'failure', context: 'red-team/publication #7', description: newest.description,
            creator: { login: newest.login } }, { id: 4, state: 'failure', context: 'red-team/publication #8' }];
          if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 2, statuses: history.map(({ context, state }) => ({ context, state })) });
          return JSON.stringify(history);
        });
        expect(api.clearLivePublicationHold({ repo: 'o/r', pr: 7, headSha: HEAD, gh })).toMatchObject({ ok, ...(ok ? { cleared } : {}) });
        expect(gh.mock.calls.filter(([args]) => args.includes('POST'))).toHaveLength(cleared ? 1 : 0);
      });
      // Red-team break on c639d9ba108e: 100 unrelated statuses on the head, no publication context. The combined
      // summary proves the context absent, so the clearer settles (ok, nothing posted) instead of failing on the full
      // history page and keeping the retry marker forever.
      it('clearLivePublicationHold: a full page of unrelated statuses with the context absent is settled, not unreadable', () => {
        const unrelated = Array.from({ length: 100 }, (_, i) => ({ id: 1000 - i, state: 'success', context: 'ci/build', creator: { login: 'x' } }));
        const gh = vi.fn(args => {
          if (args.includes('POST')) return '{}';
          if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 1, statuses: [{ context: 'ci/build', state: 'success' }] });
          return JSON.stringify(unrelated);
        });
        expect(api.clearLivePublicationHold({ repo: 'o/r', pr: 7, headSha: HEAD, gh })).toMatchObject({ ok: true, cleared: false });
        expect(gh.mock.calls.filter(([args]) => args.includes('POST'))).toHaveLength(0);
      });
      // Self-review variant: the context exists but its entries sit behind 100+ newer unrelated statuses; the history is
      // paged until the newest trusted success, so the helper's own hold is still found and cleared.
      it.each([
        ['behind one full page', 100],
        ['behind three full pages', 250],
      ])('clearLivePublicationHold: the context %s of unrelated statuses is still read', (_name, newer) => {
        const ctx = 'red-team/publication #7';
        const history = [
          ...Array.from({ length: newer }, (_, i) => ({ id: 10_000 - i, state: 'success', context: 'ci/build' })),
          { id: 50, state: 'failure', context: ctx, description: 'held: live red-team check not clear: x', creator: { login: 'web-everything' } },
          { id: 40, state: 'success', context: ctx, creator: { login: 'web-everything' } },
          ...Array.from({ length: 120 }, (_, i) => ({ id: 38 - i, state: 'success', context: 'old' })),
        ];
        const gh = vi.fn(args => {
          if (args.includes('POST')) return '{}';
          if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 2, statuses: [{ context: 'ci/build', state: 'success' }, { context: ctx, state: 'failure' }] });
          const page = Number(/[?&]page=(\d+)/.exec(args[1])?.[1] ?? 1);
          return JSON.stringify(history.slice((page - 1) * 100, page * 100));
        });
        expect(api.clearLivePublicationHold({ repo: 'o/r', pr: 7, headSha: HEAD, gh })).toMatchObject({ ok: true, cleared: true });
        // It stops at the page holding the trusted success, never reading the older pages.
        const pages = gh.mock.calls.filter(([args]) => /\/statuses\?/.test(args[1])).length;
        expect(pages).toBe(Math.floor((newer + 1) / 100) + 1);
      });
      it('clearLivePublicationHold: a context still undecided at the page cap fails closed (marker kept, nothing posted)', () => {
        const gh = vi.fn(args => {
          if (args.includes('POST')) return '{}';
          if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 1, statuses: [{ context: 'red-team/publication #7', state: 'failure' }] });
          const page = Number(/[?&]page=(\d+)/.exec(args[1])?.[1] ?? 1);
          return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: 100_000 - page * 100 - i, state: 'success', context: 'ci/build' })));
        });
        expect(api.clearLivePublicationHold({ repo: 'o/r', pr: 7, headSha: HEAD, gh })).toMatchObject({ ok: false, reason: expect.stringMatching(/10-page bound/) });
        expect(gh.mock.calls.filter(([args]) => /\/statuses\?/.test(args[1]))).toHaveLength(api.STATUS_PAGE_CAP);
        expect(gh.mock.calls.filter(([args]) => args.includes('POST'))).toHaveLength(0);
      });
      it('clearLivePublicationHold: more than 100 contexts are paged, so an absent context still settles', () => {
        const contexts = Array.from({ length: 150 }, (_, i) => ({ context: `ci/${i}`, state: 'success' }));
        const gh = vi.fn(args => {
          if (args.includes('POST')) return '{}';
          if (/\/status\?/.test(args[1])) {
            const page = Number(/[?&]page=(\d+)/.exec(args[1])?.[1] ?? 1);
            return JSON.stringify({ total_count: 150, statuses: contexts.slice((page - 1) * 100, page * 100) });
          }
          return '[]';
        });
        expect(api.clearLivePublicationHold({ repo: 'o/r', pr: 7, headSha: HEAD, gh })).toMatchObject({ ok: true, cleared: false });
        expect(gh.mock.calls.map(([args]) => args[1]).filter(p => /\/status\?/.test(p))).toEqual([
          `repos/o/r/commits/${HEAD}/status?per_page=100`, `repos/o/r/commits/${HEAD}/status?per_page=100&page=2`]);
      });
      it('clearLivePublicationHold: a summarized context missing from a complete history fails closed', () => {
        const gh = vi.fn(args => {
          if (args.includes('POST')) return '{}';
          if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 1, statuses: [{ context: 'red-team/publication #7', state: 'failure' }] });
          return JSON.stringify([{ id: 1, state: 'success', context: 'ci/build' }]);
        });
        expect(api.clearLivePublicationHold({ repo: 'o/r', pr: 7, headSha: HEAD, gh })).toMatchObject({ ok: false, reason: expect.stringMatching(/lacks the summarized/) });
        expect(gh.mock.calls.filter(([args]) => args.includes('POST'))).toHaveLength(0);
      });
      it.each([
        ['an incomplete combined summary', { total_count: 101, statuses: [{ context: 'ci/build', state: 'success' }] }],
        ['a malformed combined summary', { statuses: 'x' }],
      ])('clearLivePublicationHold: %s fails closed', (_name, combined) => {
        const gh = vi.fn(args => {
          if (args.includes('POST')) return '{}';
          if (/\/status\?/.test(args[1])) return JSON.stringify(combined);
          return '[]';
        });
        expect(api.clearLivePublicationHold({ repo: 'o/r', pr: 7, headSha: HEAD, gh })).toMatchObject({ ok: false });
        expect(gh.mock.calls.filter(([args]) => args.includes('POST'))).toHaveLength(0);
      });
      it('only the helper\'s own failures over an older round failure: the round failure still dates the carry', () => {
        const older = [run({ id: 20, conclusion: 'failure', completed_at: '2026-11-07T11:00:00Z' }), ownFailure(21)];
        const { io } = retryFixture(older);
        io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [] }));
        expect(publish(io)).toMatchObject({ ok: true });
        const newer = [run({ id: 20, conclusion: 'failure', completed_at: '2026-11-07T12:30:00Z' }), ownFailure(21)];
        const again = retryFixture(newer);
        again.io.readLive.mockImplementation(() => ({ headRefOid: HEAD, labels: [] }));
        expect(publish(again.io)).toMatchObject({ ok: false, reason: expect.stringMatching(/not demonstrably newer/) });
      });
    });

    it.each([false, true])('failed failure supersede posts a second-channel hold and never throws (hold fails=%s)', async holdFails => {
      const io = fixture();
      const baseGh = io.gh.getMockImplementation();
      let posted = false;
      io.gh.mockImplementation((args, options) => {
        if (!args.includes('POST')) return baseGh(args, options);

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) {
          if (holdFails) throw Error('status write denied');
          return '{}';
        }
        if (posted) throw Error('supersede write denied');
        posted = true;
        return JSON.stringify({ id: 20 });
      });
      io.readLive.mockImplementation(() => ({ headRefOid: HEAD,
        labels: posted ? ['red-team:blocked'] : [] }));
      const out = await publish(io);
      expect(out).toMatchObject({ ok: false });
      expect(out.reason).toMatch(/red-team:blocked/);
      expect(out.reason).toMatch(/supersede write denied/);
      if (holdFails) expect(out.reason).toMatch(/status write denied/);
      expect(posts(io).map(([args]) => args[1])).toEqual([
        'repos/o/r/check-runs', 'repos/o/r/check-runs',
      ]);
      expect(JSON.parse(statusPosts(io).at(-1)[1].input)).toMatchObject({ state: 'failure', context: 'red-team/publication #7',
        description: expect.stringMatching(/^held:/) });
    });

    it('posts exactly one head-bound success after reading live evidence and consulting the recorded-result hold', async () => {
      const io = fixture();
      const comments = [resultComment()];
      const standingRuling = { scope: 'verified-fixture' };
      io.readComments.mockReturnValue(comments);
      io.readStandingRuling.mockReturnValue(standingRuling);
      expect(await publish(io)).toMatchObject({ ok: true });
      expect(posts(io)).toHaveLength(1);
      expect(posts(io)[0][0]).toContain('repos/o/r/check-runs');
      expect(payloads(io)[0]).toMatchObject({ name: 'red-team', head_sha: HEAD,
        external_id: 'o/r#7', status: 'completed', conclusion: 'success' });
      expect(io.readLive.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(io.readComments.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(io.readStandingRuling).toHaveBeenCalled();
      expect(io.holdFn).toHaveBeenCalledWith(expect.objectContaining({ repo: 'o/r', pr: 7,
        head: HEAD, comments, recorded: true, standingRuling }));
      for (const reader of [io.readLive, io.readComments, io.readStandingRuling, io.holdFn])
        expect(reader.mock.invocationCallOrder[0]).toBeLessThan(io.gh.mock.invocationCallOrder[io.gh.mock.calls.findIndex(([args]) => args.includes('POST'))]);
    });

    it.each(['red-team:blocked', 'red-team:pending', ...REVIEW_HOLD_LABELS])('posts nothing for live label %s', async label => {
      const io = fixture();
      io.readLive.mockReturnValue({ headRefOid: HEAD, labels: [{ name: label }] });
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    it('posts nothing when the shared enqueue hold reports a held break', async () => {
      const io = fixture();
      io.holdFn.mockReturnValue('post-accept red team confirmed a break requiring send-back');
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(io.holdFn).toHaveBeenCalledWith(expect.objectContaining({ recorded: true, head: HEAD }));
      expect(posts(io)).toEqual([]);
    });

    it('posts nothing when the live head moved', async () => {
      const io = fixture();
      io.readLive.mockReturnValue({ headRefOid: OLD_HEAD, labels: [] });
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    it.each(['missing', 'other-head', 'untrusted'])('posts nothing for a %s result even when the injected hold clears', async mode => {
      const io = fixture();
      io.readComments.mockReturnValue(mode === 'missing' ? [] : mode === 'other-head'
        ? [resultComment(OLD_HEAD)] : [{ ...resultComment(), author: { login: 'outsider' } }]);
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    it('posts nothing when the latest matching check is in_progress despite an older success', async () => {
      const io = fixture();
      io.gh.mockReturnValue(JSON.stringify({ total_count: 2, check_runs: [run(),
        run({ id: 11, status: 'in_progress', conclusion: null })] }));
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    it('refuses incomplete check history with an operator-visible fallback', async () => {
      const io = fixture();
      io.gh.mockReturnValue(JSON.stringify({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => run({ id: i + 1 })) }));
      expect(await publish(io)).toMatchObject({ ok: false, reason: expect.stringMatching(/operator.*inspect/i) });
      expect(posts(io)).toEqual([]);
    });

    it.each(['blocking-label', 'new-run'])('supersedes its success with failure when a %s races publication', async mode => {
      const io = fixture();
      const baseGh = io.gh.getMockImplementation();
      let posted = false;
      io.gh.mockImplementation((args, options) => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
        if (args.includes('POST')) { posted = true; return JSON.stringify({ id: 20 + posts(io).length }); }
        if (posted && mode === 'new-run') return JSON.stringify({ total_count: 1,
          check_runs: [run({ id: 99, status: 'in_progress', conclusion: null })] });
        return baseGh(args, options);
      });
      io.readLive.mockImplementation(() => ({ headRefOid: HEAD,
        labels: posted && mode === 'blocking-label' ? [{ name: 'red-team:blocked' }] : [] }));
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(payloads(io).map(payload => payload.conclusion)).toEqual(['success', 'failure']);
      for (const payload of payloads(io)) expect(payload).toMatchObject({ name: 'red-team',
        head_sha: HEAD, external_id: 'o/r#7', status: 'completed' });
    });

    it.each(['head-moved', 'labels-unreadable', 'result-missing', 'live-unreadable', 'comments-unreadable',
      'standing-ruling-error', 'hold-error', 'held-break', 'history-unreadable', 'completed-run'])
    ('supersedes success with failure when post-publication evidence is %s', async mode => {
      const io = fixture();
      let posted = false;
      const baseGh = io.gh.getMockImplementation();
      io.gh.mockImplementation((args, options) => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
        if (args.includes('POST')) { posted = true; return JSON.stringify({ id: 20 }); }
        if (posted && mode === 'history-unreadable') throw Error('check history unavailable');
        if (posted && mode === 'completed-run') return JSON.stringify({ total_count: 1,
          check_runs: [run({ id: 99 })] });
        return baseGh(args, options);
      });
      io.readLive.mockImplementation(() => !posted ? { headRefOid: HEAD, labels: [] }
        : mode === 'live-unreadable' ? null
          : { headRefOid: mode === 'head-moved' ? OLD_HEAD : HEAD,
            labels: mode === 'labels-unreadable' ? null : [] });
      io.readComments.mockImplementation(() => posted && mode === 'comments-unreadable' ? null
        : posted && mode === 'result-missing' ? [] : [resultComment()]);
      io.readStandingRuling.mockImplementation(() => {
        if (posted && mode === 'standing-ruling-error') throw Error('standing ruling unavailable');
        return null;
      });
      io.holdFn.mockImplementation(() => {
        if (posted && mode === 'hold-error') throw Error('hold evidence unavailable');
        return posted && mode === 'held-break' ? 'confirmed break requires send-back' : null;
      });
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(payloads(io).map(payload => payload.conclusion)).toEqual(['success', 'failure']);
      for (const payload of payloads(io)) expect(payload).toMatchObject({ name: 'red-team',
        head_sha: HEAD, external_id: 'o/r#7', status: 'completed' });
    });

    it.each(['readLive', 'readComments', 'readStandingRuling', 'holdFn', 'gh'])('%s errors return ok:false without throwing or posting', async reader => {
      const io = fixture();
      io[reader].mockImplementation(() => { throw Error('reader unavailable'); });
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    it.each(['readLive', 'readComments'])('unreadable %s evidence fails closed without posting', async reader => {
      const io = fixture();
      io[reader].mockReturnValue(null);
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io)).toEqual([]);
    });

    it('a failed success POST returns ok:false without throwing', async () => {
      const io = fixture();
      const baseGh = io.gh.getMockImplementation();
      io.gh.mockImplementation((args, options) => {

        if (args.includes(`repos/o/r/statuses/${HEAD}`)) return '{}';
        if (args.includes('POST')) throw Error('HTTP 403: check write denied');
        return baseGh(args, options);
      });
      expect(await publish(io)).toMatchObject({ ok: false });
      expect(posts(io).length).toBeGreaterThanOrEqual(1);
      expect(payloads(io)[0].conclusion).toBe('success');
    });
  });

  // PR #6535 round 6: the recovery policy-clear writer posts only on a head with no run for this PR.
  describe('publishRedTeamPolicyClearCheck', () => {
    const ghWith = runs => vi.fn(args => args.includes('POST') ? '{}' : JSON.stringify({ total_count: runs.length, check_runs: runs }));
    const publish = gh => api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh });
    it('posts a head-bound success when the PR has no red-team run on the head', () => {
      // Stateful fake: verify-after-write must see the posted run (a static fake cannot model the write).
      const fake = liveGh({ initial: [run({ id: 1, head_sha: OLD_HEAD })] }); // an older head's success does not count here
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
      expect(fake.posts[0]).toMatchObject({ name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: 'completed',
        conclusion: 'success', output: { title: 'Policy-clear: Red team clear' } });
    });
    it('needs no post when the head already shows success', () => {
      const gh = ghWith([run()]);
      expect(publish(gh)).toMatchObject({ ok: true });
      expect(gh.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
    });
    it.each([
      ['an in-progress round', [run({ status: 'in_progress', conclusion: null })]],
      ['a failed round', [run({ conclusion: 'failure' })]],
      ['another PR on the same head only', [run({ external_id: 'o/r#8' })]],
    ])('never overrides %s', (_name, runs) => {
      const gh = ghWith(runs);
      expect(publish(gh)).toMatchObject({ ok: false, reason: expect.stringContaining('policy-clear check not posted') });
      expect(gh.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
    });
    // #6535 round 10 (operator send-back): verify after write. A stateful fake GitHub: POST appends a run with the
    // next id; `onPost` lets a test insert a concurrent round's run at the moment the success is posted.
    const liveGh = ({ initial = [], onPost = () => {}, afterPost = () => {}, failReadAfterPost = false, failPostsAfter = Infinity } = {}) => {
      const runs = [...initial], posts = [];
      let nextId = Math.max(99, ...initial.map(r => r.id)) + 1; // GitHub ids only grow
      const gh = vi.fn((args, options) => {
        if (args.includes('POST')) {
          if (posts.length >= failPostsAfter) throw Error('HTTP 503');
          const payload = JSON.parse(options.input);
          posts.push(payload);
          onPost(runs, payload, () => nextId++);
          const id = nextId++;
          runs.push({ ...payload, id, app: { id: APP_ID }, conclusion: payload.conclusion ?? null });
          afterPost(runs, payload, () => nextId++);
          return JSON.stringify({ id });
        }
        if (failReadAfterPost && posts.length) throw Error('HTTP 502');
        return JSON.stringify({ total_count: runs.length, check_runs: runs });
      });
      return { gh, runs, posts };
    };
    const newest = runs => [...runs].sort((a, b) => b.id - a.id)[0];
    it('policy-clear cannot supersede a round started after its absence read', () => {
      // The absence read sees no run; a round then publishes in_progress; the policy-clear success lands NEWER.
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), status: 'in_progress', conclusion: null }));
      } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(fake.posts.map(p => p.status)).toEqual(['completed', 'in_progress']);
      expect(fake.posts.at(-1)).toMatchObject({ name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: 'in_progress',
        output: { title: 'Policy-clear: Red team in progress' } });
      expect(fake.posts.at(-1).conclusion).toBeUndefined();
      // The newest run (the authority merge-gate reads) is in_progress, never the policy-clear success.
      expect(newest(fake.runs)).toMatchObject({ status: 'in_progress' });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs }))
        .toEqual({ ok: false, reason: 'red-team check run in progress or incomplete' });
    });
    it('mirrors a concurrent round that already finished with failure (the failure stays authoritative)', () => {
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), conclusion: 'failure' }));
      } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(newest(fake.runs)).toMatchObject({ status: 'completed', conclusion: 'failure' });
    });
    it('does not yield to a round that started AND finished clean between its reads', () => {
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), status: 'in_progress', conclusion: null }), run({ id: id() }));
      } });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
    });
    // Self-review finding A: a retry must never trust its own unverified success (a lost POST response, a crash between
    // write and verify, or a failed yield) while a round it did not see is unfinished.
    it.each([
      ['in progress', run({ id: 100, status: 'in_progress', conclusion: null }), 'in_progress'],
      ['failed', run({ id: 100, conclusion: 'failure' }), 'failure'],
    ])('a retry over its own unverified success yields to a %s round (no false clear)', (_name, round, state) => {
      const fake = liveGh({ initial: [round, run({ id: 101, output: { title: 'Policy-clear: Red team clear' } })] });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(fake.posts).toHaveLength(1);
      expect(fake.posts[0]).toMatchObject({ status: state === 'failure' ? 'completed' : 'in_progress' });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs }).ok).toBe(false);
    });
    it('a round run that is newest owns the head: nothing is posted', () => {
      const fake = liveGh({ initial: [run({ id: 100, output: { title: 'Policy-clear: Red team clear' } }), run({ id: 101, status: 'in_progress', conclusion: null })] });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: expect.stringContaining('a red-team round owns this head (in_progress)') });
      expect(fake.posts).toHaveLength(0);
    });
    // Self-review finding B: its own yield is told apart from a real round, so an orphan yield never strands the head.
    it('a retry over its own orphan yield (no round behind it) posts the success again and verifies it', () => {
      const fake = liveGh({ initial: [run({ id: 50, output: { title: 'Policy-clear: Red team clear' } }),
        run({ id: 51, status: 'in_progress', conclusion: null, output: { title: 'Policy-clear: Red team in progress' } })] });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
      expect(newest(fake.runs)).toMatchObject({ status: 'completed', conclusion: 'success' });
    });
    it('corrects its own yield once the round it yielded to has finished clean', () => {
      const fake = liveGh({ initial: [run({ id: 50, status: 'in_progress', conclusion: null }), run({ id: 51 }),
        run({ id: 52, status: 'in_progress', conclusion: null, output: { title: 'Policy-clear: Red team in progress' } })] });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs })).toMatchObject({ ok: true });
    });
    // Self-review finding C: with no round run requiring otherwise, a success that is not (yet) newest is never
    // answered with an in_progress post.
    it('posts nothing more when a lagging re-read does not show its success yet', () => {
      const posts = [];
      const gh = vi.fn((args, options) => {
        if (args.includes('POST')) { posts.push(JSON.parse(options.input)); return '{}'; }
        return JSON.stringify({ total_count: 0, check_runs: [] });
      });
      expect(publish(gh)).toMatchObject({ ok: false, reason: expect.stringContaining('policy-clear unverified: newest run shows none') });
      expect(posts).toHaveLength(1);
    });
    it('posts nothing more when another policy-clear writer\'s yield lands on top (no round needs it)', () => {
      const fake = liveGh({ afterPost: (runs, payload, id) => { if (payload.conclusion === 'success')
        runs.push(run({ id: id(), status: 'in_progress', conclusion: null, output: { title: 'Policy-clear: Red team in progress' } })); } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: expect.stringContaining('policy-clear unverified: newest run shows in_progress') });
      expect(fake.posts).toHaveLength(1);
      // The retry re-reads and posts the success again over the stray yield.
      const retry = liveGh({ initial: fake.runs });
      expect(publish(retry.gh)).toEqual({ ok: true });
      expect(newest(retry.runs)).toMatchObject({ status: 'completed', conclusion: 'success' });
    });
    it('the round writers\' payload carries no policy-clear marker', () => {
      expect(api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'in_progress' }).output.title).toBe('Red team in progress');
      expect(api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null }).output.title).toBe('Red team clear');
    });
    it('a clean no-concurrency case publishes exactly one success and no extra in_progress post', () => {
      const fake = liveGh();
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
      expect(fake.posts[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs })).toMatchObject({ ok: true });
    });
    it('another PR\'s run on the same head does not make policy-clear yield', () => {
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), external_id: 'o/r#8', status: 'in_progress', conclusion: null }));
      } });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
    });
    it('fails closed on a failed re-read: supersedes its own success with in_progress and returns ok:false', () => {
      const fake = liveGh({ failReadAfterPost: true });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round',
        detail: expect.stringContaining('re-read after publication failed') });
      expect(fake.posts.map(p => p.status)).toEqual(['completed', 'in_progress']);
      expect(newest(fake.runs)).toMatchObject({ status: 'in_progress' });
    });
    it('reports a superseding post that also fails (ok:false, both reasons named); the next retry corrects it', () => {
      const fake = liveGh({ failPostsAfter: 1, onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), status: 'in_progress', conclusion: null }));
      } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round',
        detail: expect.stringContaining('superseding in_progress not posted') });
      // The disclosed fail-open window (self-review M1): until the next pass, the unverified success is newest and
      // merge-gate reads it as clear over the unfinished round. Pinned so the residual stays visible, not hidden.
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs }).ok).toBe(true);
      // GitHub is back: the retry sees its own unverified success over the round and yields (finding A).
      const retry = liveGh({ initial: fake.runs });
      expect(publish(retry.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(newest(retry.runs)).toMatchObject({ status: 'in_progress' });
    });
    it('fails closed on an unreadable head or a missing app id', () => {
      expect(publish(vi.fn(() => { throw Error('offline'); }))).toMatchObject({ ok: false });
      const gh = ghWith([]);
      expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: undefined, gh })).toMatchObject({ ok: false });
      expect(gh).not.toHaveBeenCalled();
    });
  });

  it('passes success on the exact head from the configured app', () => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns: [run()], appId: APP_ID })).toMatchObject({ ok: true });
  });

  it('success for PR A cannot authorize PR B sharing the same head SHA', () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }).ok).toBe(true);
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 8, headSha: HEAD, appId: APP_ID, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/o\/r#8.*external_id.*mismatching/) });
  });

  it('missing external_id fails closed even for a successful trusted check on the exact head', () => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      checkRuns: [run({ external_id: undefined })] }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/external_id missing/) });
  });

  it('selects the latest run for this PR without letting another PR supersede its pending round', () => {
    const checkRuns = [run(), run({ id: 11, status: 'in_progress', conclusion: null }),
      run({ id: 12, external_id: 'o/r#8' })];
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }).ok).toBe(false);
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 8, headSha: HEAD, appId: APP_ID, checkRuns }).ok).toBe(true);
  });

  it('publishes the PR identity in external_id and the summary', () => {
    const payload = api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null });
    const gh = vi.fn(() => JSON.stringify({ id: 123 }));
    expect(api.postRedTeamCheckRun({ repo: 'o/r', pr: 7, headSha: HEAD, payload, gh }).ok).toBe(true);
    const sent = JSON.parse(gh.mock.calls[0][1].input);
    expect(sent.external_id).toBe('o/r#7');
    expect(sent.output.summary).toContain('o/r#7');
  });

  it.each([
    ['failure holds', [run({ conclusion: 'failure' })], /fail/i],
    ['missing fails closed', [], /^no red-team check run on head$/],
    ['wrong app id holds', [run({ app: { id: 1 } })], /no red-team check run on head/],
    ['success only on a previous head holds', [run({ head_sha: OLD_HEAD })], /no red-team check run on head/],
    ['unreadable null fails closed', null, /unreadable/i],
    ['unreadable undefined fails closed', undefined, /unreadable/i],
    ['in progress holds', [run({ status: 'in_progress', conclusion: null })], /progress|pending|incomplete/i],
    ['another check name cannot clear red team', [run({ name: 'test' })], /no red-team check run on head/],
  ])('%s', (_name, checkRuns, reason) => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns, appId: APP_ID }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it.each([false, true])('uses the latest matching run regardless of input order (reverse=%s)', reverse => {
    const checkRuns = [run(), run({ id: 11, started_at: '2026-11-07T11:00:00Z', conclusion: 'failure' })];
    if (reverse) checkRuns.reverse();
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns, appId: APP_ID }).ok).toBe(false);
  });

  it('a newer wrong-app or other-head run cannot supersede the matching success', () => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: [run(),
      run({ id: 11, app: { id: 1 }, conclusion: 'failure' }),
      run({ id: 12, head_sha: OLD_HEAD, conclusion: 'failure' })] }).ok).toBe(true);
  });

  it.each([false, true])('a newer pending run supersedes an older success (reverse=%s)', reverse => {
    const checkRuns = [run(), run({ id: 11, started_at: '2026-11-07T11:00:00Z', status: 'in_progress', conclusion: null })];
    if (reverse) checkRuns.reverse();
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns, appId: APP_ID }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/progress|pending|incomplete/i) });
  });

  it.each([undefined, null, '', 'invalid', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'missing or invalid WE_APP_ID fails closed before reading GitHub: %s', appId => {
      const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns: [run()], appId }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/WE_APP_ID/) });
      expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId, gh }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/WE_APP_ID/) });
      expect(gh).not.toHaveBeenCalled();
    });

  it.each([
    ['truncated history containing a success', 101, 100],
    ['oversized history beyond the read bound', 101, 101],
    ['missing total count', undefined, 1],
  ])('incomplete check history fails closed with an operator fallback: %s', (_name, totalCount, count) => {
    const gh = vi.fn(() => JSON.stringify({ total_count: totalCount,
      check_runs: Array.from({ length: count }, (_, index) => run({ id: index + 10 })) }));
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/incomplete.*operator.*inspect/i) });
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['finished clear', 'finished', null, false, 'completed', 'success'],
    ['finished held', 'finished', 'post-accept red team has no recorded result on the live head', false, 'completed', 'failure'],
    ['sendBack', 'finished', null, true, 'completed', 'failure'],
    ['pending', 'pending', null, false, 'in_progress', undefined],
    ['running', 'running', null, false, 'in_progress', undefined],
  ])('payload: %s', (_name, status, hold, sendBack, expectedStatus, conclusion) => {
    const payload = api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status, hold, result: null, sendBack });
    expect(payload).toMatchObject({ name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: expectedStatus,
      output: { title: expect.any(String), summary: expect.any(String) } });
    expect(payload.conclusion).toBe(conclusion);
    if (hold) expect(payload.output.summary).toContain(hold);
  });

  it('a real enqueue hold cannot become success even with a clean result', () => {
    const hold = redTeamEnqueueHold({ scheduled: true, comments: [], pr: 7, head: HEAD, env: {} });
    expect(hold).toEqual(expect.any(String));
    expect(api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold,
      result: { verdict: 'accept' }, sendBack: false }).conclusion).toBe('failure');
  });

  it('posts the check run to the requested repository using injected gh', async () => {
    const payload = api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null, result: null, sendBack: false });
    const gh = vi.fn(() => JSON.stringify({ id: 123 }));
    expect(await api.postRedTeamCheckRun({ repo: 'o/r', pr: 7, headSha: HEAD, payload, gh })).toMatchObject({ ok: true });
    expect(gh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gh.mock.calls)).toContain('repos/o/r/check-runs');
  });

  it('publication errors return a reason without throwing', async () => {
    const gh = vi.fn(() => { throw new Error('permission denied'); });
    expect(await api.postRedTeamCheckRun({ repo: 'o/r', pr: 7, headSha: HEAD,
      payload: { name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: 'in_progress' }, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/permission denied/) });
  });

  it('reads check runs from the exact head endpoint with injected gh', async () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    expect(await api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh })).toMatchObject({ ok: true });
    expect(JSON.stringify(gh.mock.calls)).toContain(`repos/o/r/commits/${HEAD}/check-runs`);
  });

  it.each(['API failure', 'malformed JSON', 'missing check_runs'])('reader fails closed: %s', async mode => {
    const gh = vi.fn(() => {
      if (mode === 'API failure') throw new Error('HTTP 403');
      return mode === 'malformed JSON' ? '{' : '{}';
    });
    expect(await api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toMatchObject({ ok: false, reason: expect.any(String) });
  });
});

describe('GitHub-visible red-team publication hold (commit status)', () => {
  const head = 'd'.repeat(40);
  it('posts a head-bound failure or success status on its own context, with a bounded single-line description', async () => {
    const { postRedTeamPublicationHold } = await import('../red-team-check-run.mjs');
    const calls = [];
    const gh = (args, opts) => { calls.push({ args, body: JSON.parse(opts.input) }); return ''; };
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, reason: `x\n${'y'.repeat(300)}`, gh })).toEqual({ ok: true });
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: false, gh })).toEqual({ ok: true });
    expect(calls.map(c => c.args.slice(0, 4))).toEqual([['api', `repos/o/r/statuses/${head}`, '--method', 'POST'], ['api', `repos/o/r/statuses/${head}`, '--method', 'POST']]);
    expect(calls.map(c => [c.body.state, c.body.context])).toEqual([['failure', 'red-team/publication #7'], ['success', 'red-team/publication #7']]);
    expect(calls[0].body.description).toHaveLength(140);
    expect(calls[0].body.description).not.toMatch(/\n/);
  });
  it('refuses an invalid identity and reports a failed post', async () => {
    const { postRedTeamPublicationHold } = await import('../red-team-check-run.mjs');
    const gh = vi.fn(() => { throw Error('HTTP 503'); });
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: 'nope', held: true, gh })).toMatchObject({ ok: false });
    expect(gh).not.toHaveBeenCalled();
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, gh })).toMatchObject({ ok: false, definite: false, reason: expect.stringContaining('HTTP 503') });
  });
  it('detects a definite 4xx rejection from the full error text, even past the reason truncation', async () => {
    const { postRedTeamPublicationHold } = await import('../red-team-check-run.mjs');
    const long = Object.assign(Error(`${'x'.repeat(400)} Resource not accessible by integration (HTTP 403)`), { stderr: '' });
    const result = postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, gh: () => { throw long; } });
    expect(result).toMatchObject({ ok: false, definite: true });
    expect(result.reason).not.toMatch(/HTTP 403/);
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true,
      gh: () => { throw Object.assign(Error('gh failed'), { stderr: 'gh: Validation Failed (HTTP 422)' }); } })).toMatchObject({ definite: true });
  });
  it('fails closed when the combined summary carries this PR failure hold but the history is empty (#6535 :145)', async () => {
    const { evaluateRedTeamPublicationHold: evaluateAny, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const context = redTeamPublicationContext(7);
    const combined = { total_count: 1, statuses: [{ context, state: 'failure', id: 5 }] };
    expect(evaluateAny({ pr: 7, combined, statuses: [] })).toMatchObject({ ok: false });
    expect(evaluateAny({ pr: 7, combined, statuses: [{ id: 3, context: 'other', state: 'success' }] })).toMatchObject({ ok: false });
  });
  it('evaluates absent, cleared, held, and incomplete combined status', async () => {
    const { evaluateRedTeamPublicationHold: evaluateAny, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const evaluate = input => evaluateAny({ pr: 7, ...input }), context = redTeamPublicationContext(7);
    const combined = { total_count: 1, statuses: [{ context, state: 'failure' }] };
    const bot = { login: 'web-everything[bot]' }, stranger = { login: 'someone-else' };
    expect(evaluateAny({ combined, statuses: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/PR number/) });
    expect(evaluate({ combined: { total_count: 1, statuses: [{ context: 'ci', state: 'failure' }] } })).toMatchObject({ ok: true });
    expect(evaluate({ combined, statuses: [{ id: 2, context, state: 'success', creator: bot }, { id: 1, context, state: 'failure', creator: bot }] }))
      .toMatchObject({ ok: true, reason: expect.stringMatching(/cleared/) });
    for (const state of ['failure', 'pending', 'error', undefined])
      expect(evaluate({ combined, statuses: [{ id: 1, context, state, creator: stranger }] })).toMatchObject({ ok: false });
    expect(evaluate({ combined: { total_count: 2, statuses: [] } })).toMatchObject({ ok: false, reason: expect.stringMatching(/incomplete/) });
    expect(evaluate({ combined: null })).toMatchObject({ ok: false });
    expect(evaluate({ combined, statuses: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/history unreadable/) });
  });
  it('an untrusted success never clears a hold, whatever its order in the response', async () => {
    const { evaluateRedTeamPublicationHold: evaluateAny, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const evaluate = input => evaluateAny({ pr: 7, ...input }), context = redTeamPublicationContext(7);
    const combined = { total_count: 1, statuses: [{ context, state: 'success' }] };
    const statuses = [{ id: 1, context, state: 'failure', creator: { login: 'web-everything[bot]' } },
      { id: 9, context, state: 'success', creator: { login: 'github-actions[bot]' } }];
    expect(evaluate({ combined, statuses })).toMatchObject({ ok: false, reason: expect.stringMatching(/GitHub-visible hold/) });
    // Only untrusted successes and no hold: nothing to honour.
    expect(evaluate({ combined, statuses: [statuses[1]] })).toMatchObject({ ok: true });
    // A full page with no decision cannot rule out an older hold.
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, context, state: 'success', creator: { login: 'x' } }));
    expect(evaluate({ combined, statuses: page })).toMatchObject({ ok: false, reason: expect.stringMatching(/100-status bound/) });
  });
  it('reads the full history only when the context exists', async () => {
    const { readRedTeamPublicationHoldFact, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const context = redTeamPublicationContext(7);
    const calls = [];
    const gh = args => { calls.push(args[1]); return JSON.stringify({ total_count: 0, statuses: [] }); };
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh })).toMatchObject({ ok: true });
    expect(calls).toEqual([`repos/o/r/commits/${head}/status?per_page=100`]);
    const gh2 = args => (/\/status\?/.test(args[1]) ? JSON.stringify({ total_count: 1, statuses: [{ context, state: 'failure' }] })
      : JSON.stringify([{ id: 1, context, state: 'failure', creator: { login: 'web-everything[bot]' } }]));
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh: gh2 })).toMatchObject({ ok: false });
    // The bare, PR-less context (never this PR's) is not read as this PR's hold.
    const gh3 = args => (/\/status\?/.test(args[1]) ? JSON.stringify({ total_count: 1, statuses: [{ context: 'red-team/publication', state: 'failure' }] })
      : JSON.stringify([]));
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh: gh3 })).toMatchObject({ ok: true });
  });
  it.each([
    ['a hold', 'failure', 'web-everything[bot]', false],
    ['a trusted clear', 'success', 'web-everything[bot]', true],
  ])('pages the history past 100 unrelated statuses to find %s', async (_name, state, login, ok) => {
    const { readRedTeamPublicationHoldFact, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const context = redTeamPublicationContext(7);
    const history = [...Array.from({ length: 130 }, (_, i) => ({ id: 1000 - i, context: 'ci/build', state: 'success' })),
      { id: 5, context, state, creator: { login } }];
    const gh = args => {
      if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 2, statuses: [{ context: 'ci/build', state: 'success' }, { context, state }] });
      const page = Number(/[?&]page=(\d+)/.exec(args[1])?.[1] ?? 1);
      return JSON.stringify(history.slice((page - 1) * 100, page * 100));
    };
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh })).toMatchObject({ ok });
  });
  it('a context repeated across combined pages (a reorder that skipped another) reads as incomplete', async () => {
    const { readRedTeamPublicationHoldFact } = await import('../red-team-check-run.mjs');
    // 101 contexts; page 2 repeats ci/0 instead of the skipped publication context, so the raw length still matches.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ context: `ci/${i}`, state: 'success' }));
    const gh = args => {
      if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 101, statuses: /page=2/.test(args[1]) ? [page1[0]] : page1 });
      return '[]';
    };
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/unreadable or incomplete/) });
  });
  it('a history still undecided at the page cap holds the gate', async () => {
    const { readRedTeamPublicationHoldFact, redTeamPublicationContext, STATUS_PAGE_CAP } = await import('../red-team-check-run.mjs');
    const context = redTeamPublicationContext(7);
    let reads = 0;
    const gh = args => {
      if (/\/status\?/.test(args[1])) return JSON.stringify({ total_count: 1, statuses: [{ context, state: 'failure' }] });
      reads++;
      return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: 100_000 - reads * 100 - i, context: 'ci/build', state: 'success' })));
    };
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/10-page bound/) });
    expect(reads).toBe(STATUS_PAGE_CAP);
  });
});

describe('the publication hold is bound to its PR, not only its head (#6535 round 4)', () => {
  const head = 'e'.repeat(40);
  const bot = { login: 'web-everything[bot]' };
  it('a confirmed clear by another PR sharing the head never clears this PR\'s hold', async () => {
    const { postRedTeamPublicationHold, readRedTeamPublicationHoldFact } = await import('../red-team-check-run.mjs');
    const posted = [];
    const writer = (args, opts) => { posted.push({ id: posted.length + 1, creator: bot, ...JSON.parse(opts.input) }); return ''; };
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, gh: writer })).toEqual({ ok: true });
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 8, headSha: head, held: false, gh: writer })).toEqual({ ok: true });
    expect(new Set(posted.map(s => s.context)).size).toBe(2);
    const reader = args => {
      const newestFirst = [...posted].reverse();
      if (/\/status\?/.test(args[1])) {
        const latest = [...new Map([...posted].map(s => [s.context, s])).values()];
        return JSON.stringify({ total_count: latest.length, statuses: latest });
      }
      return JSON.stringify(newestFirst);
    };
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh: reader }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/GitHub-visible hold/) });
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 8, headSha: head, gh: reader })).toMatchObject({ ok: true });
  });
  it('refuses to post or read a hold without a valid PR number', async () => {
    const { postRedTeamPublicationHold, readRedTeamPublicationHoldFact } = await import('../red-team-check-run.mjs');
    const gh = vi.fn(() => '');
    for (const pr of [undefined, 0, -1, '7x', 1.5]) {
      expect(postRedTeamPublicationHold({ repo: 'o/r', pr, headSha: head, held: true, gh })).toMatchObject({ ok: false });
      expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr, headSha: head, gh })).toMatchObject({ ok: false });
    }
    expect(gh).not.toHaveBeenCalled();
  });
});

describe('bounded reads (round-4 finding): every red-team GitHub read asks for one 100-item page within 4 MiB and 60 s', () => {
  const head = 'f'.repeat(40);
  it('bounds check-run reads to 100 results and 4 MiB', async () => {
    const { readRedTeamCheckFact } = await import('../red-team-check-run.mjs');
    const calls = [];
    const gh = (args, opts) => { calls.push({ args, opts }); return JSON.stringify({ total_count: 0, check_runs: [] }); };
    readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: head, appId: 5037855, gh });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['api', `repos/o/r/commits/${head}/check-runs?check_name=red-team&filter=all&per_page=100`]);
    expect(calls[0].opts).toMatchObject({ maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  });
  it('bounds both publication-hold reads the same way', async () => {
    const { readRedTeamPublicationHoldFact, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const calls = [];
    const gh = (args, opts) => {
      calls.push({ args, opts });
      return /\/status\?/.test(args[1]) ? JSON.stringify({ total_count: 1, statuses: [{ context: redTeamPublicationContext(7), state: 'failure' }] }) : '[]';
    };
    readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh });
    expect(calls.map(c => c.args[1])).toEqual([`repos/o/r/commits/${head}/status?per_page=100`, `repos/o/r/commits/${head}/statuses?per_page=100`]);
    for (const c of calls) expect(c.opts).toMatchObject({ maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  });
  it('a response over the 100-run bound fails closed', async () => {
    const { readRedTeamCheckFact } = await import('../red-team-check-run.mjs');
    const gh = () => JSON.stringify({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) });
    expect(readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: head, appId: 5037855, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/100-run bound/) });
  });
});

// #6535 operator send-backs (2026-11-12, R903) and ruling R907 (setting R905): the daemon never sets WE_APP_ID, the
// reviewer App (5267537) holds only checks:read, and every installed App gets HTTP 403 on Actions variables. The id is
// the `redTeamGate.appId` setting (env WE_APP_ID as its top layer), never a runtime variable read, and every red-team
// write runs as today's App (5037855), whatever role the calling daemon plays.
describe('WE App id resolver and the red-team writer identity (#6535 operator send-back, R907)', () => {
  const WE_APP = '5037855', REVIEWER_APP = 5267537;
  const head = 'c'.repeat(40);
  beforeAll(async () => { api = await import('../red-team-check-run.mjs'); });
  // Models GitHub: the App a call authenticates as follows the shim role in its env. Only today's App may create a
  // check run (a role App has checks:read: HTTP 403); every App gets HTTP 403 on an Actions variable read.
  const daemonGh = () => {
    const runs = [], calls = [];
    let nextId = 100;
    const appOf = env => env?.WE_GITHUB_APP_ROLE === 'legacy' ? Number(WE_APP) : REVIEWER_APP;
    const run = vi.fn((args, options = {}) => {
      calls.push({ args, role: options.env?.WE_GITHUB_APP_ROLE, app: appOf(options.env) });
      if (String(args[1]).includes('/actions/variables/')) throw Error('HTTP 403: Resource not accessible by integration');
      if (args.includes('POST')) {
        if (appOf(options.env) !== Number(WE_APP)) throw Error('HTTP 403: Resource not accessible by integration');
        const payload = JSON.parse(options.input);
        runs.push({ ...payload, id: nextId++, app: { id: appOf(options.env) }, conclusion: payload.conclusion ?? null });
        return '{}';
      }
      return JSON.stringify({ total_count: runs.length, check_runs: runs });
    });
    return { run, runs, calls };
  };
  const daemonEnv = () => ({ PATH: '/bin', WE_GITHUB_APP_ROLE: 'reviewer' }); // the review daemon: no WE_APP_ID
  const args = { repo: 'o/r', pr: 7, headSha: head };

  it('(1) a daemon env without WE_APP_ID resolves 5037855 from the setting; the writer gets that id, never 5267537, and no variable is read', () => {
    const fake = daemonGh();
    const publish = vi.fn(api.publishRedTeamPolicyClearCheck);
    const result = api.createPolicyClearPublisher({ env: daemonEnv(), run: fake.run, publish })(args);
    expect(result).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].appId).toBe(WE_APP);
    expect(publish.mock.calls.every(([a]) => Number(a.appId) !== REVIEWER_APP)).toBe(true);
    expect(fake.calls.filter(c => String(c.args[1]).includes('/actions/variables/'))).toEqual([]);
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]).toMatchObject({ app: { id: Number(WE_APP) }, conclusion: 'success', external_id: 'o/r#7' });
  });

  it('the shipped setting is the trusted App id 5037855, resolved from the tool layer with its source logged', () => {
    const lines = [];
    expect(api.resolveWeAppId({ env: {}, platform: {}, log: line => lines.push(line) }))
      .toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(lines).toEqual([expect.stringMatching(/redTeamGate\.appId: appId=5037855 \(tool\)/)]);
  });

  it('(2) a reviewer-role identity in the env is never used for a write', () => {
    const fake = daemonGh();
    api.createPolicyClearPublisher({ env: daemonEnv(), run: fake.run })(args);
    const writes = fake.calls.filter(c => c.args.includes('POST'));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(c => c.role === 'legacy' && c.app === Number(WE_APP))).toBe(true);
    // Every writer, not only policy-clear: the round writer's check post and the publication-hold status too.
    const seen = [];
    const gh = (a, options) => { seen.push(options.env); return '{}'; };
    const env = { ...daemonEnv(), WE_GITHUB_APP_ROLE: 'merger', KEEP: '1' };
    api.postRedTeamCheckRun({ ...args, gh, env, payload: api.redTeamCheckRunPayload({ ...args, status: 'in_progress' }) });
    api.postRedTeamPublicationHold({ ...args, held: true, gh, env });
    expect(seen).toEqual([{ ...env, WE_GITHUB_APP_ROLE: 'legacy' }, { ...env, WE_GITHUB_APP_ROLE: 'legacy' }]);
    expect(env.WE_GITHUB_APP_ROLE).toBe('merger'); // the caller's env is never mutated
    // An inherited role-App token never reaches the write (the shim's inherited-token path or a bare gh would use it).
    const inherited = { ...env, GH_TOKEN: 'fixture-role-token', GITHUB_TOKEN: 'x', WE_GH_AUTH_TOKEN_HASH: 'h', WE_GH_AUTH_SOURCE: 'cache', WE_GH_AUTH_INSTALLATION: '1' };
    expect(api.redTeamWriterEnv(inherited)).toEqual({ ...env, WE_GITHUB_APP_ROLE: 'legacy' });
    expect(inherited.GH_TOKEN).toBe('fixture-role-token');
  });

  it('an on-demand refresh for the legacy role mints today\'s App only, never a configured role App', async () => {
    const { buildIdentityChain, LEGACY_ROLE } = await import('../github-app-identity.mjs');
    const app = id => ({ appId: id, installations: { o: '1' }, key: { file: '/k.pem' } });
    const identity = { roles: { reviewer: app('5267537'), worker: app('5267514') }, invalid: [], anyConfigured: true, callerRoles: {} };
    const chain = buildIdentityChain({ requestedRole: LEGACY_ROLE, identity, env: {}, cachePath: '/c/web-everything.json' });
    expect(chain.steps).toEqual([]);
    expect(chain.candidates.map(c => c.role)).toEqual([LEGACY_ROLE]);
    expect(buildIdentityChain({ requestedRole: 'reviewer', identity, env: {}, cachePath: '/c/web-everything.json' })
      .candidates.map(c => c.role)).toEqual(['reviewer', 'worker', LEGACY_ROLE]);
  });

  it.each([
    ['unreadable (missing file)', { path: new URL('file:///nonexistent/red-team.json') }],
    ['without appId', { tool: { redTeamGate: { source: 'both' } } }],
    ['empty', { tool: { redTeamGate: { appId: '' } } }],
    ['not an id', { tool: { redTeamGate: { appId: 'abc' } } }],
    ['zero', { tool: { redTeamGate: { appId: 0 } } }],
    ['at an unreadable path', { path: new URL('data:application/json,{not json') }],
  ])('(3) a setting that is %s yields the existing fail-closed reason, with no publication', (_label, layer) => {
    const fake = daemonGh();
    const publish = vi.fn(api.publishRedTeamPolicyClearCheck);
    const resolveAppId = () => api.resolveWeAppId({ env: daemonEnv(), platform: {}, ...layer });
    const result = api.createPolicyClearPublisher({ env: daemonEnv(), run: fake.run, publish, resolveAppId })(args);
    expect(result).toMatchObject({ ok: false, reason: 'WE_APP_ID unset or invalid; configure the WE App repository variable',
      detail: expect.stringMatching(/redTeamGate\.appId setting missing or invalid/) });
    expect(publish).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]); // no POST, and no variable read as a fallback
    // A reader handed the unresolved id keeps the same reason and reads no check runs.
    const read = vi.fn();
    expect(api.readRedTeamCheckFact({ ...args, appId: resolveAppId().appId, gh: read }))
      .toEqual({ ok: false, reason: 'WE_APP_ID unset or invalid; configure the WE App repository variable' });
    expect(read).not.toHaveBeenCalled();
  });

  it('cascade: platform < tool < WE_APP_ID env; an invalid layer is ignored, never read as "no id"', () => {
    const tool = { redTeamGate: { appId: 5037855 } };
    expect(api.resolveWeAppId({ env: {}, tool, platform: {} })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(api.resolveWeAppId({ env: {}, tool, platform: { appId: 77 } })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(api.resolveWeAppId({ env: {}, tool: {}, platform: { appId: 77 } })).toEqual({ ok: true, appId: '77', source: 'platform' });
    expect(api.resolveWeAppId({ env: { WE_APP_ID: '42' }, tool, platform: { appId: 77 } })).toEqual({ ok: true, appId: '42', source: 'env' });
    expect(api.resolveWeAppId({ env: { WE_APP_ID: 'bad' }, tool, platform: {} })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(api.resolveWeAppId({ env: { WE_APP_ID: '' }, tool, platform: {} })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    // A log that throws never changes the answer.
    expect(api.resolveWeAppId({ env: {}, tool, platform: {}, log: () => { throw Error('closed'); } })).toMatchObject({ ok: true, appId: WE_APP });
  });

  it('the gh shim gives the legacy role today\'s App only, never a configured role App', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // Render in a plain node child: the shim embeds helpers via Function#toString, which vitest's transform rewrites.
    const renderGhShimScript = options => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(fileURLToPath(new URL('../gh-app-shim.mjs', import.meta.url)))}); process.stdout.write(m.renderGhShimScript(JSON.parse(process.argv[1])));`,
        JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw Error(`shim render failed: ${r.stderr}`);
      return r.stdout;
    };
    const dir = mkdtempSync(join(tmpdir(), 'red-team-writer-shim-'));
    try {
      const cache = (name, token) => {
        const path = join(dir, `${name}.json`);
        // Synthetic fixture values only.
        writeFileSync(path, JSON.stringify({ v: 2, installationId: '1', appId: name, token, expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
        return path;
      };
      const gh = join(dir, 'real-gh');
      writeFileSync(gh, `#!${process.execPath}\nprocess.stdout.write(String(process.env.GH_TOKEN));\n`);
      chmodSync(gh, 0o755);
      const shim = join(dir, 'shim.cjs');
      writeFileSync(shim, renderGhShimScript({ realGhPath: gh, cachePath: cache('legacy', 'fixture-legacy'),
        ghThrottleCliPath: join(dir, 'missing-throttle'), refreshCliPath: join(dir, 'missing-refresh'),
        roleTable: { reviewer: { cachePath: cache('reviewer', 'fixture-reviewer'), installations: { o: '1' } },
          worker: { cachePath: cache('worker', 'fixture-worker'), installations: { o: '1' } } } }));
      const as = role => spawnSync(process.execPath, [shim, 'api', 'rate_limit'], { cwd: dir, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, WE_GITHUB_APP_ROLE: role } });
      const legacy = as('legacy');
      expect(`${legacy.stdout}|${legacy.status}|${String(legacy.error ?? '')}|${legacy.stderr.slice(0, 600)}`)
        .toMatch(/^fixture-legacy\|0\|/);
      expect(legacy.stderr).not.toMatch(/using the worker App|unavailable/);
      expect(as('reviewer').stdout).toBe('fixture-reviewer');
      expect(as(api.redTeamWriterEnv({ WE_GITHUB_APP_ROLE: 'reviewer' }).WE_GITHUB_APP_ROLE).stdout).toBe('fixture-legacy');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Round 11 coverage (#6535): legacy App or nothing when today's App token is unavailable. A daemon refuses (no role
  // App, no personal login); its one on-demand refresh asks for the legacy role only.
  it('the gh shim with no legacy token never uses a configured role App: a daemon refuses, its refresh asks for legacy only', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const renderGhShimScript = options => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(fileURLToPath(new URL('../gh-app-shim.mjs', import.meta.url)))}); process.stdout.write(m.renderGhShimScript(JSON.parse(process.argv[1])));`,
        JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw Error(`shim render failed: ${r.stderr}`);
      return r.stdout;
    };
    const dir = mkdtempSync(join(tmpdir(), 'red-team-writer-shim-miss-'));
    try {
      const cache = (name, token) => {
        const path = join(dir, `${name}.json`);
        // Synthetic fixture values only.
        writeFileSync(path, JSON.stringify({ v: 2, installationId: '1', appId: name, token, expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
        return path;
      };
      const gh = join(dir, 'real-gh');
      writeFileSync(gh, `#!${process.execPath}\nprocess.stdout.write('ran:' + String(process.env.GH_TOKEN));\n`);
      chmodSync(gh, 0o755);
      // The refresh CLI records the role it was asked for and mints nothing (today's App stays unavailable).
      const refreshLog = join(dir, 'refresh.log');
      const refresh = join(dir, 'refresh.cjs');
      writeFileSync(refresh, `require('node:fs').appendFileSync(${JSON.stringify(refreshLog)}, process.argv.slice(2).join(' ') + '\\n');\n`);
      const shim = join(dir, 'shim.cjs');
      writeFileSync(shim, renderGhShimScript({ realGhPath: gh, cachePath: join(dir, 'legacy-absent.json'),
        ghThrottleCliPath: join(dir, 'missing-throttle'), refreshCliPath: refresh,
        roleTable: { reviewer: { cachePath: cache('reviewer', 'fixture-reviewer'), installations: { o: '1' } },
          worker: { cachePath: cache('worker', 'fixture-worker'), installations: { o: '1' } } } }));
      const call = extra => spawnSync(process.execPath, [shim, 'api', 'rate_limit'], { cwd: dir, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, WE_GITHUB_APP_ROLE: 'legacy', ...extra } });

      const daemon = call({ WE_GH_DAEMON_CALLER: 'review-daemon', WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse' });
      expect(daemon.status).toBe(1);
      expect(daemon.stdout).toBe(''); // gh never ran: no role App token, no personal login
      expect(daemon.stderr).toMatch(/REFUSING personal-auth fallback for daemon caller "review-daemon" \(role legacy/);
      expect(`${daemon.stdout}${daemon.stderr}`).not.toMatch(/fixture-reviewer|fixture-worker|using the (reviewer|worker) App/);
      expect(existsSync(refreshLog) ? readFileSync(refreshLog, 'utf8') : '').toBe('--role=legacy\n');

      // An interactive caller gets no role App either (it may use the operator's own login, as for any App miss).
      const interactive = call({});
      expect(interactive.stdout).toBe('ran:undefined');
      expect(`${interactive.stdout}${interactive.stderr}`).not.toMatch(/fixture-reviewer|fixture-worker/);
      // Contrast: the reviewer role with the same caches does use its App, so the refusal above is the legacy guard.
      expect(call({ WE_GITHUB_APP_ROLE: 'reviewer' }).stdout).toBe('ran:fixture-reviewer');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Round 11 coverage (#6535): ensureFreshGithubAppEnv's explicit `legacy` branch mints today's App only. The process
  // role (env or caller map) cannot override it, and `legacy` is never selectable from the env.
  describe('ensureFreshGithubAppEnv with role legacy (the shim\'s on-demand refresh for the red-team writer)', () => {
    const TODAY = '5037855', REVIEWER = '5267537', WORKER = '5267514';
    const dirs = [];
    afterEach(async () => {
      const { rmSync } = await import('node:fs');
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const setup = async () => {
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const { ensureFreshGithubAppEnv } = await import('../github-app-auth-env.mjs');
      const { resolveDeliveryIdentity, ROLE_REQUIRED_PERMISSIONS } = await import('../github-app-identity.mjs');
      const { OWNER_INSTALLATIONS } = await import('../github-app-installations.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'red-team-legacy-refresh-'));
      dirs.push(dir);
      const installations = { 'web-everything': '91', 'frontier-ui': '92', plateauapp: '93' };
      // Both a process role App and the worker App are configured, so neither the role resolution (auth-env) nor
      // the chain builder (`buildIdentityChain`'s legacy order) can let a role App stand in unnoticed.
      const identity = resolveDeliveryIdentity({ tool: {
        reviewer: { appId: REVIEWER, installations, key: { file: '/keys/reviewer.pem' } },
        worker: { appId: WORKER, installations, key: { file: '/keys/worker.pem' } } } });
      const minted = [];
      const env = { WE_GITHUB_APP_ID: TODAY, WE_GITHUB_APP_INSTALLATION_ID: OWNER_INSTALLATIONS['web-everything'],
        WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k', PATH: '/usr/bin', WE_GITHUB_APP_ROLE: 'reviewer' };
      const run = (opts = {}) => ensureFreshGithubAppEnv({
        env, cachePath: join(dir, 'web-everything.json'), statusPath: join(dir, 'status.json'), now: Date.now(), identity,
        caller: 'review-daemon.mjs', daemon: false, policy: { auth: 'app' }, // never the host's auth preference
        mint: async ({ appId, installationId }) => {
          minted.push(String(appId));
          if (opts.failApp === String(appId)) throw new Error('HTTP 401 bad credentials');
          return { token: `tok-${appId}-${installationId}`, expiresAt: new Date(Date.now() + 3600e3).toISOString(),
            permissions: { ...ROLE_REQUIRED_PERMISSIONS.worker, statuses: 'read', merge_queues: 'write' } };
        },
        getInstallationInfo: async () => ({ repositorySelection: 'all' }), canReadKey: () => true,
        log: { error: () => {} }, writeStatus: () => {}, writeCallerStatus: () => {},
        installShim: async () => ({ ok: true }), perOwner: true, ...opts });
      return { run, minted, env };
    };

    it('role legacy refreshes today\'s App only, although the process plays the reviewer role', async () => {
      const t = await setup();
      const r = await t.run({ role: 'legacy' });
      expect(r).toMatchObject({ applied: true, role: 'legacy', requestedRole: 'legacy' });
      expect(t.minted.length).toBeGreaterThan(0);
      expect(t.minted.every(id => id === TODAY)).toBe(true);
      expect(t.minted).not.toContain(REVIEWER);
      expect(t.minted).not.toContain(WORKER);
    });

    it('role legacy with today\'s App unavailable applies nothing; no role App stands in', async () => {
      const t = await setup();
      const r = await t.run({ role: 'legacy', failApp: TODAY });
      expect(r.applied).not.toBe(true);
      expect(['reviewer', 'worker']).not.toContain(r.role);
      expect(t.minted).not.toContain(REVIEWER);
      expect(t.minted).not.toContain(WORKER);
      expect(r.fallbackFrom ?? []).toEqual([]);
    });

    it('contrast: the process role (reviewer from the env) mints the reviewer App first; legacy in the env is not a role', async () => {
      const t = await setup();
      expect(await t.run()).toMatchObject({ applied: true, role: 'reviewer', requestedRole: 'reviewer' });
      expect(t.minted[0]).toBe(REVIEWER);
      const { resolveRequestedRole } = await import('../github-app-identity.mjs');
      expect(resolveRequestedRole({ env: { WE_GITHUB_APP_ROLE: 'legacy' }, caller: 'no-such-caller.mjs', callerRoles: {} }).role).not.toBe('legacy');
    });
  });
});

// Round 11 coverage (#6535, ruling: block): the promised whole-head refusal of unordered check-run ids. A matching run
// whose id cannot order it (missing, non-integer, zero, negative, unsafe, a string) refuses the head, whatever the
// other runs say; the policy-clear writer keeps that refusal and posts nothing.
describe('unordered red-team check-run ids are refused', () => {
  beforeAll(async () => { api = await import('../red-team-check-run.mjs'); });
  const run = (over = {}) => ({ id: 10, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7',
    app: { id: APP_ID }, status: 'completed', conclusion: 'success', ...over });
  const ORDERING = 'red-team check run ordering unreadable; inspect check history';
  const BAD_IDS = [['missing', undefined], ['null', null], ['zero', 0], ['negative', -1], ['fractional', 10.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2], ['a numeric string', '11'], ['NaN', Number.NaN]];

  it.each(BAD_IDS)('the gate refuses a head whose matching run id is %s, even beside a valid success', (_label, id) => {
    const bad = run({ id, conclusion: 'success' });
    if (id === undefined) delete bad.id;
    for (const checkRuns of [[run(), bad], [bad, run()], [bad]])
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }))
        .toEqual({ ok: false, reason: ORDERING });
  });

  it('a bad id on a run the gate does not read (other app, head, PR or name) does not refuse the head', () => {
    const checkRuns = [run(), run({ id: 'x', app: { id: 1 } }), run({ id: null, head_sha: OLD_HEAD }),
      run({ id: 0, name: 'test' }), run({ id: -1, external_id: 'o/r#8' }), run({ id: 10, external_id: 'o/r#8' })];
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }).ok).toBe(true);
  });

  it.each([false, true])('two matching runs sharing one id are unordered: the head is refused in either order (reverse=%s)', reverse => {
    const checkRuns = [run({ conclusion: 'failure' }), run()];
    if (reverse) checkRuns.reverse();
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }))
      .toEqual({ ok: false, reason: ORDERING });
    const gh = vi.fn(args => {
      if (args.includes('POST')) throw Error('must not post');
      return JSON.stringify({ total_count: 2, check_runs: checkRuns });
    });
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: `policy-clear check not posted: ${ORDERING}` });
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: ORDERING });
  });

  it.each(BAD_IDS)('the policy-clear writer keeps the refusal for an id that is %s and posts nothing', (_label, id) => {
    const bad = run({ id, status: 'in_progress', conclusion: null });
    if (id === undefined) delete bad.id;
    const gh = vi.fn(args => {
      if (args.includes('POST')) throw Error('must not post');
      return JSON.stringify({ total_count: 2, check_runs: [run(), bad] });
    });
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: `policy-clear check not posted: ${ORDERING}` });
    expect(gh.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
  });

  it('the bounded gate read keeps the refusal', () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 2, check_runs: [run(), run({ id: -3 })] }));
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: ORDERING });
  });
});
