/**
 * @file pr-view-transport.test.mjs — the names and the field list the CI-staged PR view transport stands on
 *   (#xaoja7a).
 *
 * WHY THESE ARE WORTH PINNING RATHER THAN "OBVIOUS CONSTANTS". Every one of them is a place a previous version
 * of this repo lost a review to a silent mismatch:
 *
 *   · THE REF. `origin/ops/pr-views` and `ops/pr-views` differ by one word and by the entire trust property —
 *     the second is a local branch this session can commit to with no credential.
 *   · THE DIRECTORIES. `requests/` and `views/` are separate so the workflow's own push cannot re-trigger it;
 *     one flat directory would be an infinite loop.
 *   · THE FIELD LIST. It is the union of two existing homes. Typing it out would give CI a third answer to what
 *     the reader consumes, and the two would drift the first time either home gained a field.
 */
import { describe, it, expect } from 'vitest';
import {
  REQUEST_DIR, TRANSPORT_BRANCH, TRANSPORT_REF, VIEW_DIR,
  buildViewRequest, fetchTransportArgv, requestPath, showViewArgv, transportBranchArgv, transportCommitArgv,
  transportViewFields, validateViewRequest, viewBlobArgv, viewPath,
} from '../pr-view-transport.mjs';
import { PR_STATE_FIELDS } from '../review-label-provider.mjs';
import { PR_VIEW_FIELDS } from '../../operations/review-pr-io.mjs';

const NAME = 'chalbert%2Fweb-everything-1542.json';

describe('the ref a view may be read from', () => {
  /**
   * THE WHOLE STRUCTURAL PROPERTY IN ONE ASSERTION. `git show ops/pr-views:…` reads a LOCAL branch — writable
   * by this session with no network and no credential — which would be exactly the trust of reading a file off
   * disk. The remote-tracking ref is what the fetch just overwrote.
   */
  it('is the REMOTE-tracking ref, never the local branch', () => {
    expect(TRANSPORT_REF).toBe('origin/ops/pr-views');
    expect(TRANSPORT_REF).not.toBe(TRANSPORT_BRANCH);
    expect(showViewArgv(NAME)).toEqual(['show', `${TRANSPORT_REF}:${VIEW_DIR}/${NAME}`]);
  });

  /**
   * A BARE `git fetch origin ops/pr-views` leaves the result in `FETCH_HEAD` and does not necessarily update
   * `origin/ops/pr-views`. The read would then use a stale tracking ref and report success — the exact class of
   * silent failure this transport exists to close.
   */
  it('fetches into the tracking ref explicitly, and forces it', () => {
    expect(fetchTransportArgv()).toEqual([
      'fetch', '--quiet', 'origin', '+refs/heads/ops/pr-views:refs/remotes/origin/ops/pr-views',
    ]);
  });

  it('probes the remote for the branch, and reads the ref\'s commit, without touching a working tree', () => {
    expect(transportBranchArgv()).toEqual(['ls-remote', '--heads', 'origin', 'refs/heads/ops/pr-views']);
    expect(transportCommitArgv()).toEqual(['rev-parse', TRANSPORT_REF]);
    expect(viewBlobArgv(NAME)).toEqual(['rev-parse', `${TRANSPORT_REF}:${VIEW_DIR}/${NAME}`]);
  });
});

describe('the two directories', () => {
  // Separate so the workflow's own view push cannot match its own `paths:` trigger. One directory is a loop.
  it('keeps requests and views apart', () => {
    expect(REQUEST_DIR).toBe('ops/pr-views/requests');
    expect(VIEW_DIR).toBe('ops/pr-views/views');
    expect(viewPath(NAME)).not.toBe(requestPath(NAME));
  });

  // The name reaches a git pathspec and, in CI, a filesystem write inside a job holding `contents: write`.
  it('refuses a file name carrying a path', () => {
    for (const bad of ['../x.json', 'a/b.json', '', '.', '..', 'a\\b.json']) {
      expect(() => viewPath(bad)).toThrow(/bare file name/);
      expect(() => requestPath(bad)).toThrow(/bare file name/);
    }
  });
});

describe('the `gh pr view --json` field list', () => {
  /**
   * THE UNION, COMPUTED. `PR_VIEW_FIELDS` is what `assembleReviewDetail` consumes; `PR_STATE_FIELDS` carries
   * `headRefOid`, the field that makes a staged view falsifiable against the tree the diff will come from.
   * Adding a field to either home must reach CI with no edit here.
   */
  it('is the union of the reader\'s list and the label arc\'s, deduped', () => {
    const fields = transportViewFields(PR_VIEW_FIELDS, PR_STATE_FIELDS);
    for (const f of PR_VIEW_FIELDS) expect(fields).toContain(f);
    for (const f of PR_STATE_FIELDS) expect(fields).toContain(f);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('carries `headRefOid`, `files` and `comments` — the three the transport turns on', () => {
    const fields = transportViewFields(PR_VIEW_FIELDS, PR_STATE_FIELDS);
    expect(fields).toContain('headRefOid');
    expect(fields).toContain('files');
    expect(fields).toContain('comments');
  });

  it('refuses to invent a list when either home is missing', () => {
    expect(() => transportViewFields([], PR_STATE_FIELDS)).toThrow(/readerFields/);
    expect(() => transportViewFields(PR_VIEW_FIELDS, null)).toThrow(/stateFields/);
    expect(() => transportViewFields(PR_VIEW_FIELDS, ['ok', 7])).toThrow(/stateFields/);
  });
});

describe('the request a session pushes', () => {
  it('carries the two identifying fields and nothing that steers what CI fetches', () => {
    const req = buildViewRequest({ repo: 'web-everything/web-everything', pr: 1542, requestedAt: '2026-08-24T00:00:00Z' });
    expect(req).toEqual({ repo: 'web-everything/web-everything', pr: 1542, requestedAt: '2026-08-24T00:00:00Z' });
  });

  /**
   * `requestedAt` IS LOAD-BEARING. A re-request with identical bytes leaves `git diff --cached` empty, so
   * nothing is committed, nothing is pushed, and the workflow that would have refreshed a stale view never
   * runs — silent under-delivery, the shape `we:scripts/collect-review-requests.mjs` was written about.
   */
  it('differs between two asks for the same PR, so the push is not a no-op', () => {
    const a = buildViewRequest({ repo: 'o/x', pr: 1, requestedAt: '2026-08-24T00:00:00Z' });
    const b = buildViewRequest({ repo: 'o/x', pr: 1, requestedAt: '2026-08-24T00:05:00Z' });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  // This value reaches `gh pr view --repo <repo>` inside a job holding a write token.
  it('refuses anything that is not <owner>/<name> and a positive integer', () => {
    expect(validateViewRequest({ repo: 'nope', pr: 1 }).error).toMatch(/owner\/name/);
    expect(validateViewRequest({ repo: 'o/x; rm -rf /', pr: 1 }).error).toMatch(/owner\/name/);
    expect(validateViewRequest({ repo: 'o/x', pr: 0 }).error).toMatch(/positive integer/);
    expect(validateViewRequest({ repo: 'o/x', pr: '1' }).error).toMatch(/positive integer/);
    expect(validateViewRequest(null).error).toMatch(/JSON object/);
    expect(validateViewRequest([]).error).toMatch(/JSON object/);
    expect(() => buildViewRequest({ repo: 'nope', pr: 1 })).toThrow(/owner\/name/);
  });

  it('accepts a well-formed one', () => {
    expect(validateViewRequest({ repo: 'web-everything/web-everything', pr: 1542 }))
      .toEqual({ ok: true, request: { repo: 'web-everything/web-everything', pr: 1542 } });
  });
});
