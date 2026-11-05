/**
 * @file pr-body-edit.test.mjs — the stamp survives a body rewrite, and the guard denies the raw command.
 */
import { describe, it, expect, vi } from 'vitest';
import { withCarriedStamps, recoverAuthorIdFromHistory, repair } from '../pr-body-edit.mjs';
import {
  buildAuthorActorMarker, parseAuthorActorId, readAuthorActorStamps, hasStampLostMarker,
} from '../lib/review-independence.mjs';
import { reason } from '../guard-bash.mjs';

const A = '01f39b97-274a-4078-8eeb-e7f8d6008673';
const B = 'ffffffff-1111-2222-3333-444444444444';
const stamp = (id) => buildAuthorActorMarker(id);

describe('withCarriedStamps', () => {
  it('carries a stamp the replacement body dropped', () => {
    // The #1162 case: pr-land stamped the body at open, three `gh pr edit --body-file` rewrites dropped it,
    // and the self-clear guard then read `unknown-author` and permitted the author's own clearance.
    const { body, carried } = withCarriedStamps(`old text\n\n${stamp(A)}`, 'brand new body');
    expect(carried).toEqual([A]);
    expect(parseAuthorActorId(body)).toBe(A);
    expect(body).toContain('brand new body');
  });

  it('does not duplicate a stamp the replacement already carries', () => {
    const next = `new body\n\n${stamp(A)}`;
    const { body, carried } = withCarriedStamps(`old\n\n${stamp(A)}`, next);
    expect(carried).toEqual([]);
    expect(readAuthorActorStamps(body)).toEqual([A]);
  });

  it('carries BOTH stamps of an ambiguous body, keeping it ambiguous', () => {
    // `parseAuthorActorId` resolves a two-stamp body to '' by design (agreement-or-nothing). Carrying only one
    // would convert an unresolvable body into a confident single-author one — a refusal silently becoming a
    // permit, which is the same class of defect this whole script exists to close.
    const { body } = withCarriedStamps(`old\n\n${stamp(A)}\n${stamp(B)}`, 'new');
    expect(readAuthorActorStamps(body).sort()).toEqual([A, B].sort());
    expect(parseAuthorActorId(body)).toBe('');
  });

  it('leaves an unstamped body unstamped rather than inventing one', () => {
    const { body, carried } = withCarriedStamps('no stamp here', 'new');
    expect(carried).toEqual([]);
    expect(readAuthorActorStamps(body)).toEqual([]);
  });
});

describe('recoverAuthorIdFromHistory — #3067\'s recovery from GitHub\'s OWN edit-history record', () => {
  it('finds the stamp in a single prior body snapshot', () => {
    expect(recoverAuthorIdFromHistory([`old body\n\n${stamp(A)}`])).toBe(A);
  });

  it('the SAME id repeated across several snapshots still resolves — duplication is not a conflict', () => {
    expect(recoverAuthorIdFromHistory([`v1\n\n${stamp(A)}`, `v2\n\n${stamp(A)}`, 'v3 no stamp'])).toBe(A);
  });

  it('DIFFERENT ids across history are AGREEMENT-OR-NOTHING, same discipline as the live-body reader', () => {
    expect(recoverAuthorIdFromHistory([`v1\n\n${stamp(A)}`, `v2\n\n${stamp(B)}`])).toBe('');
  });

  it('no stamp anywhere in the history recovers nothing', () => {
    expect(recoverAuthorIdFromHistory(['v1 plain', 'v2 also plain'])).toBe('');
  });

  it('empty/non-array input recovers nothing rather than throwing', () => {
    expect(recoverAuthorIdFromHistory([])).toBe('');
    expect(recoverAuthorIdFromHistory(undefined)).toBe('');
    expect(recoverAuthorIdFromHistory(null)).toBe('');
  });

  it('restores a supplied historical body snapshot using the carry-forward helper', () => {
    // This pure helper consumes body strings; GraphQL transport and editor provenance are tested below.
    const recovered = recoverAuthorIdFromHistory([`Original body\n\n${stamp(A)}`]);
    const { body } = withCarriedStamps(stamp(recovered), 'Operator revision');
    expect(parseAuthorActorId(body)).toBe(A);
  });
});

describe('repair() — GraphQL userContentEdits recovery', () => {
  const pr = '6244';
  const repo = 'o/r';
  const unstamped = 'live body with no stamp';
  const ghView = (body) => vi.fn((args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ state: 'OPEN', body, author: { login: 'app/plateau-worker' } });
    }
    throw new Error(`unexpected gh() call in test: ${args.join(' ')}`);
  });
  const response = (nodes) => JSON.stringify({ data: { repository: { pullRequest: {
    userContentEdits: { totalCount: nodes?.length ?? 0, nodes, pageInfo: { hasNextPage: false, endCursor: null } },
  } } } });
  const editCall = (execFile) => execFile.mock.calls.find(([, args]) => args[0] === 'pr' && args[1] === 'edit');
  const stubExec = (readHistory) => vi.fn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') return readHistory();
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'edit') return '';
    throw new Error(`unexpected execFile call in test: ${args.join(' ')}`);
  });
  const expectGraphqlOnly = (execFile) => {
    const apiCalls = execFile.mock.calls.filter(([, args]) => args[0] === 'api');
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(apiCalls.every(([cmd, args]) => cmd === 'gh' && args[1] === 'graphql')).toBe(true);
    expect(JSON.stringify(apiCalls)).toContain('userContentEdits');
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('/timeline');
  };

  it('recovers #6244 via GraphQL userContentEdits, never the REST issues timeline', () => {
    const nodes = [
      { createdAt: '2026-10-01T10:00:00Z', editor: { __typename: 'Bot', login: 'plateau-worker' }, diff: `Original\n\n${stamp(A)}` },
      { createdAt: '2026-10-01T11:00:00Z', editor: { __typename: 'User', login: 'chalbert' }, diff: 'First web edit' },
      { createdAt: '2026-10-01T12:00:00Z', editor: { __typename: 'User', login: 'chalbert' }, diff: unstamped },
    ];
    const execFile = stubExec(() => response(nodes));
    expect(repair(ghView(unstamped), pr, repo, execFile)).toBe(0);
    expectGraphqlOnly(execFile);
    const call = editCall(execFile);
    expect(call).toBeTruthy();
    expect(call[2].input).toBe(`${unstamped}\n\n${stamp(A)}\n`);
    expect(readAuthorActorStamps(call[2].input)).toEqual([A]);
    expect(hasStampLostMarker(call[2].input)).toBe(false);
  });

  it.each([
    ['failed request', () => { throw new Error('simulated network blip'); }],
    ['invalid JSON', () => 'not JSON'],
    ['GraphQL errors', () => JSON.stringify({ errors: [{ message: 'forbidden' }], data: null })],
    ['missing connection', () => JSON.stringify({ data: { repository: { pullRequest: {} } } })],
    ['null nodes', () => response(null)],
  ])('exits non-zero and writes nothing for unreadable history: %s', (_name, readHistory) => {
    const execFile = stubExec(readHistory);
    expect(repair(ghView(unstamped), pr, repo, execFile)).not.toBe(0);
    expectGraphqlOnly(execFile);
    expect(editCall(execFile)).toBeUndefined();
  });

  it('refuses successfully read but empty history without writing a stamp-lost marker', () => {
    const execFile = stubExec(() => response([]));
    expect(repair(ghView(unstamped), pr, repo, execFile)).not.toBe(0);
    expectGraphqlOnly(execFile);
    expect(editCall(execFile)).toBeUndefined();
  });

  it('a PR already marked stamp-lost short-circuits without any history request', () => {
    const execFile = stubExec(() => { throw new Error('history must not be read'); });
    expect(repair(ghView('live body\n\n<!-- author-stamp-lost: unrecoverable -->'), pr, repo, execFile)).toBe(0);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('guard-bash denies a raw PR-body rewrite', () => {
  // Every spelling that replaces the body. The short flags and the quoted form were BYPASSES in the first
  // cut — `gh` documents `-b`/`-F` as exact equivalents, and a quoted `"--body-file"` has a quote before the
  // dashes rather than whitespace, so a raw-string regex missed both.
  for (const cmd of [
    'gh pr edit 1162 --body-file /tmp/body.md',
    'gh pr edit 1162 --repo web-everything/web-everything --body-file /tmp/b.md',
    'gh pr edit 1162 --body "text"',
    'gh pr edit 1162 --body="text"',
    'gh pr edit 1162 -F /tmp/body.md',
    'gh pr edit 1162 -b "text"',
    'gh pr edit 1162 "--body-file" /tmp/b.md',
    "gh pr edit 1162 '--body' 'text'",
    'gh api -X PATCH repos/o/r/pulls/1162 -f body=text',
    'gh api graphql -f query=mutation{updatePullRequest(input:{body:"x"})}',
    // pflag glues a value onto the shorthand, so these are ONE token each. Anchoring `-[bF]$` matched none
    // of them — the fourth bypass, each verified against the real `gh`.
    'gh pr edit 1162 -F/tmp/body.md',
    'gh pr edit 1162 -F=/tmp/body.md',
    'gh pr edit 1162 -bhello',
    'gh pr edit 1162 -b=hello',
    // The payload is in a file, so no `body=` appears anywhere in argv — refused on shape, not content.
    'gh api repos/o/r/pulls/1162 -X PATCH --input /tmp/patch.json',
    // …and the graphql endpoint has no `pulls/<n>` path to key on, so with the mutation in a file NEITHER the
    // endpoint nor `updatePullRequest` appears in argv. Verified against real `gh`: it reaches the resolver.
    'gh api graphql --input /tmp/gql.json',
    'gh api graphql --input -',
    'gh api graphql -F query=@/tmp/mutation.graphql',
  ]) {
    it(`denies: ${cmd}`, () => {
      expect(reason(cmd)).toMatch(/authored-by-actor|pr-body-edit/);
    });
  }

  // `-B` is `--base`, a different flag entirely. Case matters, and denying it would block a legitimate
  // retarget. Dropping the `$` anchor made this test load-bearing: `-[bF]` without it is one case-fold away
  // from swallowing `-Bmain`.
  it('does not deny the base flag, which only differs by case', () => {
    expect(reason('gh pr edit 1162 -B main')).toBeFalsy();
    expect(reason('gh pr edit 1162 -Bmain')).toBeFalsy();
    expect(reason('gh pr edit 1162 --base main')).toBeFalsy();
  });

  // A read of the same endpoint carries no payload and must stay allowed, or every `gh api` inspection of a
  // PR needs the escape.
  it('does not deny a GET of a pulls endpoint', () => {
    expect(reason('gh api repos/o/r/pulls/1162')).toBeFalsy();
    expect(reason('gh api repos/o/r/pulls/1162 --jq .body')).toBeFalsy();
  });

  it('allows a label edit — every `gh pr edit` in scripts/ is labels only', () => {
    expect(reason('gh pr edit 1162 --add-label ready-to-merge')).toBeFalsy();
    expect(reason('gh pr edit 1162 --remove-label review:pending')).toBeFalsy();
  });

  // `pr-land` opens PRs with `gh pr create --body` through its own execFileSync, which never passes this
  // Bash-tool hook, so it still writes the stamp. A RAW `gh pr create` typed by an agent is denied instead:
  // it opens an unstamped PR (plateau-app #204), which voids the referral reviewer's rulings.
  it('denies a raw `gh pr create` (pr-land\'s own create never passes this hook); the escape still allows it', () => {
    expect(reason('gh pr create --title x --body-file /tmp/b.md')).toMatch(/authored-by-actor/);
    expect(reason('RAW_PR_CREATE_OK=1 gh pr create --title x --body-file /tmp/b.md')).toBeFalsy();
  });

  it('does not deny a read of a PR body', () => {
    expect(reason('gh pr view 1162 --json body')).toBeFalsy();
    expect(reason('gh api repos/o/r/pulls/1162')).toBeFalsy();
  });

  it('honours the sanctioned override, which is how pr-body-edit itself writes', () => {
    expect(reason('PR_BODY_STAMP_OK=1 gh pr edit 1162 --body-file /tmp/b.md')).toBeFalsy();
    expect(reason('PR_BODY_STAMP_OK=1 gh pr edit 1162 -F /tmp/b.md')).toBeFalsy();
  });
});
