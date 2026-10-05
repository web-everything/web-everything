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

  // THE WEB-UI TEST CASE (#3067's own "done when" bullet: "the web-UI route is the test case"). No shell
  // command can intercept a web-UI body edit — `guard-bash.mjs` has nothing to deny — so the live body simply
  // arrives with its stamp gone, indistinguishable BY ORIGIN from any other edit route. What recovers it is
  // that GitHub's timeline records `changes.body.from` identically no matter what wrote the edit — `gh`, the
  // REST/GraphQL API, or a human typing into the web UI. This proves the recovery logic doesn't need to know,
  // or care, which route stripped the stamp.
  it('recovers a stamp stripped by a route no shell guard can see — the timeline does not care who edited', () => {
    const openedBody = `Resolve #1234: fix the thing.\n\n${stamp(A)}`;
    // The web UI edit: GitHub's timeline records the body AS IT STOOD before the edit (`changes.body.from`),
    // then the live body moves on to whatever the human typed — here, with the stamp gone.
    const timelineFromBodies = [openedBody];
    const liveBodyAfterWebEdit = 'Resolve #1234: fix the thing, revised for clarity.'; // no stamp
    expect(readAuthorActorStamps(liveBodyAfterWebEdit)).toEqual([]); // confirms the strip actually happened
    const recovered = recoverAuthorIdFromHistory(timelineFromBodies);
    expect(recovered).toBe(A);
    // And the recovered id restores cleanly onto the live body via the SAME carry-forward the base mode uses.
    const { body } = withCarriedStamps(buildAuthorActorMarker(recovered), liveBodyAfterWebEdit);
    expect(parseAuthorActorId(body)).toBe(A);
  });
});

describe('repair() — #3067 r2: a failed timeline FETCH must not read as a genuinely-empty timeline', () => {
  const pr = '1308';
  const repo = 'o/r';
  const unstamped = 'live body with no stamp';
  const ghView = (body) => vi.fn((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ body });
    throw new Error(`unexpected gh() call in test: ${args.join(' ')}`);
  });
  // `repair`'s 4th param is the injectable `execFileSync`-shaped seam (default: the real one) — the same
  // dependency-injection shape `computeNetDiffChangedFiles`'s `exec` uses elsewhere in scripts/. Both the
  // timeline fetch (`gh api …`) and the body write (`gh pr edit …`, via `writeBody`) funnel through it, keyed
  // here on the subcommand.
  const editCall = (execFile) => execFile.mock.calls.find(([, args]) => args[0] === 'pr' && args[1] === 'edit');

  it('a THROWN/failed timeline fetch does NOT mark the PR stamp-lost, and exits non-zero', () => {
    const execFile = vi.fn((cmd, args) => {
      if (args[0] === 'api') throw new Error('simulated network blip');
      throw new Error(`unexpected execFile call in test: ${args.join(' ')}`);
    });
    const result = repair(ghView(unstamped), pr, repo, execFile);
    expect(result).not.toBe(0); // a distinct "could not investigate" outcome, not the happy-path 0
    expect(editCall(execFile)).toBeUndefined(); // never wrote ANYTHING back to the PR — no stamp-lost marker
  });

  it('a genuinely-empty timeline (the fetch SUCCEEDS, returns no edits) still marks the PR stamp-lost', () => {
    const execFile = vi.fn((cmd, args) => {
      if (args[0] === 'api') return JSON.stringify([]); // a real, successful, empty result
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected execFile call in test: ${args.join(' ')}`);
    });
    const result = repair(ghView(unstamped), pr, repo, execFile);
    expect(result).toBe(0);
    const call = editCall(execFile);
    expect(call).toBeTruthy();
    expect(hasStampLostMarker(call[2].input)).toBe(true);
  });

  it('a genuinely-searched timeline that DOES recover a stamp restores it — not stamp-lost', () => {
    const id = '01f39b97-274a-4078-8eeb-e7f8d6008673';
    const events = [{ event: 'edited', changes: { body: { from: `old\n\n${buildAuthorActorMarker(id)}` } } }];
    const execFile = vi.fn((cmd, args) => {
      if (args[0] === 'api') return JSON.stringify(events);
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected execFile call in test: ${args.join(' ')}`);
    });
    const result = repair(ghView(unstamped), pr, repo, execFile);
    expect(result).toBe(0);
    const call = editCall(execFile);
    expect(readAuthorActorStamps(call[2].input)).toEqual([id]);
    expect(hasStampLostMarker(call[2].input)).toBe(false);
  });

  it('a PR already marked stamp-lost short-circuits without ever calling the timeline endpoint again', () => {
    // This is WHY the false-mark bug matters: the mark is sticky, so a transient failure that wrongly wrote it
    // would never get another chance to recover for real.
    const alreadyMarked = 'live body\n\n<!-- author-stamp-lost: unrecoverable -->';
    const execFile = vi.fn((cmd, args) => {
      throw new Error(`unexpected execFile call in test: ${args.join(' ')}`);
    });
    const result = repair(ghView(alreadyMarked), pr, repo, execFile);
    expect(result).toBe(0);
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
