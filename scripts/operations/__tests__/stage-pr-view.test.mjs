/**
 * @file stage-pr-view.test.mjs — refusing an incomplete PR view before it can be believed.
 *
 * THE DEFECT UNDER TEST is not a crash, it is a QUIET DEFAULT. `assembleReviewDetail` reads
 * `labelNames(v.labels)`, `Array.isArray(v.comments) ? … : []` and `Array.isArray(v.files) ? … : []`, so a
 * view assembled by hand with a field forgotten reviews the PR as if it genuinely had no labels, no comments
 * and no changed files. The most expensive of those is `labels`: a `review:human` PR whose view lost its
 * labels reads as an ordinary PR, and the whole human-only gate is invisible to the reviewer.
 *
 * So the assertions below are about the line this operation draws: ABSENT is refused, EMPTY is believed.
 * Several of them exist specifically to stop a later "simplification" from collapsing the two.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importGraph } from './import-graph.mjs';
import {
  stagePrViewOperation, checkStagedView, checkViewFreshness, checkViewProvenance, chooseViewSource,
  VIEW_FIELD_TYPES, VIEW_SOURCES, STAGE_PR_VIEW_OP, WRITE_VIEW_EFFECT,
} from '../stage-pr-view.mjs';
import {
  createFileReader, createPayloadReader, createStagePrViewSinks, createTransportReader, defaultViewDir,
  probeHeadOid, probeTransportBranch, transportWaitBudget,
  DEFAULT_TRANSPORT_INTERVAL_MS, DEFAULT_TRANSPORT_TIMEOUT_MS,
} from '../stage-pr-view-io.mjs';
import { PR_VIEW_FIELDS, prViewFileName } from '../review-pr-io.mjs';
import { TRANSPORT_BRANCH, TRANSPORT_REF, viewPath } from '../../lib/pr-view-transport.mjs';

const HEAD_OID = 'f'.repeat(40);
const view = (over = {}) => ({
  number: 1496,
  title: 'verify: declare over verify-lane',
  url: 'https://github.com/web-everything/web-everything/pull/1496',
  body: 'the PR body',
  labels: [{ name: 'review:human' }],
  comments: [],
  files: [{ path: 'scripts/operations/verify.mjs', additions: 10, deletions: 0 }],
  headRefName: 'lane/verify-operation',
  state: 'OPEN', // #xwp8ioh — a staged view without it cannot be reviewed at all (see VIEW_FIELD_TYPES)
  // #xwk0tzu (#3322) — without it, a stripped `authored-by-actor` stamp reads as one that never existed, so
  // a review through a staged view is quietly weaker than the same review through `gh` (see VIEW_FIELD_TYPES).
  createdAt: '2026-08-14T12:00:00Z',
  headRefOid: HEAD_OID, // #xaoja7a — what makes a staged view falsifiable against the tree that will be judged
  ...over,
});
const check = (v, over = {}) => checkStagedView({ view: v, pr: 1496, repo: 'web-everything/web-everything', fields: PR_VIEW_FIELDS, ...over });
/** The provenance a healthy CI-produced read reports. */
const fromTransport = (over = {}) => ({
  source: 'transport',
  ref: TRANSPORT_REF,
  path: viewPath(prViewFileName('web-everything/web-everything', 1496)),
  commit: 'c'.repeat(40),
  transportAvailable: true,
  probed: true,
  headOid: HEAD_OID,
  ...over,
});
const ops = (readPayload = () => ({ view: view(), provenance: fromTransport() })) => stagePrViewOperation(
  { readPayload },
  { fields: PR_VIEW_FIELDS, viewFileName: prViewFileName, defaultDir: '/views' },
);
const step = (decl, name) => decl.steps.find((s) => s.name === name).step;
/** Drive the `check` step the way the engine does, with the `read` finding already in place. */
const runCheck = (readFinding, input = {}) => step(ops(), 'check').fn({
  input: { pr: 1496, repo: 'web-everything/web-everything', dir: '/views', ...input },
  findings: { read: readFinding },
});

describe('the declared shape stays tied to the reader\'s', () => {
  /**
   * NOT DERIVED FROM `PR_VIEW_FIELDS` ON PURPOSE. If the type table were built from the reader's list, a new
   * field would arrive with no declared type and be waved through — a completeness check that silently stops
   * being complete. Asserting equality instead makes adding a field to the reader a failure HERE until
   * somebody decides what it must be.
   */
  it('covers exactly the fields the reader asks for — no more, no fewer', () => {
    expect(Object.keys(VIEW_FIELD_TYPES).sort()).toEqual([...PR_VIEW_FIELDS].sort());
  });

  it('refuses a field the reader wants that has no declared type, rather than skipping it', () => {
    expect(() => check(view(), { fields: [...PR_VIEW_FIELDS, 'reviewDecision'] }))
      .toThrow(/no declared type here/);
  });

  it('restates neither the field list nor the filename — both must be injected', () => {
    expect(() => stagePrViewOperation({ readPayload: () => ({}) }, { fields: PR_VIEW_FIELDS })).toThrow(/prViewFileName/);
    expect(() => stagePrViewOperation({ readPayload: () => ({}) }, { viewFileName: prViewFileName })).toThrow(/PR_VIEW_FIELDS/);
    expect(() => stagePrViewOperation({}, { fields: PR_VIEW_FIELDS, viewFileName: prViewFileName })).toThrow(/readPayload/);
  });
});

describe('absent is refused', () => {
  it('accepts a complete view', () => {
    expect(check(view()).view.number).toBe(1496);
  });

  // Each field named individually rather than looped, because the CONSEQUENCE differs per field and the
  // refusal message is supposed to say which one the operator is about to lose.
  it('refuses a view with no `labels` — the field that hides a human-only gate', () => {
    const { labels, ...rest } = view();
    expect(() => check(rest)).toThrow(/missing labels/);
    expect(() => check(rest)).toThrow(/review:human/);
  });

  it('refuses a view with no `comments` — the field that hides the escalation and the last verdict', () => {
    const { comments, ...rest } = view();
    expect(() => check(rest)).toThrow(/missing comments/);
  });

  it('refuses a view with no `files`, no `body`, no `headRefName`', () => {
    for (const field of ['files', 'body', 'headRefName']) {
      const v = view();
      delete v[field];
      expect(() => check(v)).toThrow(new RegExp(`missing ${field}`));
    }
  });

  // `null` is what a mapping from another API produces for a field it looked up and did not find — which is
  // exactly the case that must not read as "none".
  it('treats an explicit null the same as an omission', () => {
    expect(() => check(view({ labels: null }))).toThrow(/missing labels/);
  });

  it('names every missing field at once, not just the first', () => {
    const v = view();
    delete v.labels; delete v.comments;
    expect(() => check(v)).toThrow(/missing labels, comments/);
  });
});

describe('empty is believed', () => {
  /**
   * THE OTHER HALF OF THE DECISION, and the one a later refactor is most likely to break by "tightening" the
   * check into a truthiness test. A PR really can have no labels and no comments; refusing that would make
   * the operation unusable on exactly the ordinary PRs it is meant to serve.
   */
  it('accepts explicitly-empty arrays — an empty array is a claim, and claims are believed', () => {
    const out = check(view({ labels: [], comments: [], files: [] }));
    expect(out.view.labels).toEqual([]);
    expect(out.empty.sort()).toEqual(['comments', 'files', 'labels']);
  });

  it('accepts an empty body — a PR with no description is ordinary', () => {
    expect(check(view({ body: '' })).view.body).toBe('');
  });
});

describe('wrong types are refused', () => {
  // `typeof [] === 'object'`, so a presence-plus-typeof check would wave a bare object through as `labels`.
  it('refuses an object where an array is declared', () => {
    expect(() => check(view({ labels: { nodes: [] } }))).toThrow(/want array, got object/);
  });

  it('refuses a number where a string is declared, and a string where a number is', () => {
    expect(() => check(view({ headRefName: 42 }))).toThrow(/want string, got number/);
    expect(() => check(view({ number: '1496' }))).toThrow(/want number, got string/);
  });

  it('refuses a payload that is not an object at all', () => {
    for (const bad of [null, [], 'text', 7]) expect(() => check(bad)).toThrow(/not a JSON object/);
  });
});

describe('the subject is checked at STAGING, not only at reading (#1466)', () => {
  it('refuses a view whose number is not the PR being staged', () => {
    expect(() => check(view({ number: 1495 }))).toThrow(/says it is #1495/);
  });
});

describe('the path is the reader\'s own name', () => {
  it('stages under `prViewFileName`, so the reader finds it', () => {
    const out = runCheck({ view: view(), provenance: fromTransport() });
    expect(out.path).toBe(`/views/${prViewFileName('web-everything/web-everything', 1496)}`);
    // The slash is percent-encoded, NOT flattened to `-`: `foo-bar/baz` and `foo/bar-baz` collided under the
    // old scheme and one repo's view silently answered for the other's.
    expect(out.path).toContain('%2F');
  });

  it('refuses to stage with no directory rather than guessing one', () => {
    const decl = stagePrViewOperation({ readPayload: () => ({ view: view(), provenance: fromTransport() }) }, { fields: PR_VIEW_FIELDS, viewFileName: prViewFileName });
    expect(() => step(decl, 'check').fn({ input: { pr: 1496, repo: 'web-everything/web-everything', dir: '' }, findings: { read: { view: view(), provenance: fromTransport() } } }))
      .toThrow(/no directory to stage into/);
  });
});

describe('the write effect', () => {
  it('declares one idempotent write carrying bytes the check already produced', () => {
    const effects = step(ops(), 'write').effects({ verdict: { path: '/views/x.json', view: view(), provenance: fromTransport() } });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: WRITE_VIEW_EFFECT, idempotent: true });
    expect(JSON.parse(effects[0].payload.content).number).toBe(1496);
  });

  it('writes exactly where the check said, creating the directory', () => {
    const wrote = [];
    const made = [];
    const sinks = createStagePrViewSinks({ write: (p, c) => wrote.push([p, c]), mkdir: (d) => made.push(d) });
    return sinks[WRITE_VIEW_EFFECT]({ path: '/views/a.json', content: '{}\n' }).then((out) => {
      expect(wrote).toEqual([['/views/a.json', '{}\n']]);
      expect(made).toEqual(['/views']);
      expect(out).toMatchObject({ path: '/views/a.json' });
    });
  });
});

describe('the io shell fails closed on each half separately', () => {
  // `run` is stubbed on every one of these so the file reader's transport probe never shells git.
  const noGit = () => { throw new Error('no git in this test'); };

  it('names an unreadable path', () => {
    const read = createFileReader({ read: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }, run: noGit });
    expect(() => read({ from: '/nope.json' })).toThrow(/could not read the payload at \/nope.json — ENOENT/);
  });

  it('names unparseable bytes separately — the operator has to know which to fix', () => {
    const read = createFileReader({ read: () => 'not json', run: noGit });
    expect(() => read({ from: '/x.json' })).toThrow(/\/x.json is not valid JSON/);
  });

  /**
   * `null` rather than a guessed default: a fabricated directory writes the view where the reader does not
   * look, and the review then fails with "no pre-fetched view" naming a path that was never the one staged —
   * an error message pointing away from the mistake.
   */
  it('reports no default directory rather than inventing one', () => {
    expect(defaultViewDir({})).toBeNull();
    expect(defaultViewDir({ WE_PR_VIEW_DIR: '/tmp/views' })).toBe('/tmp/views');
  });
});

describe('the declaration reaches nothing that can act', () => {
  // #3036's property. This operation WRITES, so `http-adapter.test.mjs`'s pinned read-only list cannot make
  // the claim on its behalf; without this, the module could grow an `fs` import and write straight out of a
  // `compute` step, where no effect ledger would record that it happened.
  it('keeps every write in the io shell', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(importGraph(resolve(here, '..', 'stage-pr-view.mjs')).external).toEqual([]);
    expect(importGraph(resolve(here, '..', 'stage-pr-view-io.mjs')).external).toContain('node:fs');
  });
});

// ══ #xaoja7a — THE CI-STAGED TRANSPORT ═══════════════════════════════════════════════════════════════════════
//
// THE DEFECT, restated because every assertion below is about it: on PR #1542 the REVIEWING SESSION supplied
// the view its own juror read. It carried a paraphrase of the body in the session's voice and a comment the
// session had authored, stamped `authorAssociation: OWNER`, that is not on the PR at all. Every check in the
// file above passed — the view was complete, correctly typed and about the right PR. Completeness was never
// the property in question.

describe('exactly one view source, chosen in writing', () => {
  it('reads the CI transport when asked', () => {
    expect(chooseViewSource({ fromTransport: true })).toEqual({ source: 'transport' });
  });

  it('reads a local file when asked', () => {
    expect(chooseViewSource({ from: '/tmp/v.json' })).toEqual({ source: 'file', from: '/tmp/v.json' });
  });

  /**
   * NEITHER IS THE DEFAULT. A `file` default keeps the #1542 hole reachable by omitting a flag; a `transport`
   * default would start a CI round trip for an operator who meant to hand over bytes. Both refusals name the
   * other option, so the choice is always made rather than inherited.
   */
  it('refuses when neither is given, naming both', () => {
    expect(() => chooseViewSource({})).toThrow(/no view source/);
    expect(() => chooseViewSource({})).toThrow(/--fromTransport/);
    expect(() => chooseViewSource({})).toThrow(/--from=/);
  });

  // A precedence rule would be a thing to remember, and "the local file quietly won" is the failure being closed.
  it('refuses BOTH rather than picking one', () => {
    expect(() => chooseViewSource({ from: '/tmp/v.json', fromTransport: true })).toThrow(/two different views/);
  });

  it('treats a blank `--from=` as absent, not as a path', () => {
    expect(() => chooseViewSource({ from: '   ' })).toThrow(/no view source/);
  });
});

describe('a hand-supplied view is REFUSED wherever CI can serve — the structural half', () => {
  /**
   * THE ONE THAT MAKES OR BREAKS IT. CI producing the view is not sufficient on its own: if `--from=` stays
   * reachable where the transport exists, a session fetches the CI-produced view, edits it, and stages the
   * edit. Same fabrication, one step back, every other check still green.
   */
  it('refuses `--from=` on a repo whose transport branch exists', () => {
    const provenance = { source: 'file', from: '/tmp/v.json', transportAvailable: true, probed: true };
    expect(() => checkViewProvenance({ provenance, repo: 'web-everything/web-everything', pr: 1496, view: view() }))
      .toThrow(/refusing a hand-supplied view/);
    expect(() => checkViewProvenance({ provenance, repo: 'web-everything/web-everything', pr: 1496, view: view() }))
      .toThrow(new RegExp(TRANSPORT_BRANCH));
  });

  // The escape hatch is a repo that genuinely cannot be served, and only that.
  it('allows `--from=` on a repo that has NOT onboarded the workflow', () => {
    const provenance = { source: 'file', from: '/tmp/v.json', transportAvailable: false, probed: true };
    expect(checkViewProvenance({ provenance, repo: 'o/x', pr: 1, view: view() })).toBe(provenance);
  });

  /**
   * THE REF IS PINNED. `git show ops/pr-views:…` reads a LOCAL branch this session can commit to with no
   * credential and no network, which would be exactly the trust of reading a local file. No input reaches this
   * value; this assertion is what makes that a checked property instead of a comment.
   */
  it('refuses a transport view that claims any ref but the remote-tracking one', () => {
    for (const ref of [TRANSPORT_BRANCH, 'refs/heads/ops/pr-views', 'upstream/ops/pr-views', undefined]) {
      expect(() => checkViewProvenance({ provenance: fromTransport({ ref }), repo: 'o/x', pr: 1, view: view() }))
        .toThrow(new RegExp(`must be read from \`${TRANSPORT_REF}\``));
    }
  });

  it('refuses a transport view with no headRefOid — the staleness check would pass vacuously', () => {
    const { headRefOid, ...noOid } = view();
    expect(() => checkViewProvenance({ provenance: fromTransport(), repo: 'o/x', pr: 1, view: noOid }))
      .toThrow(/carries no `headRefOid`/);
  });

  it('refuses bytes whose source is not one of the declared two', () => {
    expect(VIEW_SOURCES).toEqual(['transport', 'file']);
    for (const source of [undefined, '', 'stdin', 'gh']) {
      expect(() => checkViewProvenance({ provenance: { source }, repo: 'o/x', pr: 1, view: view() }))
        .toThrow(/no source for these bytes/);
    }
  });
});

describe('a STALE view is refused — the body and the diff are two reads of two moments', () => {
  const stale = (over) => checkViewFreshness({ view: view(over?.view), headOid: over?.headOid ?? HEAD_OID, repo: 'o/x', pr: 1 });

  it('accepts a view whose headRefOid IS the head the diff will come from', () => {
    expect(stale()).toEqual({ checked: true, head: HEAD_OID });
  });

  /**
   * `review-pr` takes the DIFF from local git and the body, labels and comments from the staged view. Push a
   * commit between those two reads and the juror judges today's diff against yesterday's description — each
   * half internally consistent, so nothing downstream can notice. Same silent shape as #1466.
   */
  it('refuses when the PR head has moved past what the view records', () => {
    expect(() => stale({ headOid: 'a'.repeat(40) })).toThrow(/refusing to stage a STALE view/);
    expect(() => stale({ headOid: 'a'.repeat(40) })).toThrow(/--refresh/);
  });

  // "Could not check" must not read as "checked and fine" — the absent-versus-empty line, one field over.
  it('refuses rather than skipping when the head ref cannot be resolved at all', () => {
    expect(() => stale({ headOid: '' })).toThrow(/could not resolve `origin\/lane\/verify-operation`/);
  });

  /**
   * NOT A LOOPHOLE. A merged or closed PR has no live head to move and its branch is routinely deleted, so the
   * probe fails for every one of them; `review-pr`'s own liveness refusal (#xwp8ioh) handles that case with a
   * message about the PR rather than about a ref.
   */
  it('exempts a PR that is not OPEN, where there is no head to move', () => {
    expect(stale({ view: { state: 'MERGED' }, headOid: '' }).checked).toBe(false);
  });
});

describe('the check step runs all three refusals, in order', () => {
  it('accepts a complete, CI-produced, fresh view', () => {
    const out = runCheck({ view: view(), provenance: fromTransport() });
    expect(out.freshness).toEqual({ checked: true, head: HEAD_OID });
    expect(out.provenance.source).toBe('transport');
  });

  /**
   * ORDER IS ASSERTED, not assumed. Completeness first: every later refusal reads fields off the view, so a
   * missing one would otherwise surface as a confusing message about staleness or provenance.
   */
  it('reports the missing field, not the provenance, when both are wrong', () => {
    const { labels, ...rest } = view();
    expect(() => runCheck({ view: rest, provenance: { source: 'file', transportAvailable: true } }))
      .toThrow(/missing labels/);
  });

  it('refuses the #1542 shape end to end — a hand-supplied view on an onboarded repo', () => {
    expect(() => runCheck({ view: view(), provenance: { source: 'file', from: '/tmp/v.json', transportAvailable: true, probed: true, headOid: HEAD_OID } }))
      .toThrow(/refusing a hand-supplied view/);
  });

  it('refuses a stale transport view end to end', () => {
    expect(() => runCheck({ view: view(), provenance: fromTransport({ headOid: 'b'.repeat(40) }) }))
      .toThrow(/STALE view/);
  });

  /**
   * THE PROVENANCE IS STAMPED INTO THE BYTES. It is the only record, in the artefact itself, of whether a
   * juror's evidence came off this session's disk or out of CI — and the thing the item's option (a) would
   * check against if a local path is ever re-introduced.
   */
  it('stamps where the bytes came from into the staged view', () => {
    const verdict = runCheck({ view: view(), provenance: fromTransport() });
    const effects = step(ops(), 'write').effects({ verdict });
    const written = JSON.parse(effects[0].payload.content);
    expect(written._stagedFrom).toMatchObject({ source: 'transport', ref: TRANSPORT_REF });
    expect(written.number).toBe(1496); // and it does not disturb what the reader consumes
  });
});

describe('the transport reader — bytes out of the fetched ref, never off a path', () => {
  const NAME = prViewFileName('web-everything/web-everything', 1496);
  const PATH = viewPath(NAME);
  const BLOB = 'b'.repeat(40);

  /**
   * A git stub that answers by argv shape. `present` decides whether the view is on the branch yet, so the
   * "not there yet" path is exercised without a network, a clock or a real wait.
   */
  const gitStub = ({ blobs = [BLOB], branch = 'sha\trefs/heads/ops/pr-views', body = JSON.stringify(view()) } = {}) => {
    const calls = [];
    const queue = [...blobs];
    const run = (argv) => {
      calls.push(argv);
      if (argv[0] === 'ls-remote') return branch;
      if (argv[0] === 'fetch') return '';
      if (argv[0] === 'rev-parse' && String(argv[1]).includes(`:${PATH}`)) {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw new Error('fatal: path does not exist');
        return `${next}\n`;
      }
      if (argv[0] === 'rev-parse') return `${'c'.repeat(40)}\n`;
      if (argv[0] === 'show') return body;
      // The request push stages a file, so `diff --cached` must report one or `stageOnTransportBranch`
      // correctly concludes there is nothing to commit and never pushes.
      if (argv[0] === 'diff') return 'ops/pr-views/requests/x.json\n';
      return '';
    };
    return { run, calls };
  };
  /**
   * EVERY side effect is stubbed, filesystem included — `run` alone is not enough. `record-verdict-io.mjs`
   * records what happened the last time it was: the suite's own `mkdirSync` ran for real against a fixture root
   * of `/repo` and, as root, SUCCEEDED, leaving the tests green over a sink that had written outside its
   * checkout.
   */
  const reader = (stub, over = {}) => createTransportReader({
    run: stub.run, sleep: () => {}, now: () => 0, env: {}, cwd: '/repo',
    viewFileName: prViewFileName, originRepo: () => 'web-everything/web-everything',
    mkdir: (p) => stub.calls.push(['fs:mkdir', p]),
    write: (p) => stub.calls.push(['fs:write', p]),
    rm: (p) => stub.calls.push(['fs:rm', p]),
    ...over,
  });

  it('reads the view with ONE `git show` against the remote-tracking ref', () => {
    const stub = gitStub();
    const out = reader(stub)({ repo: 'web-everything/web-everything', pr: 1496 });
    expect(out.view.number).toBe(1496);
    const show = stub.calls.find((c) => c[0] === 'show');
    expect(show).toEqual(['show', `${TRANSPORT_REF}:${PATH}`]);
    expect(out.provenance).toMatchObject({ source: 'transport', ref: TRANSPORT_REF, path: PATH });
  });

  /**
   * THE STRUCTURAL PROPERTY, asserted directly: the reader is built with NO filesystem seam at all, so there is
   * no path in between the fetch and the parse for a session to edit. A future "fetch it into /tmp and read it
   * back" would have to add one, and this test is what it would break.
   */
  it('never reads a file — the bytes come from the subprocess, not from disk', () => {
    const stub = gitStub();
    let reads = 0;
    // The FILE reader is a different function with its own `read` seam; the transport one accepts none. Passing
    // a booby-trapped `read` through the shared factory proves the transport branch never reaches it.
    const dispatch = createPayloadReader({
      read: () => { reads += 1; return '{}'; },
      run: stub.run, sleep: () => {}, now: () => 0, env: {}, cwd: '/repo',
      viewFileName: prViewFileName, originRepo: () => 'web-everything/web-everything',
    });
    dispatch({ source: 'transport', repo: 'web-everything/web-everything', pr: 1496 });
    expect(reads).toBe(0);
  });

  // The fetch is what overwrites a remote-tracking ref a session may have pointed elsewhere with `update-ref`.
  it('always fetches the ref before reading it', () => {
    const stub = gitStub();
    reader(stub)({ repo: 'web-everything/web-everything', pr: 1496 });
    const fetchIdx = stub.calls.findIndex((c) => c[0] === 'fetch' && String(c[3]).includes(TRANSPORT_BRANCH));
    const showIdx = stub.calls.findIndex((c) => c[0] === 'show');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeLessThan(showIdx);
  });

  it('pushes no request when the view is already on the branch', () => {
    const stub = gitStub();
    reader(stub)({ repo: 'web-everything/web-everything', pr: 1496 });
    expect(stub.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('asks CI — and waits — when the view is not there yet', () => {
    // The baseline probe consumes the first answer; then absent, absent, published — so it really loops.
    const stub = gitStub({ blobs: ['', '', '', BLOB] });
    const slept = [];
    const out = reader(stub, { sleep: (ms) => slept.push(ms) })({ repo: 'web-everything/web-everything', pr: 1496 });
    expect(out.view.number).toBe(1496);
    expect(stub.calls.some((c) => c[0] === 'push')).toBe(true);
    expect(slept).toEqual([DEFAULT_TRANSPORT_INTERVAL_MS, DEFAULT_TRANSPORT_INTERVAL_MS]);
  });

  /**
   * THE LATENCY DECISION, pinned. A bounded poll was chosen over an immediate refusal because an immediate
   * refusal makes a double invocation the guaranteed shape of the primary path — and the route around that
   * friction is `--from=<a file I wrote>`, the hole this transport replaces.
   */
  it('gives up with a refusal that names the workflow, and never falls back to a local file', () => {
    const stub = gitStub({ blobs: [''] });
    expect(() => reader(stub, { env: { WE_PR_VIEW_TRANSPORT_TIMEOUT_MS: '30000', WE_PR_VIEW_TRANSPORT_INTERVAL_MS: '10000' } })({ repo: 'web-everything/web-everything', pr: 1496 }))
      .toThrow(/gave up waiting for CI/);
    expect(() => reader(stub, { env: { WE_PR_VIEW_TRANSPORT_TIMEOUT_MS: '30000', WE_PR_VIEW_TRANSPORT_INTERVAL_MS: '10000' } })({ repo: 'web-everything/web-everything', pr: 1496 }))
      .toThrow(/Do NOT fall back to `--from=`/);
  });

  /**
   * A CLOCK IS NOT A BOUND. `now()` frozen at 0 defeats the deadline entirely; the attempt cap does not consult
   * the clock, so the loop still terminates. Without it this test hangs — which is the whole reason it exists.
   */
  it('terminates on the attempt cap even when the clock never advances', () => {
    const stub = gitStub({ blobs: [''] });
    expect(() => reader(stub, { now: () => 0 })({ repo: 'web-everything/web-everything', pr: 1496 }))
      .toThrow(/gave up waiting for CI/);
  });

  it('re-asks and waits for DIFFERENT bytes under `--refresh`', () => {
    const stub = gitStub({ blobs: [BLOB, BLOB, 'd'.repeat(40)] });
    const out = reader(stub)({ repo: 'web-everything/web-everything', pr: 1496, refresh: true });
    expect(stub.calls.some((c) => c[0] === 'push')).toBe(true);
    expect(out.provenance.blob).toBe('d'.repeat(40));
  });

  it('refuses a repo that has not onboarded, rather than waiting three minutes for nothing', () => {
    const stub = gitStub({ branch: '' });
    expect(() => reader(stub)({ repo: 'web-everything/web-everything', pr: 1496 })).toThrow(/no `ops\/pr-views` branch on origin/);
    expect(stub.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('names the branch when the bytes on it are not JSON', () => {
    const stub = gitStub({ body: 'not json' });
    expect(() => reader(stub)({ repo: 'web-everything/web-everything', pr: 1496 })).toThrow(/is not valid JSON/);
  });

  it('refuses a view request for a repo this checkout does not own (#3261, #1548 r3)', () => {
    // The refusal MOVED EARLIER in r3 and the message changed with it. It used to come from
    // `resolveTransportRoot` at push time — correct, but only after this path had already fetched and was
    // about to push, and phrased as a complaint about staging rather than about the flag that was wrong.
    // The same ownership check the file reader makes now runs first, so nothing touches the branch at all.
    const stub = gitStub({ blobs: [''] });
    expect(() => reader(stub, { originRepo: () => 'plateauapp/plateau-app' })({ repo: 'web-everything/web-everything', pr: 1496 }))
      .toThrow(/refusing to use .* as web-everything\/web-everything's checkout/);
  });

  it('…and refuses BEFORE fetching, so a wrong `--repoRoot` costs nothing', () => {
    // What moving it earlier actually buys, asserted rather than assumed.
    const calls = [];
    const stub = (args, opts) => { calls.push(args[0]); return ''; };
    expect(() => reader(stub, { originRepo: () => 'plateauapp/plateau-app' })({ repo: 'web-everything/web-everything', pr: 1496 }))
      .toThrow(/refusing to use/);
    expect(calls).toEqual([]);
  });

  it('requires the reader\'s own namer rather than inventing one', () => {
    expect(() => createTransportReader({ run: () => '' })).toThrow(/prViewFileName/);
  });
});

describe('the probes the guards stand on', () => {
  it('reports the transport as present when origin lists the branch', () => {
    expect(probeTransportBranch({ run: () => 'sha\trefs/heads/ops/pr-views', cwd: '/r' })).toEqual({ available: true, probed: true });
  });

  it('reports it absent when origin lists nothing', () => {
    expect(probeTransportBranch({ run: () => '', cwd: '/r' })).toEqual({ available: false, probed: true });
  });

  /**
   * FAILS CLOSED. "I could not ask" must not read as "there is no transport": that would re-open the
   * hand-supplied path for exactly as long as a network blip lasted, silently, and the operator would see a
   * successful stage.
   */
  it('treats an unanswerable probe as PRESENT, and says it could not ask', () => {
    const out = probeTransportBranch({ run: () => { throw new Error('could not resolve host'); }, cwd: '/r' });
    expect(out).toMatchObject({ available: true, probed: false });
  });

  it('fetches the head ref before resolving it, so an unseen lane branch is not "unresolvable"', () => {
    const calls = [];
    const oid = probeHeadOid({
      headRefName: 'lane/x',
      run: (argv) => { calls.push(argv); return argv[0] === 'rev-parse' ? `${HEAD_OID}\n` : ''; },
      cwd: '/r',
    });
    expect(oid).toBe(HEAD_OID);
    expect(calls[0]).toEqual(['fetch', '--quiet', 'origin', '+refs/heads/lane/x:refs/remotes/origin/lane/x']);
  });

  // The name arrives in a JSON file on a branch anyone who can push can write. It must not reach a refspec raw.
  it('refuses to splice a hostile ref name into a git argument', () => {
    const calls = [];
    for (const bad of ['--upload-pack=touch /tmp/x', '../../etc', '', 'a b']) {
      expect(probeHeadOid({ headRefName: bad, run: (argv) => { calls.push(argv); return ''; }, cwd: '/r' })).toBe('');
    }
    expect(calls).toEqual([]);
  });

  it('returns nothing — never throws — when the ref genuinely cannot be resolved', () => {
    expect(probeHeadOid({ headRefName: 'lane/gone', run: () => { throw new Error('unknown revision'); }, cwd: '/r' })).toBe('');
  });
});

describe('the wait budget', () => {
  it('defaults to one comfortable CI margin, polled cheaply', () => {
    const b = transportWaitBudget({});
    expect(b.timeoutMs).toBe(DEFAULT_TRANSPORT_TIMEOUT_MS);
    expect(b.intervalMs).toBe(DEFAULT_TRANSPORT_INTERVAL_MS);
  });

  it('derives an attempt cap that does not consult the clock', () => {
    expect(transportWaitBudget({ WE_PR_VIEW_TRANSPORT_TIMEOUT_MS: '30000', WE_PR_VIEW_TRANSPORT_INTERVAL_MS: '10000' }).maxAttempts).toBe(4);
  });

  // A typo must not turn the loop into a spin, and an interval above the budget must not nap past the cap.
  it('floors both at something positive and never sleeps longer than the whole budget', () => {
    expect(transportWaitBudget({ WE_PR_VIEW_TRANSPORT_INTERVAL_MS: '0' }).intervalMs).toBe(DEFAULT_TRANSPORT_INTERVAL_MS);
    expect(transportWaitBudget({ WE_PR_VIEW_TRANSPORT_TIMEOUT_MS: 'nonsense' }).timeoutMs).toBe(DEFAULT_TRANSPORT_TIMEOUT_MS);
    expect(transportWaitBudget({ WE_PR_VIEW_TRANSPORT_TIMEOUT_MS: '5000', WE_PR_VIEW_TRANSPORT_INTERVAL_MS: '90000' }).intervalMs).toBe(5000);
  });
});

/**
 * AGAINST REAL GIT, because the property under test is git's own ref resolution and a stub cannot reproduce it.
 * `collect-review-requests.test.mjs` makes the same argument for the rename heuristic: when the thing that could
 * silently do the wrong thing IS git, asserting an argv is asserting our intent, not the outcome.
 *
 * THE SHARP ONE is the second test. A session with no credential and no network can point a LOCAL branch — or a
 * remote-tracking ref — anywhere it likes: `git commit`, `git update-ref`, both offline. If the read resolved
 * `ops/pr-views` rather than `origin/ops/pr-views`, or trusted a tracking ref it had not just fetched, the whole
 * transport would be theatre. This builds exactly that attack and shows the reader returns CI's bytes.
 */
describe('the transport read against real git', () => {
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const REPO = 'web-everything/web-everything';
  let origin;
  let clone;
  let headOid;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'pr-view-transport-'));
    origin = join(tmp, 'origin');
    clone = join(tmp, 'clone');
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '-q', '-b', 'main', '.');
    git(origin, 'config', 'user.email', 't@t');
    git(origin, 'config', 'user.name', 't');
    writeFileSync(join(origin, 'README.md'), 'x\n');
    git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'main');

    // The PR's head branch — what `probeHeadOid` resolves and what the judged diff would come from.
    git(origin, 'checkout', '-q', '-b', 'lane/verify-operation');
    writeFileSync(join(origin, 'README.md'), 'y\n');
    git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'lane work');
    headOid = git(origin, 'rev-parse', 'HEAD');

    // The transport branch, carrying the view CI produced.
    git(origin, 'checkout', '-q', '--orphan', 'ops/pr-views');
    git(origin, 'rm', '-rqf', '.');
    mkdirSync(join(origin, viewPath(prViewFileName(REPO, 1496)).split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(origin, viewPath(prViewFileName(REPO, 1496))), `${JSON.stringify(view({ headRefOid: headOid }), null, 2)}\n`);
    git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'pr-view: publish');
    git(origin, 'checkout', '-q', 'main');

    execFileSync('git', ['clone', '-q', origin, clone], { encoding: 'utf8' });
    git(clone, 'config', 'user.email', 't@t');
    git(clone, 'config', 'user.name', 't');
  });

  const realReader = () => createTransportReader({
    run: (argv, opts) => execFileSync('git', argv, { encoding: 'utf8', cwd: opts?.cwd ?? clone }),
    sleep: () => {}, now: () => 0, env: {}, cwd: clone,
    viewFileName: prViewFileName, originRepo: () => REPO,
  });

  it('reads CI\'s view and resolves the head the diff will come from', () => {
    const out = realReader()({ repo: REPO, pr: 1496 });
    expect(out.view.number).toBe(1496);
    expect(out.provenance.headOid).toBe(headOid);
    // …and the whole check passes end to end, which is what a staged review actually needs.
    expect(runCheck(out).freshness).toEqual({ checked: true, head: headOid });
  });

  /**
   * THE ATTACK. A session forges a view, commits it on a LOCAL `ops/pr-views`, and points the remote-tracking
   * ref at that commit too — all offline, no credential. If any of that reached the read, the transport would
   * be worth nothing.
   */
  it('ignores a locally forged branch AND a locally repointed tracking ref', () => {
    const forgedBody = 'a paraphrase in the session\'s own voice';
    const wt = join(clone, '..', 'forge');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'origin/ops/pr-views'], { cwd: clone });
    writeFileSync(join(wt, viewPath(prViewFileName(REPO, 1496))), `${JSON.stringify(view({ headRefOid: headOid, body: forgedBody }), null, 2)}\n`);
    git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'forged');
    const forged = git(wt, 'rev-parse', 'HEAD');
    git(clone, 'branch', '-f', 'ops/pr-views', forged);
    git(clone, 'update-ref', 'refs/remotes/origin/ops/pr-views', forged);
    // The forgery really is in this clone — assert the precondition so the test cannot pass vacuously.
    expect(git(clone, 'show', `ops/pr-views:${viewPath(prViewFileName(REPO, 1496))}`)).toContain(forgedBody);

    const out = realReader()({ repo: REPO, pr: 1496 });
    expect(out.view.body).toBe('the PR body');
    expect(out.view.body).not.toBe(forgedBody);
  });

  it('refuses the staged view when the PR head has moved on the remote', () => {
    git(origin, 'checkout', '-q', 'lane/verify-operation');
    writeFileSync(join(origin, 'README.md'), 'z\n');
    git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'a commit the view has never seen');
    git(origin, 'checkout', '-q', 'main');

    const out = realReader()({ repo: REPO, pr: 1496 });
    expect(() => runCheck(out)).toThrow(/STALE view/);
  });

  /**
   * THE ROUND-6 FINDING, and it needs real git for the same reason the forgery test above does: the thing that
   * silently did the wrong thing IS git. A stub asserting "we called fetch" asserts our intent; what actually
   * bites is git's behaviour AFTER a fetch fails — it leaves `refs/remotes/origin/<ref>` exactly where the last
   * successful fetch put it rather than clearing it.
   *
   * So this builds the one shape neither existing `probeHeadOid` test reaches. Those two either fail every git
   * call or fail none; this fails ONLY `fetch`, against a clone that has a real, now-stale tracking ref from an
   * earlier successful probe. Before the fix `rev-parse` answered with that stale commit and the freshness check
   * compared a stale view against a stale head, matched, and staged it — the failure the check exists to refuse,
   * reached through a network blip instead of a moved head. Note the clone must have fetched the branch before:
   * a clone that never had the ref fails `rev-parse` too and refuses correctly, which is why the bug only ever
   * showed on the clones that review the same PR more than once.
   */
  it('does not answer with a stale tracking ref when only the fetch fails', () => {
    const realRun = (argv, opts) => execFileSync('git', argv, { encoding: 'utf8', cwd: opts?.cwd ?? clone });
    // One honest probe, so `origin/lane/verify-operation` exists locally and points at the head as of now.
    expect(probeHeadOid({ headRefName: 'lane/verify-operation', run: realRun, cwd: clone })).toBe(headOid);

    // The remote moves on. The clone is not told.
    git(origin, 'checkout', '-q', 'lane/verify-operation');
    writeFileSync(join(origin, 'README.md'), 'z\n');
    git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'a commit the clone has never fetched');
    const moved = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');
    expect(moved).not.toBe(headOid);

    // The stale ref really is still resolvable — assert the precondition, or this could pass vacuously against
    // a clone that simply had no ref to be fooled by.
    expect(git(clone, 'rev-parse', 'origin/lane/verify-operation')).toBe(headOid);

    // Now the fetch — and ONLY the fetch — fails, as a blip or a rate limit would.
    const blipped = (argv, opts) => {
      if (argv[0] === 'fetch') throw new Error('could not resolve host github.com');
      return realRun(argv, opts);
    };
    expect(probeHeadOid({ headRefName: 'lane/verify-operation', run: blipped, cwd: clone })).toBe('');
  });
});

describe('the dispatching reader', () => {
  it('refuses a source nothing reads bytes for, rather than falling back to the file path', () => {
    const dispatch = createPayloadReader({ read: () => '{}', run: () => '', viewFileName: prViewFileName });
    expect(() => dispatch({ source: 'stdin', repo: 'o/x', pr: 1 })).toThrow(/unknown view source/);
  });

  it('reports a file read\'s provenance, weakness included', () => {
    const out = createPayloadReader({
      read: () => JSON.stringify(view()), run: () => '', viewFileName: prViewFileName, cwd: '/r',
      // The checkout claims the repo under review, so the probe actually runs and reports its real answer
      // (`run` returns '' → no transport). Without this the r2 guard fails closed and reports PRESENT, which
      // is correct behaviour but not what this test is about.
      originRepo: () => 'o/x',
    })({ source: 'file', from: '/tmp/v.json', repo: 'o/x', pr: 1 });
    expect(out.provenance).toMatchObject({ source: 'file', from: '/tmp/v.json', transportAvailable: false });
  });
});

// ── #1548 juror: reviewing a repo the CHECKOUT does not own ──────────────────────────────────────────────────
//
// Every read here was scoped to the checkout the tooling runs FROM, never to the repo being reviewed. Nothing
// caught it because this PR's whole design, reasoning and test suite centred on `we` reviewing `we`'s own PRs,
// where the two coincide. They do not always: plateau-app#144 and #145 were reviewed from a `we` checkout on
// the day this was written. The moment `we` onboarded its own `ops/pr-views`, that stopped working — `--from=`
// was refused with "this repo HAS the CI transport" (true of `we`, false of the target).
describe('#1548 — the reader is scoped to the TARGET repo, not the driver checkout', () => {
  const DRIVER = '/driver-checkout';
  const SIBLING = '/sibling-checkout';

  // The driver HAS the transport branch; the sibling does NOT. That is the exact shape that broke.
  const probeRun = (calls) => (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    if (args[0] === 'ls-remote') return opts?.cwd === DRIVER ? `sha\trefs/heads/${TRANSPORT_BRANCH}\n` : '';
    return '';
  };

  it('probes the SIBLING for transport availability when repoRoot names it', () => {
    const calls = [];
    const dispatch = createPayloadReader({
      read: () => JSON.stringify({ number: 5, headRefOid: 'abc' }),
      run: probeRun(calls), cwd: DRIVER, viewFileName: prViewFileName,
      // Each checkout claims the repo it is: the guard added in r2 refuses to probe a checkout that is not
      // the repo under review, so a fixture that omits this now (correctly) fails closed.
      originRepo: (at) => (at === SIBLING ? 'o/sibling' : 'o/driver'),
    });
    dispatch({ source: 'file', from: '/tmp/payload.json', repo: 'o/sibling', pr: 5, repoRoot: SIBLING });
    const probe = calls.find((c) => c.args?.[0] === 'ls-remote');
    expect(probe.cwd).toBe(SIBLING);
  });

  it('reports transportAvailable for the TARGET, so the driver\'s own branch cannot refuse a sibling', () => {
    // THE REGRESSION, at the layer that produces the signal. `checkViewProvenance` refuses `--from=` when
    // `transportAvailable` is true; before the fix the probe ran in the driver, so reviewing a sibling from a
    // `we` checkout reported `we`'s branch and the refusal fired about a repo that has no transport at all.
    const calls = [];
    const reader = () => createPayloadReader({
      read: () => JSON.stringify({ number: 5, headRefOid: 'abc' }),
      run: probeRun(calls), cwd: DRIVER, viewFileName: prViewFileName,
      originRepo: (at) => (at === SIBLING ? 'o/sibling' : 'o/driver'),
    });
    const sibling = reader()({ source: 'file', from: '/tmp/payload.json', repo: 'o/sibling', pr: 5, repoRoot: SIBLING });
    expect(sibling.provenance).toMatchObject({ transportAvailable: false, probed: true });

    // …and the guard is NOT weakened into "pass repoRoot to bypass it": with no repoRoot the driver IS the
    // target, it does carry the branch, and `--from=` stays closed.
    const own = reader()({ source: 'file', from: '/tmp/payload.json', repo: 'o/driver', pr: 5 });
    expect(own.provenance).toMatchObject({ transportAvailable: true, probed: true });
  });
});

// ── #1548 round 2: a repoRoot pointing anywhere is not a bypass ───────────────────────────────────────────────
//
// Round 1 scoped the probe to `repoRoot` so a sibling repo could be reviewed. That fix opened a hole in the
// same move: nothing checked the named checkout actually BELONGS to the repo under review, so
// `--repoRoot=<any checkout without the branch>` reported "no transport here" and re-opened `--from=` — the
// hand-authored path this whole change exists to close. Found by the round-2 juror, against a commit message
// that claimed the guard was not weakened.
describe('#1548 r2 — the named checkout must BE the repo under review', () => {
  const OWNED = '/owned-checkout';
  const UNRELATED = '/unrelated-checkout';
  const withTransport = (args) => (args[0] === 'ls-remote' ? `sha\trefs/heads/${TRANSPORT_BRANCH}\n` : '');

  const reader = (originRepo) => createPayloadReader({
    read: () => JSON.stringify({ number: 5, headRefOid: 'abc' }),
    run: withTransport, cwd: OWNED, viewFileName: prViewFileName, originRepo,
  });

  it('reports the transport PRESENT when repoRoot names a checkout that is not the repo — fails closed', () => {
    // THE BYPASS. The unrelated checkout has no `ops/pr-views`, so a naive probe would answer "no transport"
    // and let the hand-authored view through for a repo that does have one.
    const out = reader((at) => (at === OWNED ? 'o/target' : 'o/somethingelse'))(
      { source: 'file', from: '/tmp/p.json', repo: 'o/target', pr: 5, repoRoot: UNRELATED },
    );
    expect(out.provenance).toMatchObject({ transportAvailable: true, probed: false });
  });

  it('still probes for real when the checkout DOES belong to the repo', () => {
    const out = reader(() => 'o/target')({ source: 'file', from: '/tmp/p.json', repo: 'o/target', pr: 5, repoRoot: OWNED });
    expect(out.provenance).toMatchObject({ transportAvailable: true, probed: true });
  });

  it('an unreadable origin fails closed too — an unanswerable probe never opens the weaker path', () => {
    const out = reader(() => '')({ source: 'file', from: '/tmp/p.json', repo: 'o/target', pr: 5, repoRoot: UNRELATED });
    expect(out.provenance).toMatchObject({ transportAvailable: true, probed: false });
  });
});
