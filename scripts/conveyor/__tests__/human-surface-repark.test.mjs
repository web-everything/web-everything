import { describe, it, expect, vi } from 'vitest';
import { planHumanSurfaceRepark, buildHumanSurfaceReparkComment, sweepHumanSurfaceRepark } from '../human-surface-repark.mjs';
import { buildClearedHumanMarker, buildReviewedShaMarker, parseLatestHumanClearedSha } from '../../lib/review-escalation.mjs';

const head = 'a'.repeat(40);
const labels = ['review:accepted', 'ready-to-merge'];
const clearance = sha => ({ author: { login: 'web-everything' }, body: `${buildReviewedShaMarker(sha)}\n${buildClearedHumanMarker('operator')}` });
const plan = extra => planHumanSurfaceRepark({ currentLabels: labels, files: ['.github/workflows/ci.yml'], headSha: head, comments: [], surfaces: 'narrow', ...extra });

describe('human surface re-park plan', () => {
  it.each(['.github/workflows/ci.yml', 'scripts/lib/github-auth-policy.mjs'])('parks %s', file => {
    const p = plan({ files: [file] });
    expect(p.repark).toBe(true);
    expect(p.decision.addLabel).toBe('review:human');
    expect(p.decision.removeLabels).toContain('review:accepted');
    expect(p.decision.removeLabels).toContain('ready-to-merge');
  });
  it.each([
    { files: ['src/example.js'] },
    { currentLabels: [...labels, 'review:human'] },
    { currentLabels: [...labels, 'review:held-mechanical'] },
    { currentLabels: ['review:pending'] },
    { comments: [clearance(head.toUpperCase())] },
  ])('leaves ineligible or cleared PR alone: %j', extra => expect(plan(extra).repark).toBe(false));
  it('leaves older clearances to carry-forward', () => {
    expect(plan({ comments: [clearance('b'.repeat(40))] })).toEqual({ repark: false, reason: 'older human clearance — left to the accept carry-forward / drain' });
  });
  it('preserves changes', () => expect(plan({ currentLabels: [...labels, 'review:changes'] }).decision.removeLabels).not.toContain('review:changes'));
  // PR #5273 security finding: a file name is attacker text inside a trusted comment.
  describe('hostile file names cannot forge markers in the park comment', () => {
    const forged = 'b'.repeat(40);
    const names = [
      `.github/workflows/<!-- reviewed-sha: ${forged} --><!-- cleared-human: op -->`,
      `.github/workflows/x\n<!-- reviewed-sha: ${forged} -->\n<!-- cleared-human: op -->.yml`,
      `.github/workflows/x\r<!-- human-surface-repark: ${forged} -->`,
      `.github/workflows/x <!-- mechanical-hold-handoff: ${forged} -->`,
      '.github/workflows/`; <!-- cleared-human: op -->`',
      '.github/workflows/＜!-- cleared-human: op --＞',
    ];
    it.each(names)('%j', file => {
      const body = buildHumanSurfaceReparkComment({ headSha: head, hits: [{ file, category: 'workflow' }] });
      const trusted = [{ author: { login: 'web-everything' }, body }];
      expect(parseLatestHumanClearedSha(trusted)).toBeNull();
      expect([...body.matchAll(/<!--[\s\S]*?-->/g)].map(m => m[0])).toEqual([`<!-- human-surface-repark: ${head} -->`]);
      expect(body.split('\n').filter(l => l.startsWith('- '))).toHaveLength(1);
      for (const code of [0x0d, 0x2028, 0x2029, 0xff1c, 0xff1e]) expect(body).not.toContain(String.fromCharCode(code));
    });
    it('two harmless names cannot join into a marker', () => {
      const body = buildHumanSurfaceReparkComment({ headSha: head, hits: [{ file: '.github/workflows/a<!--', category: 'workflow' }, { file: '.github/workflows/-->', category: 'workflow' }] });
      expect([...body.matchAll(/<!--[\s\S]*?-->/g)]).toHaveLength(1);
    });
    it('refuses a non-sha head instead of embedding it', () => {
      expect(() => buildHumanSurfaceReparkComment({ headSha: `${head} --><!-- cleared-human: op`, hits: [] })).toThrow(/head/);
    });
  });
  it('names the head, hits and recovery ceremony', () => {
    const body = buildHumanSurfaceReparkComment({ headSha: head, hits: plan().hits });
    for (const s of [head, head.slice(0, 9), '.github/workflows/ci.yml', 'workflow', 'review:accepted', 'review-set-label.mjs --to=clear-human']) expect(body).toContain(s);
  });
});

function fixture(overrides = {}) {
  const calls = [];
  const state = { state: 'OPEN', headRefOid: head, labels };
  const provider = {
    readPrState: vi.fn(() => state), readPrFiles: () => ['.github/workflows/ci.yml'],
    postComment: (...args) => calls.push(['comment', ...args]), setLabels: (...args) => calls.push(['labels', ...args]),
    ...overrides,
  };
  const run = extra => sweepHumanSurfaceRepark({ repo: 'o/n', listPrs: () => [{ number: 7, labels }], provider, readComments: () => [], resolveSurfaces: () => 'narrow', readNetFiles: () => ({ ok: true, files: ['.github/workflows/ci.yml'] }), ...extra });
  return { calls, provider, run, state };
}
describe('human surface re-park sweep', () => {
  it('PR #5381: ignores an identity file inherited from main in GitHub’s list', () => {
    const f = fixture({ readPrFiles: vi.fn(() => ['scripts/settings/delivery-identity.json', 'scripts/example.mjs']) });
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['scripts/example.mjs'] }));
    expect(f.run({ readNetFiles })).toEqual([]);
    expect(readNetFiles).toHaveBeenCalledWith({ repo: 'o/n', number: 7, headRefOid: head });
    expect(f.provider.readPrFiles).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it('re-parks an identity file actually present in the net diff', () => {
    const f = fixture();
    expect(f.run({ readNetFiles: () => ({ ok: true, files: ['scripts/settings/delivery-identity.json'] }) })[0].files)
      .toEqual(['scripts/settings/delivery-identity.json']);
    expect(f.calls[0][3]).toContain('(identity)');
    expect(f.calls[1][3].add).toBe('review:human');
  });
  it.each(['fetch failed', 'missing head commit'])('fails closed and explains %s', reason => {
    const f = fixture({ readPrFiles: () => ['scripts/settings/delivery-identity.json'] });
    expect(f.run({ readNetFiles: () => ({ ok: false, reason }) })[0].repark).toBe('reparked');
    expect(f.calls[0][3]).toContain(reason);
    expect(f.calls[0][3]).toContain('Net file set unavailable');
  });
  it('skips clean GitHub lists across a sweep-wide net outage', () => {
    const f = fixture({ readPrFiles: () => ['scripts/example.mjs'] });
    const results = f.run({
      listPrs: () => [7, 8, 9].map(number => ({ number, labels })),
      readNetFiles: () => { throw new Error('fetch failed'); },
    });
    expect(results).toHaveLength(3);
    expect(results.every(result => result.skipped)).toBe(true);
    expect(results.filter(result => result.repark === 'reparked')).toHaveLength(0);
    expect(f.calls).toEqual([]);
  });
  it.each([{ ok: true }, { ok: true, files: [null] }, { ok: true, files: Array(1) }])('fails closed for malformed net result %j', net => {
    const f = fixture();
    expect(f.run({ readNetFiles: () => net })[0].repark).toBe('reparked');
    expect(f.calls[0][3]).toContain('no usable array');
  });
  it('re-parks a sensitive old rename path during a net outage', () => {
    const f = fixture({ readPrFiles: () => ['archive/ci.yml', '.github/workflows/ci.yml'] });
    expect(f.run({ readNetFiles: () => ({ ok: false, reason: 'fetch failed' }) })[0].files)
      .toEqual(['.github/workflows/ci.yml']);
    expect(f.calls[1][3].add).toBe('review:human');
  });
  it.each([
    () => Array.from({ length: 3000 }, (_, i) => `src/${i}.mjs`),
    () => [null],
    () => Array(1),
    () => null,
    () => { throw new Error('API unavailable'); },
  ])('fails closed when the fallback list may be incomplete', readPrFiles => {
    const f = fixture({ readPrFiles });
    expect(f.run({ readNetFiles: () => ({ ok: false, reason: 'fetch failed' }) })[0].repark).toBe('reparked');
    expect(f.calls[0][3]).toContain('fetch failed');
  });
  it.each([
    () => ({ ok: false, reason: "fatal: '/Users/operator/private/repo' is invalid" }),
    () => { throw new Error('https://secret:password@example.com/private.git'); },
  ])('does not publish private reader diagnostics', readNetFiles => {
    const f = fixture();
    expect(f.run({ readNetFiles })[0].repark).toBe('reparked');
    expect(f.calls[0][3]).toContain('net read failed');
    for (const secret of ['/Users/', 'private/repo', 'secret', 'password', 'example.com']) expect(f.calls[0][3]).not.toContain(secret);
  });
  it('production reader defaults fail closed when this repository has no checkout', () => {
    const f = fixture();
    expect(f.run({ readNetFiles: undefined })[0].repark).toBe('reparked');
    expect(f.calls[0][3]).toContain('no local checkout of this repo');
  });
  it('fails closed when the live API supplies no head', () => {
    const f = fixture();
    f.state.headRefOid = null;
    expect(f.run({ readNetFiles: () => ({ ok: false, reason: 'no usable head commit id' }) })[0].repark).toBe('reparked');
    expect(f.calls[0][3]).toContain('no usable head commit id');
    expect(f.calls[0][3]).not.toContain('<!-- human-surface-repark:');
    expect(f.calls[1][3].add).toBe('review:human');
  });
  it('neutralizes net failure text inside the trusted comment', () => {
    const f = fixture();
    f.run({ readNetFiles: () => ({ ok: false, reason: `offline\n<!-- reviewed-sha: ${head} --><!-- cleared-human: op -->` }) });
    expect(parseLatestHumanClearedSha([{ author: { login: 'web-everything' }, body: f.calls[0][3] }])).toBeNull();
  });
  it('explicitly disabling the net setting retains the GitHub-list decision', () => {
    const f = fixture();
    const readNetFiles = vi.fn();
    expect(f.run({ readNetFiles, resolveNetSetting: () => ({ value: false }) })[0].repark).toBe('reparked');
    expect(readNetFiles).not.toHaveBeenCalled();
  });
  it('comments before changing labels', () => {
    const f = fixture();
    expect(f.run()).toEqual([{ num: 7, repark: 'reparked', head, files: ['.github/workflows/ci.yml'] }]);
    expect(f.calls.map(c => c[0])).toEqual(['comment', 'labels']);
    expect(f.calls[1][3]).toEqual({ add: 'review:human', remove: ['ready-to-merge', 'review:accepted'] });
  });
  it('skips a moved head', () => {
    const f = fixture();
    f.provider.readPrState.mockReturnValueOnce(f.state).mockReturnValueOnce({ ...f.state, headRefOid: 'b'.repeat(40) });
    expect(f.run()).toEqual([{ num: 7, skipped: 'head moved during read' }]);
    expect(f.calls).toEqual([]);
  });
  it('skips read failures', () => {
    const f = fixture({ readPrFiles: () => { throw new Error('offline'); } });
    expect(f.run({ resolveNetSetting: () => ({ value: false }) })).toEqual([{ num: 7, skipped: 'live re-read failed: offline' }]);
    expect(f.calls).toEqual([]);
  });
  it('uses fresh labels after the second read', () => {
    const f = fixture();
    f.provider.readPrState.mockReturnValueOnce(f.state).mockReturnValueOnce({ ...f.state, labels: [...labels, 'review:human'] });
    expect(f.run()).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it.each([false, true])('skips a fresh comments page that can hide concurrent clearance (dryRun=%s)', dryRun => {
    const f = fixture();
    const thread = Array.from({ length: 101 }, (_, i) => ({ id: `C_${i}`, body: `discussion ${i}` }));
    const readComments = vi.fn(() => {
      const snapshot = [...thread];
      // A ceremony lands after the complete read, beyond the state's first page.
      thread.push({ id: 'C_clear', ...clearance(head) });
      return snapshot;
    });
    f.provider.readPrState.mockImplementation(() => ({ ...f.state, comments: thread.slice(0, 100) }));
    expect(f.run({ readComments, dryRun })).toEqual([{ num: 7, skipped: 'fresh comments may be truncated' }]);
    expect(readComments).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
  });
  it('skips even an exactly full fresh page when the earlier complete read was short', () => {
    const f = fixture();
    f.provider.readPrState.mockReturnValueOnce(f.state).mockReturnValueOnce({
      ...f.state, comments: Array.from({ length: 100 }, (_, i) => ({ id: `C_${i}`, body: 'discussion' })),
    });
    expect(f.run()).toEqual([{ num: 7, skipped: 'fresh comments may be truncated' }]);
    expect(f.calls).toEqual([]);
  });
  it('still re-parks when the fresh thread is below the page limit', () => {
    const f = fixture();
    f.provider.readPrState.mockReturnValue({
      ...f.state, comments: Array.from({ length: 99 }, (_, i) => ({ id: `C_${i}`, body: 'discussion' })),
    });
    expect(f.run()[0].repark).toBe('reparked');
    expect(f.calls.map(c => c[0])).toEqual(['comment', 'labels']);
  });
  it.each([false, true])('preserves a concurrent clear-human ceremony (dryRun=%s)', dryRun => {
    const f = fixture();
    const readComments = vi.fn(() => {
      // The operator clears this unchanged head after the comments read.
      f.provider.readPrState.mockReturnValue({ ...f.state, comments: [clearance(head)] });
      return [];
    });
    expect(f.run({ readComments, dryRun })).toEqual([]);
    expect(readComments).toHaveBeenCalledOnce();
    expect(f.provider.readPrState).toHaveBeenCalledTimes(2);
    expect(f.calls).toEqual([]);
  });
  it('preserves clearance from the dedicated comments read when the state has no clearance', () => {
    const f = fixture();
    // The state's first page can end at an older plain acceptance.
    const olderAcceptance = {
      author: { login: 'web-everything' }, body: buildReviewedShaMarker(head),
    };
    f.provider.readPrState.mockReturnValue({ ...f.state, comments: [olderAcceptance] });
    expect(f.run({ readComments: () => [olderAcceptance, clearance(head)] })).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it('ignores an untrusted clearance in the fresh state', () => {
    const f = fixture();
    f.provider.readPrState.mockReturnValue({ ...f.state, comments: [{ ...clearance(head), author: { login: 'outsider' } }] });
    expect(f.run()[0].repark).toBe('reparked');
    expect(f.calls.map(c => c[0])).toEqual(['comment', 'labels']);
  });
  it('does not resurrect clearance from a truncated fresh prefix after a newer plain acceptance', () => {
    const f = fixture();
    const oldClearance = clearance('b'.repeat(40));
    const acceptance = { author: { login: 'web-everything' }, body: buildReviewedShaMarker(head) };
    f.provider.readPrState.mockReturnValue({ ...f.state, comments: [oldClearance] });
    expect(f.run({ readComments: () => [oldClearance, acceptance] })[0].repark).toBe('reparked');
    expect(f.calls.map(c => c[0])).toEqual(['comment', 'labels']);
  });
  it('observes an edited comment without moving it past newer acceptance', () => {
    const f = fixture();
    const oldClearance = { id: 'C_old', ...clearance('b'.repeat(40)) };
    const acceptance = { id: 'C_new', author: { login: 'web-everything' }, body: buildReviewedShaMarker(head) };
    f.provider.readPrState.mockReturnValue({ ...f.state, comments: [{ ...oldClearance, ...clearance(head) }] });
    expect(f.run({ readComments: () => [oldClearance, acceptance] })[0].repark).toBe('reparked');
  });
  it('observes clearance added by editing an existing comment', () => {
    const f = fixture();
    const oldAcceptance = { id: 'C_existing', author: { login: 'web-everything' }, body: buildReviewedShaMarker(head) };
    f.provider.readPrState.mockReturnValue({ ...f.state, comments: [{ id: 'C_existing', ...clearance(head) }] });
    expect(f.run({ readComments: () => [oldAcceptance] })).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it('observes a new ceremony with the same body as an older, superseded clearance', () => {
    const f = fixture();
    const oldClearance = { id: 'C_old', ...clearance(head) };
    const acceptance = { id: 'C_accept', author: { login: 'web-everything' }, body: buildReviewedShaMarker(head) };
    f.provider.readPrState.mockReturnValue({ ...f.state, comments: [oldClearance, acceptance, { id: 'C_new', ...clearance(head) }] });
    expect(f.run({ readComments: () => [oldClearance, acceptance] })).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it('skips incomplete comments', () => {
    const f = fixture();
    expect(f.run({ readComments: () => null })).toEqual([{ num: 7, skipped: 'live re-read failed: comments read returned no array' }]);
    expect(f.calls).toEqual([]);
  });
  it('does not write in dry-run', () => {
    const f = fixture();
    expect(f.run({ dryRun: true })[0].repark).toBe('would-repark');
    expect(f.calls).toEqual([]);
  });
  // PR #5273 red team: the ceremony completes while the sweep's own write is in flight (after its final read).
  function racing({ during = 'comment', readCommentsFails = false, bounce = false } = {}) {
    const live = { state: 'OPEN', headRefOid: head, labels: [...labels], comments: [] };
    const effects = [];
    let reads = 0;
    const clear = () => {
      // The label-less clear-human ceremony: swap (accepted already live) then the trusted clearance comment.
      live.labels = [...new Set([...live.labels.filter(l => l !== 'review:human'), 'review:accepted'])];
      live.comments.push({ id: 'C_clear', ...clearance(head) });
      // A changes bounce after the ceremony carries no reviewed-sha marker, so the clearance stays "latest".
      if (bounce) live.labels = [...live.labels.filter(l => l !== 'review:accepted'), 'review:changes'];
    };
    const provider = {
      readPrState: () => ({ ...live, labels: [...live.labels], comments: [...live.comments] }),
      readPrFiles: () => ['.github/workflows/ci.yml'],
      postComment: (_r, _n, body) => {
        effects.push('comment');
        live.comments.push({ id: 'C_park', author: { login: 'web-everything' }, body });
        if (during === 'comment') clear();
      },
      setLabels: (_r, _n, { add, remove = [] }) => {
        effects.push(`labels:+${add}-${remove.join(',')}`);
        live.labels = [...new Set([...live.labels.filter(l => !remove.includes(l)), add])];
        if (during === 'labels') clear();
      },
    };
    const readComments = () => {
      reads++;
      if (readCommentsFails && reads > 1) throw new Error('offline');
      return [...live.comments];
    };
    const results = sweepHumanSurfaceRepark({ repo: 'o/n', listPrs: () => [{ number: 7, labels }], provider, readComments, resolveSurfaces: () => 'narrow', readNetFiles: () => ({ ok: true, files: ['.github/workflows/ci.yml'] }) });
    return { live, effects, results };
  }
  it.each(['comment', 'labels'])('keeps a clear-human ceremony that completes during the sweep %s write', during => {
    const r = racing({ during });
    expect(r.live.labels).toContain('review:accepted');
    expect(r.live.labels).not.toContain('review:human');
    expect(r.results).toEqual([{ num: 7, repark: 'withdrawn', head, files: ['.github/workflows/ci.yml'], reason: 'human clearance at the live head landed during the write' }]);
  });
  it('does not add review:accepted beside a review:changes bounce that followed the ceremony', () => {
    const r = racing({ during: 'comment', bounce: true });
    expect(r.live.labels).not.toContain('review:accepted');
    expect(r.live.labels).toContain('review:changes');
    expect(r.results[0].repark).toBe('reparked');
  });
  it('withdraws without a failed remove when the ceremony already removed review:human', () => {
    const r = racing({ during: 'labels' });
    expect(r.effects.at(-1)).toBe('labels:+review:human-ready-to-merge,review:accepted');
    expect(r.results[0]).not.toHaveProperty('error');
  });
  it('leaves the hold (fail closed) and reports when the post-write read fails', () => {
    const r = racing({ during: 'none', readCommentsFails: true });
    expect(r.live.labels).toContain('review:human');
    expect(r.results[0]).toMatchObject({ num: 7, repark: 'reparked', error: 'post-write clearance check failed: offline' });
  });
  describe('heal of a park that lost the race and was never re-checked', () => {
    const PARK_AT = '2026-10-14T10:00:00Z';
    const park = { id: 'C_park', createdAt: PARK_AT, author: { login: 'web-everything' }, body: buildHumanSurfaceReparkComment({ headSha: head, hits: [] }) };
    // The park's own label write, seconds after its comment.
    const ownAdd = [{ event: 'labeled', label: 'review:human', createdAt: '2026-10-14T10:00:02Z' }];
    function heal({ labels: l = ['review:human', 'ready-to-merge'], comments = [park, { id: 'C_clear', ...clearance(head) }], dryRun = false, headRefOid = head, events = ownAdd } = {}) {
      const live = { state: 'OPEN', headRefOid, labels: [...l], comments };
      const effects = [];
      const provider = {
        readPrState: () => ({ ...live, labels: [...live.labels] }), readPrFiles: () => ['.github/workflows/ci.yml'],
        postComment: () => effects.push('comment'),
        setLabels: (_r, _n, { add, remove = [] }) => { effects.push({ add, remove }); live.labels = [...new Set([...live.labels.filter(x => !remove.includes(x)), add])]; },
      };
      const readLabelEvents = () => { if (events instanceof Error) throw events; return events; };
      const results = sweepHumanSurfaceRepark({ repo: 'o/n', listPrs: () => [{ number: 7, labels: l }], provider, readComments: () => [...comments], readLabelEvents, resolveSurfaces: () => 'narrow', dryRun });
      return { live, effects, results };
    }
    // PR #5273 correctness finding: a foreign hold added after the clearance, with no comment, must survive.
    it.each([
      ['a foreign add long after the park', [...ownAdd, { event: 'unlabeled', label: 'review:human', createdAt: '2026-10-14T10:05:00Z' }, { event: 'labeled', label: 'review:human', createdAt: '2026-10-14T11:00:00Z' }]],
      ['an add before the park comment', [{ event: 'labeled', label: 'review:human', createdAt: '2026-10-14T09:00:00Z' }]],
      ['a removal as the latest event', [...ownAdd, { event: 'unlabeled', label: 'review:human', createdAt: '2026-10-14T10:01:00Z' }]],
      ['no label event', []],
    ])('keeps the hold with %s', (_name, events) => {
      const r = heal({ events });
      expect(r.live.labels).toContain('review:human');
      expect(r.effects).toEqual([]);
    });
    it('keeps the hold and reports when label events are unreadable', () => {
      const r = heal({ events: new Error('offline') });
      expect(r.live.labels).toContain('review:human');
      expect(r.results).toEqual([{ num: 7, skipped: 'heal read failed: offline' }]);
    });
    it('keeps the hold when the park comment has no timestamp', () => {
      const r = heal({ comments: [{ ...park, createdAt: undefined }, { id: 'C_clear', ...clearance(head) }] });
      expect(r.effects).toEqual([]);
    });
    it('withdraws its own marked park beside a clearance of the live head', () => {
      const r = heal();
      expect(r.live.labels).toEqual(['ready-to-merge', 'review:accepted']);
      expect(r.results).toEqual([{ num: 7, repark: 'withdrawn', head, reason: 'healed a park that lost a race with a human clearance' }]);
    });
    it('withdraws a marked park beside review:accepted when the park marker is the last trusted comment', () => {
      const r = heal({ labels: ['review:human', 'review:accepted'], comments: [{ id: 'C_clear', ...clearance(head) }, park] });
      expect(r.effects).toEqual([{ add: 'review:accepted', remove: ['review:human'] }]);
    });
    it('leaves review:human beside review:accepted when the clearance is last (a keep-clearance park may not have commented yet)', () => {
      const r = heal({ labels: ['review:human', 'review:accepted'] });
      expect(r.effects).toEqual([]);
    });
    it('withdraws a mechanical-hold hand-off park whose own re-check never ran', () => {
      const handoff = { id: 'C_handoff', createdAt: PARK_AT, author: { login: 'web-everything' }, body: `🧑‍⚖️ review — mechanical hold handed to the operator\n\n<!-- mechanical-hold-handoff: ${head} -->` };
      const r = heal({ comments: [{ id: 'C_clear', ...clearance(head) }, handoff] });
      expect(r.live.labels).toContain('review:accepted');
      expect(r.live.labels).not.toContain('review:human');
    });
    it('does not read in full a short listed thread with no park marker', () => {
      const readPrState = vi.fn();
      const readComments = vi.fn();
      const results = sweepHumanSurfaceRepark({ repo: 'o/n', listPrs: () => [{ number: 7, labels: ['review:human'], comments: [{ body: 'hi' }] }], provider: { readPrState }, readComments, resolveSurfaces: () => 'narrow' });
      expect(results).toEqual([]);
      expect(readPrState).not.toHaveBeenCalled();
      expect(readComments).not.toHaveBeenCalled();
    });
    it('reports only, in dry-run', () => {
      const r = heal({ dryRun: true });
      expect(r.effects).toEqual([]);
      expect(r.results).toEqual([{ num: 7, repark: 'would-withdraw', head }]);
    });
    it.each([
      ['no marker (another park)', { comments: [{ id: 'C_clear', ...clearance(head) }] }],
      ['a marker for an older head', { comments: [{ ...park, body: buildHumanSurfaceReparkComment({ headSha: 'b'.repeat(40), hits: [] }) }, { id: 'C_clear', ...clearance(head) }] }],
      ['an untrusted marker', { comments: [{ ...park, author: { login: 'outsider' } }, { id: 'C_clear', ...clearance(head) }] }],
      ['no clearance of the live head', { comments: [park, { id: 'C_clear', ...clearance('b'.repeat(40)) }] }],
      ['a later trusted comment (another hold may have re-added review:human)', { comments: [park, { id: 'C_clear', ...clearance(head) }, { id: 'C_rearm', author: { login: 'web-everything' }, body: '🔁 review re-armed' }] }],
      ['a review:changes bounce', { labels: ['review:human', 'review:changes'] }],
      ['a mechanical hold', { labels: ['review:human', 'review:held-mechanical'] }],
    ])('leaves the hold with %s', (_name, extra) => {
      const r = heal(extra);
      expect(r.live.labels).toContain('review:human');
      expect(r.effects).toEqual([]);
    });
  });
  it('re-parks when no clearance lands during the write', () => {
    const r = racing({ during: 'none' });
    expect(r.live.labels).toEqual(['review:human']);
    expect(r.results).toEqual([{ num: 7, repark: 'reparked', head, files: ['.github/workflows/ci.yml'] }]);
  });
  it('does not change labels after a failed comment', () => {
    const f = fixture({ postComment: () => { throw new Error('offline'); } });
    expect(f.run()[0].error).toBe('offline');
    expect(f.calls).toEqual([]);
  });
});
