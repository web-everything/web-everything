/** @file Mechanical refresh admission: injected evidence, never network. */
import { describe, it, expect } from 'vitest';
import { validateMechanicalClearance, readMechanicalClearanceFacts, recordMechanicalClearance, decideMechanicalLabelStrip,
  REQUIRED_MECHANICAL_CHECKS, GITHUB_ACTIONS_APP_ID } from '../mechanical-clearance.mjs';

const head = 'a'.repeat(40);
const path = 'scripts/ci/test-timings.json';
const testPath = 'scripts/lib/__tests__/sample.test.mjs';
const facts = () => ({ head, author: { login: 'web-everything[bot]', type: 'Bot' }, commitCount: 1,
  commits: [{ author: { login: 'github-actions[bot]' }, committer: { login: 'github-actions[bot]' } }],
  files: [{ filename: path, status: 'modified' }],
  baseEntry: { type: 'blob', mode: '100644' }, headEntry: { type: 'blob', mode: '100644' },
  content: JSON.stringify({ _doc: 'Seconds', unit: { [testPath]: 450 }, soak: { [testPath]: 1 } }),
  baseContent: JSON.stringify({ unit: { [testPath]: 450 }, soak: { [testPath]: 1 } }),
  existingFiles: [testPath], checks: REQUIRED_MECHANICAL_CHECKS.map(name => ({ name, appId: GITHUB_ACTIONS_APP_ID, conclusion: 'SUCCESS', status: 'completed', id: 1 })) });

describe('mechanical clearance', () => {
  it('clears the refresh workflow identities and seconds', () => expect(validateMechanicalClearance(facts()).cleared).toBe(true));
  const fail = (name, rule, change) => it(name, () => {
    const f = facts(); change(f); expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule, head });
  });
  fail('another file', 'diff-scope', f => f.files.push({ filename: 'other' }));
  fail('human title and branch spoof', 'author', f => { f.author = { login: 'human', type: 'User' }; f.title = 'ci: refresh measured unit test timings'; f.branch = 'ci/refresh-test-timings'; });
  fail('bot login with User type', 'author', f => f.author.type = 'User');
  fail('human commit', 'commit-identity', f => f.commits[0].author.login = 'human');
  fail('null committer', 'commit-identity', f => f.commits[0].committer = null);
  fail('incomplete commits', 'read-error', f => f.commitCount++);
  for (const status of ['renamed', 'added', 'removed']) fail(status, 'diff-shape', f => f.files[0].status = status);
  fail('previous filename', 'diff-shape', f => f.files[0].previous_filename = path);
  for (const mode of ['100755', '120000', '160000']) fail(`mode ${mode}`, 'diff-shape', f => f.headEntry.mode = mode);
  fail('base mode', 'diff-shape', f => f.baseEntry.mode = '100755');
  fail('submodule type', 'diff-shape', f => f.headEntry.type = 'commit');
  fail('malformed JSON', 'schema', f => f.content = '{');
  fail('unknown top-level key', 'schema', f => f.content = '{"other":{}}');
  fail('doc must be text', 'schema', f => f.content = '{"_doc":1}');
  for (const value of ['-1', 'NaN', '"1"', '3601']) fail(`invalid seconds ${value}`, 'schema', f => f.content = `{"unit":{"${testPath}":${value}},"soak":{"${testPath}":1}}`);
  for (const key of ['README.md', '../a.test.ts', '/a.test.ts', 'a\\b.test.ts', 'missing.test.ts']) {
    fail(`invalid or missing test ${key}`, 'keys', f => f.content = JSON.stringify({ unit: { [key]: 1 }, soak: { [testPath]: 1 } }));
  }
  fail('empty document refuses', 'schema', f => f.content = '{}');
  for (const group of ['unit', 'soak']) {
    fail(`missing ${group} refuses`, 'schema', f => { const data = JSON.parse(f.content); delete data[group]; f.content = JSON.stringify(data); });
    for (const value of [{}, [], null, 1]) fail(`invalid or empty ${group} ${JSON.stringify(value)} refuses`, 'schema', f => {
      const data = JSON.parse(f.content); data[group] = value; f.content = JSON.stringify(data);
    });
    it.each([50, 89, 90, 110])(`${group} retains %i of 100 base keys`, count => {
      const f = facts();
      const entries = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${i}.test.ts`, 1]));
      f.baseContent = JSON.stringify({ ...JSON.parse(f.baseContent), [group]: entries(100) });
      f.content = JSON.stringify({ ...JSON.parse(f.content), [group]: entries(count) });
      f.existingFiles.push(...Object.keys(entries(count)));
      const result = validateMechanicalClearance(f);
      if (count >= 90) expect(result.cleared).toBe(true);
      else {
        expect(result).toMatchObject({ cleared: false, rule: 'schema' });
        expect(result.reasons[0]).toContain(`${group} retains ${count}/100`);
        expect(result.reasons[0]).toContain('normal review');
      }
    });
    it(`${group} rounds the 90% minimum up`, () => {
      const f = facts(); const data = JSON.parse(f.baseContent); data[group]['removed.test.ts'] = 1;
      f.baseContent = JSON.stringify(data);
      expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'schema' });
    });
    for (const base of [{}, { [group]: {} }]) it(`non-empty ${group} passes with base ${JSON.stringify(base)}`, () => {
      const f = facts(); f.baseContent = JSON.stringify(base);
      expect(validateMechanicalClearance(f).cleared).toBe(true);
    });
  }
  fail('missing base refuses', 'read-error', f => delete f.baseContent);
  fail('unparsable base refuses', 'read-error', f => f.baseContent = '{');
  fail('oversized base requires normal review', 'read-error', f => f.baseContent = ' '.repeat(4 * 1024 * 1024 + 1));
  for (const conclusion of ['FAILURE', 'PENDING', 'CANCELLED', 'NEUTRAL', 'SKIPPED', null]) fail(`required check ${conclusion}`, 'checks', f => f.checks[0].conclusion = conclusion);
  fail('missing required check', 'checks', f => f.checks.pop());
  fail('nonrequired failure', 'checks', f => f.checks.push({ name: 'other', conclusion: 'TIMED_OUT' }));
  it('uses latest required run', () => { const f = facts(); f.checks.push({ name: 'test', appId: GITHUB_ACTIONS_APP_ID, conclusion: 'PENDING', id: 2 }); expect(validateMechanicalClearance(f).rule).toBe('checks'); });
  it('successful rerun supersedes an old failed run', () => { const f = facts(); f.checks.unshift({ name: 'test', appId: GITHUB_ACTIONS_APP_ID, conclusion: 'FAILURE', id: 0 }); expect(validateMechanicalClearance(f).cleared).toBe(true); });
  it('higher-id queued rerun without timestamps supersedes an older success', () => {
    const f = facts(); f.checks[0].started_at = '2026-11-10T12:00:00Z';
    f.checks.push({ ...f.checks[0], id: 2, started_at: null, status: 'queued', conclusion: null });
    expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'checks' });
  });
  it.each([undefined, null, '', 'invalid'])('ambiguous rerun with id %s and no timestamps fails closed in either input order', id => {
    for (const reverse of [false, true]) {
      const f = facts(); f.checks[0].started_at = '2026-11-10T12:00:00Z';
      f.checks.push({ ...f.checks[0], id, started_at: null, status: 'queued', conclusion: null });
      if (reverse) f.checks.reverse();
      expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'checks' });
    }
  });
  it('higher-id success supersedes an older failure even with an earlier timestamp', () => {
    const f = facts(); f.checks[0].started_at = '2026-11-10T11:00:00Z';
    f.checks.push({ ...f.checks[0], id: 0, started_at: '2026-11-10T12:00:00Z', conclusion: 'FAILURE' });
    expect(validateMechanicalClearance(f).cleared).toBe(true);
  });
  it('unresolved ambiguous failure prevents clearance in all three-run permutations', () => {
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const f = facts();
      const runs = [
        { ...f.checks[0], id: undefined, started_at: '2026-11-10T13:00:00Z', conclusion: 'FAILURE' },
        { ...f.checks[0], id: 1, started_at: '2026-11-10T11:00:00Z', conclusion: 'FAILURE' },
        { ...f.checks[0], id: 2, started_at: '2026-11-10T12:00:00Z' },
      ];
      f.checks.splice(0, 1, ...order.map(index => runs[index]));
      expect(validateMechanicalClearance(f), `run order: ${order}`).toMatchObject({ cleared: false, rule: 'checks' });
    }
  });
  it('equal ids use timestamps to select the newer run', () => {
    const f = facts(); f.checks[0].started_at = '2026-11-10T12:00:00Z';
    f.checks.push({ ...f.checks[0], started_at: '2026-11-10T11:00:00Z', conclusion: 'FAILURE' });
    expect(validateMechanicalClearance(f).cleared).toBe(true);
  });
  it.each([undefined, 'invalid'])('equal ids with unknown timestamp %s prefer failure', started_at => {
    const f = facts(); f.checks[0].started_at = '2026-11-10T12:00:00Z';
    f.checks.push({ ...f.checks[0], started_at, conclusion: 'FAILURE' });
    expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'checks' });
  });
  fail('another app newer success cannot mask a failed Actions check', 'checks', f => {
    f.checks[0].conclusion = 'FAILURE';
    f.checks.push({ ...f.checks[0], appId: 42, id: 99, conclusion: 'SUCCESS' });
  });
  fail('same-name failure from another app cannot be masked by Actions success', 'checks', f => {
    f.checks.push({ ...f.checks[0], appId: 42, id: 0, conclusion: 'FAILURE' });
  });
  fail('required check only from another app', 'checks', f => f.checks[0].appId = 42);
  fail('required check missing app id', 'checks', f => delete f.checks[0].appId);
  fail('compare cap', 'read-error', f => f.files = Array(300).fill(f.files[0]));
  fail('oversized blob requires normal review', 'read-error', f => f.content = ' '.repeat(4 * 1024 * 1024 + 1));
  fail('too many timing keys requires normal review', 'schema', f => f.content = JSON.stringify({ unit: Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`${i}.test.ts`, 1])), soak: { [testPath]: 1 } }));
  fail('read error', 'read-error', f => f.readError = true);
});

const io = ({ moved = false, broken = null, truncated = false, mutate = (_url, value) => value } = {}) => {
  let pulls = 0;
  return (file, args) => {
    if (file === 'git') {
      if (args[0] === 'fetch') return '';
      return `100644 blob ${head}\t${testPath}\0`;
    }
    const url = args[1];
    if (url === broken) throw Error('unreadable');
    let value;
    if (url.endsWith('/pulls/1')) value = { user: facts().author, commits: 1, head: { sha: moved && pulls++ ? 'b'.repeat(40) : head }, base: { ref: 'main', sha: 'b'.repeat(40) } };
    else if (url.includes('/pulls/1/commits')) value = facts().commits;
    else if (url.includes('/compare/')) value = { files: truncated ? Array(300).fill(facts().files[0]) : facts().files };
    else if (url.includes('/git/trees/')) {
      const ref = url.split('/').at(-1);
      value = { truncated: false, tree: ['scripts-tree', 'base-scripts-tree'].includes(ref) ? [{ path: 'ci', type: 'tree', sha: ref.startsWith('base-') ? 'base-ci-tree' : 'ci-tree' }]
        : ['ci-tree', 'base-ci-tree'].includes(ref) ? [{ path: 'test-timings.json', type: 'blob', mode: '100644', sha: ref === 'base-ci-tree' ? 'base-blob' : 'blob' }]
          : [{ path: 'scripts', type: 'tree', sha: ref === 'b'.repeat(40) ? 'base-scripts-tree' : 'scripts-tree' }] };
    } else if (url.includes('/git/blobs/')) { const content = url.endsWith('/base-blob') ? facts().baseContent : facts().content; value = { encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) }; }
    else if (url.includes('/check-runs')) value = { total_count: 5, check_runs: REQUIRED_MECHANICAL_CHECKS.map((name, index) => ({
      name, app: { id: GITHUB_ACTIONS_APP_ID }, id: index + 1, head_sha: head, status: 'completed', conclusion: 'success', started_at: '2026-11-10T12:00:00Z',
    })) };
    else if (url.includes('/statuses')) value = [];
    else throw Error(`unexpected request ${url}`);
    return JSON.stringify(mutate(url, value));
  };
};
describe('IO closes on incomplete evidence', () => {
  const read = options => readMechanicalClearanceFacts({ repo: 'owner/repo', num: 1, exec: io(options) });
  it('clears a pinned snapshot with realistic lowercase REST check-run success conclusions', () => expect(validateMechanicalClearance(read()).cleared).toBe(true));
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    it(`refuses a required REST check-run with lowercase ${conclusion}`, () => {
      const mutate = (url, value) => url.includes('/check-runs') ? { ...value,
        check_runs: value.check_runs.map((check, index) => index === 0 ? { ...check, conclusion } : check) } : value;
      expect(validateMechanicalClearance(read({ mutate }))).toMatchObject({ cleared: false, rule: 'checks' });
    });
    it(`refuses a nonrequired REST check-run with lowercase ${conclusion}`, () => {
      const mutate = (url, value) => url.includes('/check-runs') ? { ...value, total_count: value.total_count + 1,
        check_runs: [...value.check_runs, { name: 'other', id: 6, status: 'completed', conclusion }] } : value;
      expect(validateMechanicalClearance(read({ mutate }))).toMatchObject({ cleared: false, rule: 'checks' });
    });
  }
  it('reads the pinned base blob into baseContent', () => expect(read().baseContent).toBe(facts().baseContent));
  for (const endpoint of ['base-blob', 'blob']) for (const [name, change] of [
    ['oversized', v => ({ ...v, size: 4 * 1024 * 1024 + 1 })],
    ['truncated', v => ({ ...v, content: '' })],
    ['wrong encoding', v => ({ ...v, encoding: 'utf8' })],
    ['invalid base64', v => ({ ...v, content: '!' })],
    ['invalid UTF-8', v => ({ ...v, size: 1, content: '/w==' })],
  ]) it(`${endpoint} ${name} fails closed`, () => {
    const f = read({ mutate: (url, v) => url.endsWith(`/blobs/${endpoint}`) ? change(v) : v });
    expect(f.readError).toBe(true);
    expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'read-error' });
  });
  it('unparsable base blob fails closed', () => {
    const f = read({ mutate: (url, v) => url.endsWith('/base-blob') ? { ...v, size: 1, content: 'ew==' } : v });
    expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'read-error' });
  });
  it('head moved', () => expect(validateMechanicalClearance(read({ moved: true })).rule).toBe('read-error'));
  it('compare truncated', () => expect(validateMechanicalClearance(read({ truncated: true })).rule).toBe('read-error'));
  it('any API failure', () => expect(validateMechanicalClearance(read({ broken: 'repos/owner/repo/pulls/1' })).rule).toBe('read-error'));
  for (const suffix of ['pulls/1/commits?per_page=100&page=1', `compare/${'b'.repeat(40)}...${head}?per_page=100&page=1`,
    `git/trees/${head}`, 'git/trees/scripts-tree', 'git/trees/ci-tree', 'git/blobs/blob', 'git/blobs/base-blob',
    `commits/${head}/check-runs?filter=all&per_page=100&page=1`, `commits/${head}/statuses?per_page=100&page=1`]) {
    it(`read failure at ${suffix}`, () => expect(validateMechanicalClearance(read({ broken: `repos/owner/repo/${suffix}` })).rule).toBe('read-error'));
  }
  for (const [name, mutate] of [
    ['truncated path tree', (url, v) => url.endsWith('/scripts-tree') ? { ...v, truncated: true } : v],
    ['incomplete commit count', (url, v) => url.endsWith('/pulls/1') ? { ...v, commits: 2 } : v],
    ['incomplete check count', (url, v) => url.includes('check-runs') ? { ...v, total_count: 6 } : v],
    ['oversized blob', (url, v) => url.includes('/blobs/') ? { ...v, size: 4 * 1024 * 1024 + 1 } : v],
    ['truncated blob', (url, v) => url.includes('/blobs/') ? { ...v, content: '' } : v],
    ['unreadable status list', (url, v) => url.includes('/statuses') ? {} : v],
    ['page ceiling retains normal review', (url, v) => url.includes('/statuses') ? Array(100).fill({ context: 'other', state: 'success' }) : v],
  ]) it(name, () => expect(validateMechanicalClearance(read({ mutate })).rule).toBe('read-error'));
  it('reads every commit page', () => {
    const mutate = (url, v) => url.endsWith('/pulls/1') ? { ...v, commits: 101 }
      : url.includes('/commits?') ? Array(url.endsWith('page=1') ? 100 : 1).fill(facts().commits[0]) : v;
    expect(validateMechanicalClearance(read({ mutate })).cleared).toBe(true);
  });
  it('injected head file reader failure closes', () => {
    const f = readMechanicalClearanceFacts({ repo: 'owner/repo', num: 1, exec: io(), listFiles: () => { throw Error('unreadable files'); } });
    expect(validateMechanicalClearance(f).rule).toBe('read-error');
  });
  for (const stage of ['fetch', 'ls-tree']) it(`git ${stage} failure closes`, () => {
    const exec = (file, args, opts) => { if (file === 'git' && args[0] === stage) throw Error('unreadable git'); return io()(file, args, opts); };
    expect(validateMechanicalClearance(readMechanicalClearanceFacts({ repo: 'owner/repo', num: 1, exec })).rule).toBe('read-error');
  });
  it('truncated git file listing closes', () => {
    const exec = (file, args, opts) => file === 'git' && args[0] === 'ls-tree' ? '100644 blob' : io()(file, args, opts);
    expect(validateMechanicalClearance(readMechanicalClearanceFacts({ repo: 'owner/repo', num: 1, exec })).rule).toBe('read-error');
  });
  it('a symlink test is not an existing regular file', () => {
    const exec = (file, args, opts) => file === 'git' && args[0] === 'ls-tree' ? `120000 blob ${head}\t${testPath}\0` : io()(file, args, opts);
    expect(validateMechanicalClearance(readMechanicalClearanceFacts({ repo: 'owner/repo', num: 1, exec })).rule).toBe('keys');
  });
});
describe('durable record', () => {
  it('posts verdict and all rule results once per head', () => {
    const comments = []; const result = validateMechanicalClearance(facts());
    const options = { repo: 'owner/repo', num: 1, result, readComments: () => comments,
      post: body => comments.push({ body, author: { login: 'web-everything[bot]' } }) };
    recordMechanicalClearance(options); recordMechanicalClearance(options);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(`<!-- mechanical-clearance: head=${head} -->`);
    for (const rule of ['author', 'commit-identity', 'diff-scope', 'diff-shape', 'schema', 'keys', 'checks']) expect(comments[0].body).toContain(`${rule}: PASS`);
    expect(comments[0].body).toContain('ET');
  });
  it('unreadable comments never posts', () => expect(() => recordMechanicalClearance({ repo: 'owner/repo', num: 1,
    result: validateMechanicalClearance(facts()), readComments: () => { throw Error('read'); }, post: () => { throw Error('must not post'); } })).toThrow('read'));
  it('untrusted marker cannot suppress the durable record', () => {
    let body;
    recordMechanicalClearance({ repo: 'owner/repo', num: 1, result: validateMechanicalClearance(facts()),
      readComments: () => [{ body: `<!-- mechanical-clearance: head=${head} -->`, author: { login: 'human' } }], post: text => { body = text; } });
    expect(body).toContain('cleared');
  });
  it('records the failing rule and leaves later rules unevaluated', () => {
    let body; const f = facts(); f.author.type = 'User';
    recordMechanicalClearance({ repo: 'owner/repo', num: 1, result: validateMechanicalClearance(f), readComments: () => [], post: text => { body = text; } });
    expect(body).toContain('author: FAIL'); expect(body).toContain('keys: NOT EVALUATED');
  });
});

describe('independent check kinds', () => {
  it('a newer success status cannot hide a failed required check-run', () => {
    const f = facts(); f.checks[0].conclusion = 'FAILURE';
    f.checks.push({ kind: 'status', name: 'test', conclusion: 'SUCCESS', id: 99 });
    expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'checks' });
  });
  it('required success without completion evidence fails closed', () => {
    const f = facts(); delete f.checks[0].status;
    expect(validateMechanicalClearance(f).rule).toBe('checks');
  });
  it('a status alone cannot satisfy a required check', () => {
    const f = facts(); f.checks[0].kind = 'status';
    expect(validateMechanicalClearance(f).rule).toBe('checks');
  });
  for (const kind of ['check-run', 'status']) for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'PENDING', 'UNKNOWN', 'action_required', 'startup_failure', 'STALE', 'future_conclusion', null]) {
    it(`refuses latest nonrequired ${kind} ${conclusion}`, () => {
      const f = facts(); f.checks.push({ kind, name: 'other', conclusion, status: 'completed' });
      expect(validateMechanicalClearance(f).rule).toBe('checks');
    });
  }
  it.each(['NEUTRAL', 'SKIPPED'])('allows nonrequired completed %s check-runs but refuses statuses', conclusion => {
    const f = facts(); const check = { kind: 'check-run', name: 'other', conclusion, status: 'completed' };
    f.checks.push(check);
    expect(validateMechanicalClearance(f).cleared).toBe(true);
    check.kind = 'status';
    expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'checks' });
  });
  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested', undefined])('refuses nonrequired success without completed status: %s', status => {
    const f = facts(); f.checks.push({ name: 'other', conclusion: 'SUCCESS', status });
    expect(validateMechanicalClearance(f)).toMatchObject({ cleared: false, rule: 'checks' });
  });
  it('allows a nonrequired successful commit status', () => {
    const f = facts(); f.checks.push({ kind: 'status', name: 'other', conclusion: 'SUCCESS' });
    expect(validateMechanicalClearance(f).cleared).toBe(true);
  });
  it('tags REST evidence so a newer status cannot hide a check failure', () => {
    const f = readMechanicalClearanceFacts({ repo: 'owner/repo', num: 1, exec: io({ mutate: (url, v) =>
      url.includes('/check-runs') ? { ...v, check_runs: v.check_runs.map(c => c.name === 'test' ? { ...c, conclusion: 'failure' } : c) }
        : url.includes('/statuses') ? [{ context: 'test', state: 'success', id: 99, created_at: '2026-11-11T12:00:00Z' }] : v }) });
    expect(f.checks[0]).toMatchObject({ kind: 'check-run', appId: GITHUB_ACTIONS_APP_ID });
    expect(f.checks.at(-1)).toMatchObject({ kind: 'status', appId: null });
    expect(validateMechanicalClearance(f).rule).toBe('checks');
  });
});

describe('mechanical label decision', () => {
  const pr = { state: 'OPEN', author: { login: 'web-everything[bot]' }, headRefOid: head,
    labels: [{ name: 'ready-to-merge' }], commits: [{ messageHeadline: 'refresh timings' }] };
  it('strips missing, refused or stale clearance; preserves current clearance', () => {
    for (const result of [null, { cleared: false, rule: 'diff-scope', head }, { cleared: true, head: 'b'.repeat(40) }]) {
      expect(decideMechanicalLabelStrip(pr, result).strip).toBe(true);
    }
    expect(decideMechanicalLabelStrip(pr, { cleared: true, head }).strip).toBe(false);
  });
  it.each(['web-everything[bot]', 'app/web-everything', undefined])('accepted bot/unknown author %s still needs current clearance', login => {
    const accepted = { ...pr, author: login ? { login } : undefined, labels: [...pr.labels, { name: 'review:accepted' }] };
    expect(decideMechanicalLabelStrip(accepted, null).strip).toBe(true);
    expect(decideMechanicalLabelStrip(accepted, { cleared: false, rule: 'checks', head }).strip).toBe(true);
    expect(decideMechanicalLabelStrip(accepted, { cleared: true, head }).strip).toBe(false);
  });
  it('never strips human, closed or unlabelled PRs', () => {
    for (const extra of [
      { author: { login: 'human' } },
      { state: 'CLOSED' }, { labels: [] }]) {
      expect(decideMechanicalLabelStrip({ ...pr, ...extra }, null).strip).toBe(false);
    }
  });
});


it('unknown commit evidence cannot exempt a bot ready label from stripping', () => {
  expect(decideMechanicalLabelStrip({ state: 'OPEN', author: { login: 'web-everything[bot]' },
    labels: ['ready-to-merge'], headRefOid: head }, { cleared: false, rule: 'read-error' }))
    .toEqual({ strip: true, rule: 'read-error' });
});
