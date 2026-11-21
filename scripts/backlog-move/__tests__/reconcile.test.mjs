/** D18 dry-run authority, manifest integrity and read-only CLI regression tests. */
import { describe, it, expect } from 'vitest';
import { buildManifest, verifyManifest, transform, digest } from '../manifest.mjs';
import { reconcile } from '../reconcile.mjs';
import { parseArgs, main } from '../cli.mjs';

const sha = 'a'.repeat(40), mainSha = 'b'.repeat(40), destSha = 'c'.repeat(40);
const sourcePath = 'backlog/083-agent-file-lock-coordination.md';
const bytes = Buffer.from('---\nkind: decision\n---\n\nPlacement: plateau-app\nA daemon gate.\n');
const make = () => buildManifest({ sourceSha: sha, cards: [{ sourcePath, bytes }] });
const row = () => make().cards[0];
const crashAssertion = (fn) => expect(fn({ ...row(), state: 'copy' }, 'same', 'destDigest', false).action).toBe('reconcile-links');

describe('cross-repo authority', () => {
  it('a crash after the destination merge but before the manifest update resumes at reconcile-links, not copy', () => crashAssertion(reconcile));
  it('rejects a mutation that trusts manifest state over F2', () => {
    const mutant = (r, f1, f2, f3) => r.state === 'copy' ? { action: 'copy' } : reconcile(r, f1, f2, f3);
    expect(() => crashAssertion(mutant)).toThrow();
  });
  it('every fact combination maps to exactly one action; unreadable stops, never quarantines or advances', () => {
    for (const state of ['snapshot', 'copy', 'verify', 'cutover', 'reconcile-links', 'done', 'quarantined'])
      for (const f1 of ['same', 'changed', 'stub', 'absent', 'unreadable'])
        for (const f2 of ['absent', 'destDigest', 'other', 'unreadable'])
          for (const f3 of [false, true]) {
            const r = { ...row(), state }, result = reconcile(r, f1, f2, f3);
            const expected = f1 === 'unreadable' || f2 === 'unreadable' ? 'stop'
              : state === 'quarantined' || f3 || f2 === 'other' || f1 === 'changed' && f2 === 'destDigest'
                || f2 === 'absent' && ['stub', 'absent'].includes(f1) ? 'quarantine'
                : f2 === 'destDigest' ? f1 === 'stub' ? 'done' : 'reconcile-links'
                  : f1 === 'changed' ? 'snapshot-again' : 'copy';
            expect(result.action).toBe(expected);
            expect(Object.keys(result).sort()).toEqual(result.severity ? ['action', 'reason', 'severity'] : ['action', 'reason']);
            expect(result.reason).toBeTruthy();
          }
  });
  it.each([
    ['changed after snapshot', 'changed', 'destDigest', false],
    ['other destination digest', 'same', 'other', false],
    ['destId taken', 'same', 'absent', true],
  ])('quarantines %s', (_, f1, f2, f3) => expect(reconcile(row(), f1, f2, f3).action).toBe('quarantine'));
  it.each(['same', 'stub'])('every observed destination-ID collision quarantines even with matching destination bytes and a %s source', (f1) => {
    expect(reconcile(row(), f1, 'destDigest', true)).toMatchObject({ action: 'quarantine', reason: expect.stringContaining('Destination id taken') });
  });
  it.each(['stub', 'absent'])('treats missing destination with source %s as high severity and names restoration', (f1) => {
    expect(reconcile(row(), f1, 'absent', false)).toMatchObject({ action: 'quarantine', severity: 'high', reason: expect.stringContaining('sourceSha') });
  });
  it('a quarantined row never advances on re-run', () => {
    expect(reconcile({ ...row(), state: 'quarantined' }, 'stub', 'destDigest', false).action).toBe('quarantine');
  });
  it('unknown or incomplete evidence stops for operator inspection', () => {
    for (const args of [[null, 'same', 'absent', false], [row(), '?', 'absent', false], [row(), 'same', '?', false], [row(), 'same', 'absent', null]])
      expect(reconcile(...args)).toMatchObject({ action: 'stop', reason: expect.stringContaining('inspect') });
  });
});

describe('manifest', () => {
  it('transform is deterministic and bornAs is locus-qualified', () => {
    const m = make(), r = m.cards[0];
    expect(make()).toEqual(m);
    expect(r).toMatchObject({ bornAs: 'we:#083', sourcePath, sourceDigest: digest(bytes), destId: '083', classification: 'plateau-app', rule: 'explicit-placement', state: 'snapshot', result: null, quarantineReason: null });
    const dest = transform(bytes, '123', r.bornAs);
    expect(dest).toEqual(transform(bytes, '123', r.bornAs));
    expect(dest.toString()).toContain('id: "123"\nformerly: "we:#083"\n');
    expect(verifyManifest(m, [{ sourcePath, bytes }])).toBe(true);
  });
  it('refuses manifest digests not matching the source or transformed bytes', () => {
    for (const field of ['sourceDigest', 'destDigest']) {
      const m = make(); m.cards[0][field] = '0'.repeat(64);
      expect(() => verifyManifest(m, [{ sourcePath, bytes }])).toThrow(/digest/);
    }
    expect(() => verifyManifest(make(), [{ sourcePath, bytes: Buffer.concat([bytes, Buffer.from('edit')]) }])).toThrow(/digest/);
  });
  it('refuses missing snapshots, duplicate ids, malformed paths and unsure classifications', () => {
    expect(() => verifyManifest(make(), [])).toThrow();
    expect(() => buildManifest({ sourceSha: sha, cards: [{ sourcePath, bytes }, { sourcePath, bytes }] })).toThrow();
    expect(() => buildManifest({ sourceSha: sha, cards: [{ sourcePath: '../083.md', bytes }] })).toThrow();
    expect(() => buildManifest({ sourceSha: sha, cards: [{ sourcePath, bytes: Buffer.from('---\nkind: idea\n---\nNo signal') }] })).toThrow(/classification/);
    expect(() => transform(Buffer.from('broken'), '083', 'we:#083')).toThrow();
  });
});

function harness({ absent = true, fail, changed = false, collision = false, alternate = false, sourceTreeFailure = false, oversized = false, incidentalStub = false, malformedListing = false, arbitraryBytes = false, coexist = false, stub = false } = {}) {
  const calls = [], output = [], env = { GH_TOKEN: 'ghs_fixture', GIT_DIR: 'hostile', GIT_WORK_TREE: 'hostile' };
  const run = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (bin === 'git') {
      expect(opts.env.GIT_DIR).toBeUndefined(); expect(opts.env.GIT_WORK_TREE).toBeUndefined();
      expect(args[0]).toBe('--literal-pathspecs');
      if (args.includes('rev-parse')) return args.at(-1).includes('origin/main') ? mainSha : sha;
      if (args.includes('ls-tree')) {
        if (sourceTreeFailure && args.includes(mainSha)) throw new Error('tree unreadable');
        return `${sourcePath}\0backlog/375-inbound.md\0`;
      }
      if (args.at(-1).endsWith('375-inbound.md')) return Buffer.from('See #083 and 083-agent-file-lock-coordination.md');
      if (args.at(-1).startsWith(mainSha) && stub) return Buffer.from('moved to a private store');
      if (args.at(-1).startsWith(mainSha) && incidentalStub) return Buffer.concat([bytes, Buffer.from('Discussion: moved to a private store is a future step.')]);
      return changed && args.at(-1).startsWith(mainSha) ? Buffer.concat([bytes, Buffer.from('edit')]) : bytes;
    }
    expect(args.slice(0, 2)).toEqual(['api', '--method=GET']);
    if (fail) throw Object.assign(new Error('remote unavailable'), { stderr: 'HTTP 503' });
    const endpoint = args[2];
    if (endpoint.endsWith('/plateau-app')) return JSON.stringify({ default_branch: 'main' });
    if (endpoint.includes('/commits/')) return JSON.stringify({ sha: destSha });
    expect(endpoint).toContain(`ref=${destSha}`);
    if (absent) throw Object.assign(new Error('not found'), { stderr: 'HTTP 404' });
    if (endpoint.includes('/contents/backlog?')) return JSON.stringify(malformedListing ? [{}] : oversized ? Array.from({ length: 1000 }, () => ({})) : [{ name: alternate ? '083-other.md' : sourcePath.split('/')[1], type: 'file' }, ...(coexist ? [{ name: '083-other.md', type: 'file' }] : [])]);
    return JSON.stringify({ encoding: 'base64', content: (arbitraryBytes ? Buffer.from('other bytes') : collision || coexist && endpoint.includes('/083-other.md?') ? Buffer.from('---\nid: "083"\nformerly: "we:#999"\n---\n') : transform(bytes, '083', 'we:#083')).toString('base64') });
  };
  return { calls, output, env, run, print: (s) => output.push(JSON.parse(s)), read: () => JSON.stringify(make()), now: () => new Date('2026-11-21T19:00:00Z') };
}
const planArgs = ['plan', '--cards', '083', '--source-sha', sha];
describe('read-only CLI', () => {
  it('parses only plan/status arguments; no write flags exist', () => {
    expect(parseArgs(planArgs)).toMatchObject({ command: 'plan', cards: ['083'], sourceSha: sha });
    expect(parseArgs(['status', '--manifest', 'saved.json'])).toMatchObject({ command: 'status', manifest: 'saved.json' });
    for (const args of [[...planArgs, '--write'], [...planArgs, '--push'], ['plan'], [...planArgs, '--cards', '1']]) expect(() => parseArgs(args)).toThrow();
  });
  it('refuses without an App token env before any IO, including personal tokens', () => {
    for (const env of [{}, { GH_TOKEN: 'ghp_personal' }]) {
      let called = false;
      expect(() => main(planArgs, { env, run: () => { called = true; } })).toThrow(/App token/);
      expect(called).toBe(false);
    }
  });
  it('prints pinned source/destination facts, inbound links and ET without writes', () => {
    const io = harness(); expect(main(planArgs, io)).toBe(0);
    const out = io.output[0];
    expect(out).toMatchObject({ sourceSha: sha, sourceMainSha: mainSha, destinationMainSha: destSha, timeET: expect.stringContaining('14:00'), cards: [expect.objectContaining({ sourcePath, sourceDigest: digest(bytes), target: 'plateau-app', rule: 'explicit-placement', F1: 'same', F2: 'absent', F3: false, inboundLinks: ['backlog/375-inbound.md'], next: expect.objectContaining({ action: 'copy' }) })] });
    expect(io.calls.length).toBeLessThan(15);
  });
  it('status verifies snapshots and recovers a stale copy state from default-branch bytes', () => {
    const io = harness({ absent: false }); const m = make(); m.cards[0].state = 'copy'; io.read = () => JSON.stringify(m);
    expect(main(['status', '--manifest', 'saved.json'], io)).toBe(0);
    expect(io.output[0].cards[0].next.action).toBe('reconcile-links');
  });
  it.each([{ fail: true }, { absent: false, changed: true }, { absent: false, collision: true }])('stops the batch on unreadable/divergent evidence: %j', (options) => {
    const io = harness(options); expect(main(planArgs, io)).toBe(2);
    expect(['stop', 'quarantine']).toContain(io.output[0].cards[0].next.action);
  });
  it('an unreadable source tree stops rather than declaring the source absent', () => {
    const io = harness({ sourceTreeFailure: true }); expect(main(planArgs, io)).toBe(2);
    expect(io.output[0].cards[0]).toMatchObject({ F1: 'unreadable', next: { action: 'stop' } });
  });
  it('a taken id at another destination filename quarantines while F2 is absent', () => {
    const io = harness({ absent: false, alternate: true, collision: true }); expect(main(planArgs, io)).toBe(2);
    expect(io.output[0].cards[0]).toMatchObject({ F2: 'absent', F3: true, next: { action: 'quarantine' } });
  });
  it.each([false, true])('coexisting destination files stop the CLI despite matching destination bytes (source stub=%s)', (stub) => {
    const io = harness({ absent: false, coexist: true, stub }); expect(main(planArgs, io)).toBe(2);
    expect(io.output[0].cards[0]).toMatchObject({ F1: stub ? 'stub' : 'same', F2: 'destDigest', F3: true, next: { action: 'quarantine' } });
  });
  it('an incidental stub phrase in live content cannot finish the migration', () => {
    const io = harness({ absent: false, incidentalStub: true }); expect(main(planArgs, io)).toBe(2);
    expect(io.output[0].cards[0]).toMatchObject({ F1: 'changed', next: { action: 'quarantine' } });
  });
  it('an oversized or truncated destination listing stops for operator inspection', () => {
    const io = harness({ absent: false, oversized: true }); expect(main(planArgs, io)).toBe(2);
    expect(io.output[0].cards[0]).toMatchObject({ F2: 'unreadable', next: { action: 'stop', reason: expect.stringContaining('inspect') } });
  });
  it('incomplete listing evidence never becomes destination absent', () => {
    const io = harness({ absent: false, malformedListing: true }); expect(main(planArgs, io)).toBe(2);
    expect(io.output[0].cards[0]).toMatchObject({ F2: 'unreadable', next: { action: 'stop' } });
  });
  it('other destination bytes quarantine even without recognizable frontmatter', () => {
    const io = harness({ absent: false, arbitraryBytes: true }); expect(main(planArgs, io)).toBe(2);
    expect(io.output[0].cards[0]).toMatchObject({ F2: 'other', next: { action: 'quarantine' } });
  });
  it('refuses oversized selection with an operator fallback', () => {
    expect(() => parseArgs(['plan', '--cards', Array.from({ length: 21 }, (_, i) => String(i)).join(','), '--source-sha', sha])).toThrow(/smaller batch/);
  });
});
