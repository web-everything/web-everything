/**
 * @file produce-pr-view.test.mjs — the CI half of the PR-view transport (#xaoja7a).
 *
 * THE DEFECT UNDER TEST is not in this file's code, it is in the code this file REPLACES. Until now the
 * reviewing session supplied the PR's body, comments and file list itself, because this host has no mechanical
 * read path. On PR #1542 the staged view carried a paraphrase of the body in the session's own voice plus a
 * comment the session had authored, stamped `authorAssociation: OWNER`, that is not on the PR at all. Every
 * completeness check passed; the evidence was fabricated.
 *
 * So the assertions below are about two things only: that the argv is derived from a validated request and a
 * field list with a single home, and that NOTHING here authors any part of the answer.
 */
import { describe, it, expect } from 'vitest';
import {
  TRANSPORT_VIEW_FIELDS, producePrView, serializeView, viewArgv,
} from '../produce-pr-view.mjs';
import { PR_STATE_FIELDS } from '../lib/review-label-provider.mjs';
import { PR_VIEW_FIELDS, prViewFileName } from '../operations/review-pr-io.mjs';

const RESPONSE = {
  number: 1542,
  title: 'a real PR',
  url: 'https://github.com/web-everything/web-everything/pull/1542',
  body: 'the authored PR description',
  labels: [{ name: 'review:human' }],
  comments: [{ author: { login: 'chalbert' }, authorAssociation: 'OWNER', body: 'the drain park notice' }],
  files: [{ path: 'scripts/x.mjs', additions: 1, deletions: 0 }],
  headRefName: 'lane/x',
  headRefOid: 'a'.repeat(40),
  state: 'OPEN',
  createdAt: '2026-08-20T00:00:00Z',
};
const gh = (out = JSON.stringify(RESPONSE)) => {
  const seen = [];
  return { seen, exec: (argv) => { seen.push(argv); return out; } };
};

describe('the argv is derived, never typed', () => {
  it('asks for the union of the reader\'s fields and the label arc\'s', () => {
    for (const f of [...PR_VIEW_FIELDS, ...PR_STATE_FIELDS]) expect(TRANSPORT_VIEW_FIELDS).toContain(f);
  });

  /**
   * `headRefOid` IS THE POINT of pulling `PR_STATE_FIELDS` in. It is not in the reader's own list, and it is
   * what lets the staging side refuse a view whose head has moved — without it a stale view silently describes
   * a tree that is no longer the one under review.
   */
  it('carries `headRefOid`, which the reader\'s own list does not', () => {
    expect(PR_VIEW_FIELDS).not.toContain('headRefOid');
    expect(TRANSPORT_VIEW_FIELDS).toContain('headRefOid');
  });

  it('runs ONE `gh pr view` with the request\'s own repo and pr', () => {
    expect(viewArgv({ repo: 'web-everything/web-everything', pr: 1542 }))
      .toEqual(['pr', 'view', '1542', '--repo', 'web-everything/web-everything', '--json', TRANSPORT_VIEW_FIELDS.join(',')]);
  });
});

describe('it publishes what `gh` returned, and nothing it wrote itself', () => {
  it('returns the response verbatim, under the reader\'s own file name', () => {
    const { exec, seen } = gh();
    const out = producePrView({ request: { repo: 'web-everything/web-everything', pr: 1542 }, exec });
    expect(seen).toHaveLength(1);
    expect(out.fileName).toBe(prViewFileName('web-everything/web-everything', 1542));
    // Every field of the response survives untouched — no summary, no normalisation, no invented key.
    for (const [k, v] of Object.entries(RESPONSE)) expect(out.view[k]).toEqual(v);
  });

  /**
   * THE FILE NAME IS `prViewFileName`, NOT `<owner>-<repo>-<pr>.json`. The `-`-flattened form is NOT injective:
   * `foo-bar/baz` and `foo/bar-baz` collide, and when they did, one repo's view silently answered for the
   * other's while the diff still came from the right tree, so nothing could notice (#1466).
   */
  it('uses the injective namer, so two repos cannot collide onto one view', () => {
    const a = producePrView({ request: { repo: 'foo-bar/baz', pr: 5 }, exec: gh(JSON.stringify({ ...RESPONSE, number: 5 })).exec });
    const b = producePrView({ request: { repo: 'foo/bar-baz', pr: 5 }, exec: gh(JSON.stringify({ ...RESPONSE, number: 5 })).exec });
    expect(a.fileName).not.toBe(b.fileName);
  });

  it('carries the repo on the view, so the committed file is self-describing', () => {
    const out = producePrView({ request: { repo: 'web-everything/web-everything', pr: 1542 }, exec: gh().exec });
    expect(out.view.repo).toBe('web-everything/web-everything');
  });

  /**
   * NO TIMESTAMP, DELIBERATELY. A produce that finds the PR unchanged must yield byte-identical output, so the
   * workflow's `git diff --cached` reports nothing and the branch does not grow a commit per poll — and so the
   * reading side's blob-sha poll predicate means "CI published something NEW".
   */
  it('serializes deterministically — two produces of the same PR are byte-identical', () => {
    expect(serializeView(RESPONSE)).toBe(serializeView(JSON.parse(JSON.stringify(RESPONSE))));
    expect(serializeView(RESPONSE)).not.toMatch(/producedAt|generatedAt|timestamp/);
  });
});

describe('refusals, before anything reaches the branch', () => {
  // The value reaches `gh pr view --repo <repo>` inside a job holding `contents: write`.
  it('refuses a request that is not <owner>/<name> and a positive integer, without running gh', () => {
    const { exec, seen } = gh();
    expect(() => producePrView({ request: { repo: 'nope', pr: 1 }, exec })).toThrow(/owner\/name/);
    expect(() => producePrView({ request: { repo: 'o/x', pr: -1 }, exec })).toThrow(/positive integer/);
    expect(seen).toEqual([]);
  });

  /**
   * THE SUBJECT IS VERIFIED even though `gh` could only answer what it was asked. The value that lands on the
   * branch is trusted downstream by a reader with no other way to tell, and a mismatched view reviews a
   * different PR with the diff still correctly taken from local git — invisible (#1466).
   */
  it('refuses a response about a different PR', () => {
    const { exec } = gh(JSON.stringify({ ...RESPONSE, number: 1541 }));
    expect(() => producePrView({ request: { repo: 'web-everything/web-everything', pr: 1542 }, exec })).toThrow(/#1541/);
  });

  it('refuses a response with no `number` at all', () => {
    const { number, ...rest } = RESPONSE;
    const { exec } = gh(JSON.stringify(rest));
    expect(() => producePrView({ request: { repo: 'web-everything/web-everything', pr: 1542 }, exec }))
      .toThrow(/no `number` field at all/);
  });

  it('names bytes that are not JSON rather than publishing them', () => {
    const { exec } = gh('gh: HTTP 403');
    expect(() => producePrView({ request: { repo: 'web-everything/web-everything', pr: 1542 }, exec }))
      .toThrow(/not JSON/);
  });

  it('refuses a JSON response that is not an object', () => {
    for (const body of ['[]', 'null', '7']) {
      expect(() => producePrView({ request: { repo: 'o/x', pr: 1 }, exec: gh(body).exec })).toThrow(/no object|not JSON/);
    }
  });
});
