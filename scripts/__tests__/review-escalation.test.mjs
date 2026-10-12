/**
 * @file scripts/__tests__/review-escalation.test.mjs
 * @description Pure-function coverage for `scripts/lib/review-escalation.mjs`'s #2324 escalation-reason-in-body
 *   helpers: the drain augments a `review:human` PR's body with WHY a human is required (never replacing it),
 *   and a cheap marker check lets the gate verify the write actually landed.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreEscalation, buildEscalationReasonBlock, bodyHasEscalationReason, ESCALATION_REASON_MARKER, hasUnclearedReviewLabel, REVIEW_LABELS, READY_TO_MERGE_LABEL, REVIEW_HOLD_LABELS, isReviewHoldLabel, readyMergeConflictsWithHold, decideParkReadyStrip, decideReviewGate, parsePolicyStamp, bodyAlreadyCarriesReasonBlock, reconcileEscalationReasonBlock, decideDurableEscalationRecord } from '../lib/review-escalation.mjs';
import { POLICY_VERSION, POLICY_DIGEST } from '../lib/review-policy.mjs';
import { buildAuthorActorMarker } from '../lib/review-independence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('review-escalation — #2324 escalation-reason-in-body', () => {
  it('builds a marked block listing every reason', () => {
    const block = buildEscalationReasonBlock(['gate-self (scripts/merge-ai-prs.mjs) — human review required']);
    expect(block).toContain(ESCALATION_REASON_MARKER);
    expect(block).toContain('gate-self (scripts/merge-ai-prs.mjs) — human review required');
  });
  it('returns empty string for no/empty reasons (nothing to append)', () => {
    expect(buildEscalationReasonBlock([])).toBe('');
    expect(buildEscalationReasonBlock(undefined)).toBe('');
  });
  it('APPENDS to (never replaces) the existing body', () => {
    const existing = 'This PR does X.';
    const block = buildEscalationReasonBlock(['reason one']);
    const combined = existing + block;
    expect(combined.startsWith(existing)).toBe(true);
    expect(combined).toContain('reason one');
  });
  // The escalation record said WHAT fired and never WHICH RULES were in force. A threshold change therefore
  // split the history into two incomparable halves with no marker at the seam — which is why `gate-health`
  // reports `parameterSet: null` and why retrospective A/B is impossible today.
  describe('the policy stamp — which parameter set scored this PR', () => {
    it('rides the reason block and round-trips', () => {
      const block = buildEscalationReasonBlock(['size (500 ≥ 400 changed lines)']);
      const stamp = parsePolicyStamp(block);
      expect(stamp).not.toBeNull();
      expect(stamp.version).toBe(String(POLICY_VERSION));
      expect(stamp.digest).toBe(POLICY_DIGEST);
    });

    // An unstamped body is every PR opened before this shipped. It must stay DISTINGUISHABLE from a stamped
    // one — defaulting it to "the current set" would silently claim old PRs were scored under today's rules,
    // which is the exact false-attribution this stamp exists to prevent.
    it('reads null for an unstamped body rather than assuming the current set', () => {
      expect(parsePolicyStamp('a PR body with no stamp')).toBeNull();
      expect(parsePolicyStamp('')).toBeNull();
      expect(parsePolicyStamp(undefined)).toBeNull();
    });

    // THE LOAD-BEARING PROPERTY. `version` is hand-declared and nothing forces a bump, so it can read `1`
    // across edits that moved the thresholds. The digest is derived from the contract's bytes, so it cannot.
    // If this ever fails, the stamp has stopped tracking the thing it exists to track.
    it('the digest is derived from the contract text, so it moves when the contract does', () => {
      const contract = readFileSync(resolve(HERE, '..', 'lib', 'review-policy.contract.json'), 'utf8');
      const expected = createHash('sha256').update(contract).digest('hex').slice(0, 12);
      expect(POLICY_DIGEST).toBe(expected);
      // …and a one-character edit changes it, which `version` alone would not reflect.
      const nudged = createHash('sha256').update(`${contract} `).digest('hex').slice(0, 12);
      expect(nudged).not.toBe(POLICY_DIGEST);
    });

    it('an empty reason list still produces no block, so an unescalated PR is not stamped', () => {
      expect(buildEscalationReasonBlock([])).toBe('');
    });
  });

  // THE RENDER BOUNDARY AT THE READ SEAM. PR #1167 shipped both markers and its own description documented
  // them in a fenced example — so `bodyHasEscalationReason` returned true and `parsePolicyStamp` returned a
  // stamp the drain never wrote. The digest in that example was the true current value, so the forged reading
  // was CORRECT, which is worse: nothing about the output looked wrong.
  describe('a quoted marker is documentation, not a stamp', () => {
    const real = buildEscalationReasonBlock(['size (500 ≥ 400 changed lines)']);

    it('still detects the block the drain actually writes', () => {
      expect(bodyHasEscalationReason(real)).toBe(true);
      expect(parsePolicyStamp(real)).not.toBeNull();
    });

    it('ignores the exact PR #1167 shape — the real block inside a fence', () => {
      const documented = `Here is what it looks like:\n\n\`\`\`\n${real}\n\`\`\`\n\nEnd.`;
      expect(bodyHasEscalationReason(documented)).toBe(false);
      expect(parsePolicyStamp(documented)).toBeNull();
    });

    it('ignores an inline span and a tilde fence', () => {
      expect(bodyHasEscalationReason('see `## Escalation reason` above')).toBe(false);
      expect(bodyHasEscalationReason('~~~\n## Escalation reason\n~~~')).toBe(false);
    });

    // An unclosed fence blanks to end-of-body. The cost is a MISSING block, which is visible; the alternative
    // is trusting whatever follows an opener, which is not.
    it('blanks to the end of the body on an unclosed fence', () => {
      expect(bodyHasEscalationReason('```\n## Escalation reason\n')).toBe(false);
    });

    // A ``` inside a ~~~~ block is content, not a terminator.
    it('closes a fence only on the same character, at least as long', () => {
      expect(bodyHasEscalationReason('~~~~\n```\n## Escalation reason\n~~~~')).toBe(false);
    });

    // FOUR MORE FORGERIES, each found by review against the first cut of this boundary and each verified
    // twice: the scanner accepted it AND a markdown renderer showed it as a code block. A reader would have
    // seen documentation while the gate saw a record.
    const M = '## Escalation reason';
    for (const [label, body] of [
      // CommonMark forbids an info string on a CLOSING fence, so ```js is content. The first cut read it as a
      // close, and everything after became scannable.
      ['an info-string "closer" does not close the fence', '```\ntext\n```js\n' + M + '\n```'],
      // `> ``` ` never matched a `^[ \t]*` anchor, so a quoted fence inside a blockquote was invisible.
      ['a fence inside a blockquote', '> ```\n> ' + M + '\n> ```'],
      // The likeliest accidental repeat of the original defect: pasting the block with an indent.
      ['a four-space indented code block', 'para\n\n    ' + M + '\n\npara'],
      ['an HTML <pre> block', '<pre>\n' + M + '\n</pre>'],
      ['an HTML <code> block', '<code>\n' + M + '\n</code>'],
    ]) {
      it(`ignores ${label}`, () => {
        expect(bodyHasEscalationReason(body), label).toBe(false);
      });
    }

    // Stripping blockquote prefixes must not eat an ordinary `>` in prose.
    it('a bare > in prose is not a blockquote prefix', () => {
      expect(bodyHasEscalationReason(`a > b in prose, and ${M} here`)).toBe(true);
    });

    // ROUND 3 — five more, each found by review against the round-2 boundary. Two themes: the CLOSE rule was
    // too permissive, and "indented code starts after a blank line" was the wrong model.
    for (const [label, body] of [
      // CommonMark caps a closing fence's indent at three spaces. Four is content, so the block never closed.
      ['a four-space-indented "closer"', '```\n    ```\n' + M + '\n```'],
      ['a tab-indented "closer"', '```\n\t```\n' + M + '\n```'],
      // The round-2 code STRIPPED `>` and re-scanned, which turned quoted fence content into a bare closer.
      // A blockquote is quoted by definition; the line is now blanked whole and never looked inside.
      ['a blockquoted line used as a closer', '```\n> ```\n' + M + '\n```'],
      // Indented code needs a blank line only to interrupt a PARAGRAPH. After a closed fence or a heading it
      // starts immediately — which the `prevBlank` model missed.
      ['an indented marker straight after a closed fence', '```\nx\n```\n    ' + M],
      ['an indented marker straight after a heading', '# Title\n    ' + M],
      // The drain writes at top level, so nothing legitimate lives behind a `>`.
      ['a plainly blockquoted marker', '> ' + M],
    ]) {
      it(`ignores ${label}`, () => {
        expect(bodyHasEscalationReason(body), label).toBe(false);
      });
    }

    // The paragraph model must not swallow a legitimate indented continuation line.
    it('an indented lazy continuation of a paragraph is not code', () => {
      expect(bodyHasEscalationReason(`a paragraph\n    continued lazily\n${real}`)).toBe(true);
    });

    // ROUND 4 — five more, and the point at which hand-modelling CommonMark was abandoned for markdown-it's
    // own block tokenizer. Sixteen shapes across three rounds, each fix correct and the set never closed:
    // a hand-rolled subset is only as good as its author's knowledge of the grammar.
    for (const [label, body] of [
      ['a marker indented after a setext h1', 'Title\n=====\n    ' + M],
      ['a marker indented after a setext h2', 'x\n---\n    ' + M],
      ['a marker indented after a thematic break', 'p\n\n***\n    ' + M],
      ['a fence inside a bullet list item', '- ```\n  ' + M + '\n  ```'],
      ['a fence inside an ordered list item', '1. ```\n   ' + M + '\n   ```'],
    ]) {
      it(`ignores ${label}`, () => {
        expect(bodyHasEscalationReason(body), label).toBe(false);
      });
    }

    // markdown-it classifies a standalone HTML COMMENT as an `html_block`, and the policy stamp IS a comment —
    // blanking that token type wholesale ate the drain's own stamp. Only code-bearing HTML is blanked.
    it('an HTML comment is not a quoted region, because the stamp is one', () => {
      expect(parsePolicyStamp(real)).not.toBeNull();
    });
  });

  // THE WRITE GUARD IS A DIFFERENT QUESTION, and conflating the two created an append loop.
  // `bodyHasEscalationReason` asks "does a trustworthy record exist" and must ignore quoted text.
  // `bodyAlreadyCarriesReasonBlock` asks "would appending duplicate what is already here" — for which quoted
  // or not is irrelevant, because the bytes are there either way.
  describe('the raw write-guard, so the drain can see its own write', () => {
    const real = buildEscalationReasonBlock(['size (500 ≥ 400 changed lines)']);

    it('sees a block that the trusted reader blanks', () => {
      // A body whose earlier content blanks the appended block: the drain could never see its own write, so
      // it re-appended on EVERY park pass until the body hit its size cap.
      const selfBlanking = '```\n' + real;
      expect(bodyHasEscalationReason(selfBlanking)).toBe(false);
      expect(bodyAlreadyCarriesReasonBlock(selfBlanking)).toBe(true);
    });

    it('is false on a body with no block at all, so a first write still happens', () => {
      expect(bodyAlreadyCarriesReasonBlock('a plain description')).toBe(false);
      expect(bodyAlreadyCarriesReasonBlock('')).toBe(false);
      expect(bodyAlreadyCarriesReasonBlock(undefined)).toBe(false);
    });
  });

  // AGREEMENT-OR-NOTHING, not first-match. First-match is POSITIONAL, not temporal — a body has no clock in
  // it, so a forger who PREPENDS a stamp wins outright. Same reasoning as the author-actor marker.
  describe('two disagreeing stamps resolve to unknown', () => {
    it('a prepended stamp cannot shadow the drain\'s real one', () => {
      const real = buildEscalationReasonBlock(['size (500 ≥ 400 changed lines)']);
      expect(parsePolicyStamp(`<!-- policy-set: v9 ffffffffffff -->\n${real}`)).toBeNull();
    });

    it('two different stamps read as unstamped', () => {
      expect(parsePolicyStamp('<!-- policy-set: v1 aaaaaaaaaaaa -->\n<!-- policy-set: v2 bbbbbbbbbbbb -->')).toBeNull();
    });

    it('the SAME stamp repeated still resolves — repetition is not disagreement', () => {
      const twice = '<!-- policy-set: v1 aaaaaaaaaaaa -->\n<!-- policy-set: v1 aaaaaaaaaaaa -->';
      expect(parsePolicyStamp(twice)).toEqual({ version: '1', digest: 'aaaaaaaaaaaa' });
    });

    // The combination that matters: a real stamp plus a fenced decoy. The fence is blanked first, so the
    // decoy never reaches the agreement test and the real stamp still resolves.
    it('a fenced decoy alongside a real stamp does not poison it', () => {
      const real = buildEscalationReasonBlock(['size (500 ≥ 400 changed lines)']);
      const withDecoy = `${real}\n\n\`\`\`\n<!-- policy-set: v9 ffffffffffff -->\n\`\`\``;
      expect(parsePolicyStamp(withDecoy)).not.toBeNull();
    });
  });

  it('bodyHasEscalationReason detects the marker (present/absent/non-string)', () => {
    expect(bodyHasEscalationReason('some body\n\n## Escalation reason\n\n- x')).toBe(true);
    expect(bodyHasEscalationReason('plain body, no marker')).toBe(false);
    expect(bodyHasEscalationReason('')).toBe(false);
    expect(bodyHasEscalationReason(null)).toBe(false);
    expect(bodyHasEscalationReason(undefined)).toBe(false);
  });
});

// #3044 — the block was stamped ONCE (guard-then-append on the RAW-text `bodyAlreadyCarriesReasonBlock`
// guard) and never refreshed, so a re-park that scored MORE or FEWER reasons than the first park left the
// block a stale snapshot — a fail-open, since #2908 made the block write-authorizing for the converge loop's
// editor-enablement band. `reconcileEscalationReasonBlock` re-derives the block against the CURRENT reason
// set every time. Independently re-parses each resulting block (never reusing the function's own internal
// boundary reader) so these tests can't pass merely because both sides share a bug.
describe('review-escalation — #3044 reconcileEscalationReasonBlock (re-derive-and-replace, not stamp-once)', () => {
  // Deliberately NOT `bodyHasEscalationReason`/`ESCALATION_REASON_MARKER`-aware parsing — an independent,
  // dumber re-read of the resulting body, so a bug shared between the implementation and the test can't hide.
  function parsedReasonsOf(body) {
    const afterMarker = body.split('## Escalation reason')[1] || '';
    const bulletsPart = afterMarker.split('<!--')[0];
    return bulletsPart.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  }

  it('APPENDS when no real marker is present and reasons are non-empty (today\'s behavior, unchanged)', () => {
    const result = reconcileEscalationReasonBlock('Plain PR body.', ['size (500 ≥ 400 changed lines)']);
    expect(result).toEqual({
      body: 'Plain PR body.' + buildEscalationReasonBlock(['size (500 ≥ 400 changed lines)']),
      changed: true,
    });
  });

  it('is a no-op, byte-identical body, when a re-park scores the SAME set in a different order', () => {
    const body = 'PR description.'
      + buildEscalationReasonBlock(['blast-radius (…)', 'size (602 ≥ 400 changed lines)']);
    const result = reconcileEscalationReasonBlock(
      body,
      ['size (602 ≥ 400 changed lines)', 'blast-radius (…)'], // same set, reversed order
    );
    expect(result.changed).toBe(false);
    expect(result.body).toBe(body); // byte-identical — a routine re-park with nothing new writes nothing
  });

  it('REPLACES on growth — the live PR #1018 shape from the #3044 card', () => {
    const recorded = ['blast-radius (dep bump touches 12 files)'];
    const fresh = ['blast-radius (dep bump touches 12 files)', 'size (602 ≥ 400 changed lines)'];
    const body = 'PR description.' + buildEscalationReasonBlock(recorded);
    const result = reconcileEscalationReasonBlock(body, fresh);
    expect(result.changed).toBe(true);
    expect(new Set(parsedReasonsOf(result.body))).toEqual(new Set(fresh));
  });

  it('REPLACES on shrink — a re-score that drops a reason updates the block too, not only growth', () => {
    const recorded = ['blast-radius (dep bump touches 12 files)', 'size (602 ≥ 400 changed lines)'];
    const fresh = ['blast-radius (dep bump touches 12 files)'];
    const body = 'PR description.' + buildEscalationReasonBlock(recorded);
    const result = reconcileEscalationReasonBlock(body, fresh);
    expect(result.changed).toBe(true);
    expect(new Set(parsedReasonsOf(result.body))).toEqual(new Set(fresh));
  });

  it('is a no-op when fresh reasons are empty and no marker is present (nothing to append)', () => {
    const result = reconcileEscalationReasonBlock('Plain PR body.', []);
    expect(result).toEqual({ body: 'Plain PR body.', changed: false });
  });

  it('is a no-op when fresh reasons are empty and a marker IS present — a de-escalation is left as first-park history, never blanked', () => {
    const body = 'PR description.' + buildEscalationReasonBlock(['size (500 ≥ 400 changed lines)']);
    const result = reconcileEscalationReasonBlock(body, []);
    expect(result).toEqual({ body, changed: false });
  });

  it('a quoted/fenced example of the marker is never mistaken for a real block — and is never "replaced" either', () => {
    const documented = 'Here is what the block looks like:\n\n```\n'
      + buildEscalationReasonBlock(['old documented reason']) + '\n```\n\nEnd.';
    const result = reconcileEscalationReasonBlock(documented, ['new real reason']);
    // GUARD ON RAW (#3044-review F1): the trusted reader sees no real block here, but the marker BYTES are
    // present, so appending would duplicate them — and duplicate again on every later pass. Write nothing.
    // The call site then attests `durableRecorded` from `bodyHasEscalationReason` (false here) and falls
    // through to its loud skip-stamp, so the reason is still recorded — just not in the body.
    expect(result).toEqual({ body: documented, changed: false });
  });

  it('preserves content before the marker byte-for-byte on a replace, including an authored-by-actor stamp', () => {
    // we:scripts/pr-body-edit.mjs exists precisely because a body rewrite that forgets to carry this stamp
    // forward disarms the #2844 independence check. reconcileEscalationReasonBlock never rewrites the body
    // WHOLESALE — a replace only ever touches the marker onward — so there is nothing to carry forward, but
    // that guarantee is worth proving directly rather than assuming.
    const stamp = buildAuthorActorMarker('sess-abc123');
    expect(stamp).not.toBe(''); // sanity: the fixture id actually produced a stamp
    const before = `## Summary\n\nDoes a thing.\n\n${stamp}\n`;
    const body = before + buildEscalationReasonBlock(['blast-radius (dep bump touches 12 files)']);
    const result = reconcileEscalationReasonBlock(
      body,
      ['blast-radius (dep bump touches 12 files)', 'size (602 ≥ 400 changed lines)'],
    );
    expect(result.changed).toBe(true);
    expect(result.body.startsWith(before)).toBe(true);
    expect(result.body).toContain(stamp);
  });

  it('fails safe — non-blank content after the block\'s end boundary leaves the body untouched rather than deleting it', () => {
    const block = buildEscalationReasonBlock(['blast-radius (dep bump touches 12 files)']);
    // Not a shape either writer produces today (the block is always last) — exactly the "in practice: never"
    // case the card names, which is why it must fail safe rather than assume it can locate the block.
    const body = 'PR description.' + block + 'A human added this paragraph after the block.\n';
    const result = reconcileEscalationReasonBlock(
      body,
      ['blast-radius (dep bump touches 12 files)', 'size (602 ≥ 400 changed lines)'],
    );
    expect(result).toEqual({ body, changed: false });
  });

  // ── #3044-review findings ──────────────────────────────────────────────────────────────────────────────
  // F1 (BLOCKING) — THE APPEND LOOP. The first cut located the block ONLY on `blankQuotedRegions(src)`, the
  // trusted reader, dropping the RAW-text guard both write sites used to carry. A body whose earlier content
  // blanks its own appended block then never sees its own write, so every park pass appended another copy
  // until the body hit its size cap. Review reproduced it at 1→6 blocks in five passes.
  describe('F1 — the raw write-guard, so the drain can always see its own write (bounded, never a loop)', () => {
    const REASONS = ['size (500 ≥ 400 changed lines)'];
    const countBlocks = (b) => (b.match(/## Escalation reason/g) || []).length;

    it('an unclosed fence before the block does NOT re-append — five passes stay at one block', () => {
      // The exact repro from the review. `blankQuotedRegions` blanks an unclosed fence to end-of-body BY
      // DESIGN, so the trusted reader sees nothing here — the raw guard is the only thing standing between
      // this body and an unbounded append.
      let body = '```\nunclosed fence' + buildEscalationReasonBlock(REASONS);
      expect(bodyHasEscalationReason(body)).toBe(false); // the trusted reader is blind to it, as designed
      expect(bodyAlreadyCarriesReasonBlock(body)).toBe(true); // the raw reader is not
      const first = body;
      for (let i = 0; i < 5; i += 1) {
        const pass = reconcileEscalationReasonBlock(body, REASONS);
        expect(pass.changed).toBe(false); // nothing to write — not "wrote a duplicate"
        body = pass.body;
      }
      expect(body).toBe(first); // byte-identical after five passes
      expect(countBlocks(body)).toBe(1);
    });

    it('…and does not grow even when the fresh reason set DIFFERS from the invisible block\'s', () => {
      // The nastier variant: a re-score with new reasons. Nothing can be located, so nothing may be written —
      // a replace would be a guess, and an append would be the loop.
      const body = '```\nunclosed fence' + buildEscalationReasonBlock(REASONS);
      const result = reconcileEscalationReasonBlock(body, ['blast-radius (dep bump touches 12 files)']);
      expect(result).toEqual({ body, changed: false });
    });

    it('a marker mentioned only in prose also suppresses the append (the bytes are there either way)', () => {
      const body = 'This PR was parked; see the `## Escalation reason` block on the sibling PR.';
      expect(reconcileEscalationReasonBlock(body, REASONS)).toEqual({ body, changed: false });
    });

    it('the guard is the RAW reader, and a body with NO marker bytes at all still gets its first write', () => {
      const result = reconcileEscalationReasonBlock('A plain description.', REASONS);
      expect(result.changed).toBe(true);
      expect(countBlocks(result.body)).toBe(1);
    });
  });

  // F2 — the fail-safe protects content OUTSIDE the block, not inside it. The docblock used to claim it could
  // "never delete content a human added", which is wider than the code: the block is drain-owned.
  describe('F2 — the fail-safe boundary is the block, stated exactly', () => {
    it('content OUTSIDE the block survives a replace byte-for-byte, before AND after', () => {
      const before = 'PR description.\n\nSome prose a human wrote.';
      const after = '\n## Notes\n\nA human section after the block.\n';
      const body = before + buildEscalationReasonBlock(['blast-radius (x)']) + after;
      const result = reconcileEscalationReasonBlock(body, ['blast-radius (x)', 'size (602 ≥ 400 changed lines)']);
      expect(result.changed).toBe(true);
      expect(result.body.startsWith(before)).toBe(true);
      expect(result.body.endsWith(after)).toBe(true);
    });

    it('a human bullet INSIDE the block IS replaced — drain-owned, and the docblock says so', () => {
      // Deliberate, not an oversight: a human note and a reason that no longer scores are the same shape
      // (`- text`), so treating an unrecognised bullet as malformed would freeze exactly the shrink case this
      // function exists for. Pinned so the boundary is a decision on the record, not an accident.
      const body = 'Desc.\n\n## Escalation reason\n\n- blast-radius (x)\n'
        + '- NOTE FROM A HUMAN: see the linked thread\n\n<!-- policy-set: v1 aaaaaaaaaaaa -->\n';
      const result = reconcileEscalationReasonBlock(body, ['blast-radius (x)']);
      expect(result.changed).toBe(true);
      expect(result.body).not.toContain('NOTE FROM A HUMAN');
      expect(result.body.startsWith('Desc.')).toBe(true); // …and everything outside is untouched
    });
  });

  // F3 — "cannot be located unambiguously" must include "there are two of them". The non-global `exec` used
  // to silently take the FIRST marker; the second block's own `## ` heading then terminated the region, so
  // the trailing-content guard never fired either — the first was replaced and the second left orphaned.
  describe('F3 — two real markers is ambiguous, and ambiguous is malformed', () => {
    it('back-to-back real blocks leave the body untouched', () => {
      const body = 'Desc.' + buildEscalationReasonBlock(['blast-radius (x)'])
        + buildEscalationReasonBlock(['other reason']);
      const result = reconcileEscalationReasonBlock(body, ['blast-radius (x)', 'size (602 ≥ 400 changed lines)']);
      expect(result).toEqual({ body, changed: false });
    });

    it('a second real marker anywhere later in the body is enough, even with prose between', () => {
      const body = 'Desc.' + buildEscalationReasonBlock(['blast-radius (x)'])
        + '\nA paragraph in between.\n' + buildEscalationReasonBlock(['other reason']);
      expect(reconcileEscalationReasonBlock(body, ['fresh reason'])).toEqual({ body, changed: false });
    });

    it('a FENCED second marker is not a second marker — it was already blanked, so the real one still reconciles', () => {
      const body = 'Desc.' + buildEscalationReasonBlock(['blast-radius (x)'])
        + '\n\n```\n## Escalation reason\n\n- documented example\n\n<!-- policy-set: v1 aaaaaaaaaaaa -->\n```\n';
      const result = reconcileEscalationReasonBlock(body, ['blast-radius (x)', 'size (602 ≥ 400 changed lines)']);
      expect(result.changed).toBe(true);
      expect(new Set(parsedReasonsOf(result.body)))
        .toEqual(new Set(['blast-radius (x)', 'size (602 ≥ 400 changed lines)']));
    });
  });

  // F4 — a LEGACY pre-#2567 block carries no trailing policy stamp, so it reads malformed and is frozen
  // forever. Fail-safe rather than a bug (guessing the extent of a block with no terminator is how a body
  // gets mangled), but it means the "re-derived every time" promise is void for exactly the oldest bodies.
  // That shape is real: `we:scripts/review-detail.mjs`'s parser ships a named test for it.
  it('F4 — a legacy block with NO trailing policy stamp is FROZEN, never reconciled and never corrupted', () => {
    const body = 'Desc.\n\n## Escalation reason\n\n- blast-radius (x)\n';
    expect(reconcileEscalationReasonBlock(body, ['blast-radius (x)', 'size (602 ≥ 400 changed lines)']))
      .toEqual({ body, changed: false });
  });

  // F6 — the block "is bullets only" was an assertion nothing enforced. A multi-line reason round-tripped as
  // its first line only, and the writer's own locate then called its own output malformed (line 2 is not a
  // bullet), freezing the block permanently. Not reachable from today's `scoreEscalation`, so this closes a
  // latent hole by making the guarantee real at the write.
  describe('F6 — a reason is collapsed to one line, so the bullets-only grammar is enforced not assumed', () => {
    it('a multi-line reason becomes one bullet, and its own output round-trips as clean', () => {
      const block = buildEscalationReasonBlock(['line one\nline two']);
      expect(block.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- line one line two']);
      // The block the writer just built must be one its own reader calls clean — the frozen-forever case.
      const body = 'Desc.' + block;
      expect(reconcileEscalationReasonBlock(body, ['line one\nline two']))
        .toEqual({ body, changed: false }); // recognised AND compares equal to its own source reason
    });

    it('blank lines, tabs, a fence and stray padding all collapse', () => {
      expect(buildEscalationReasonBlock(['a\n\nb']).includes('- a b')).toBe(true);
      expect(buildEscalationReasonBlock(['```\nfenced\n```']).includes('- ``` fenced ```')).toBe(true);
      expect(buildEscalationReasonBlock(['   indented reason']).includes('- indented reason')).toBe(true);
      expect(buildEscalationReasonBlock(['reason   ']).includes('- reason\n')).toBe(true);
      expect(buildEscalationReasonBlock(['   '])).toBe(''); // whitespace-only is no reason at all
    });

    it('a padded reason is the SAME reason — a re-park with it writes nothing (no rewrite-on-every-pass)', () => {
      const body = 'Desc.' + buildEscalationReasonBlock(['blast-radius (x)']);
      expect(reconcileEscalationReasonBlock(body, ['  blast-radius (x)  ']).changed).toBe(false);
    });

    // #3044-review round 2, finding 1 — `blankQuotedRegions` blanks inline code spans INSIDE a bullet too,
    // so reading the recorded reason off the quote-blanked text (not the raw body) made a backtick-bearing
    // reason compare unequal to its own round-tripped form, forever: `changed:true` on a byte-identical body
    // on every pass. Reconciling the SAME fenced reason a second time must be a no-op.
    it('a reason containing backticks compares equal to its own round-tripped form on a second reconcile', () => {
      const first = reconcileEscalationReasonBlock('Desc.', ['a `code` span']);
      expect(first.changed).toBe(true);
      const second = reconcileEscalationReasonBlock(first.body, ['a `code` span']);
      expect(second).toEqual({ body: first.body, changed: false });
    });

    it('the fenced reason this describe block already builds also round-trips as clean', () => {
      const body = 'Desc.' + buildEscalationReasonBlock(['```\nfenced\n```']);
      expect(reconcileEscalationReasonBlock(body, ['```\nfenced\n```']))
        .toEqual({ body, changed: false });
    });
  });

  // F8 — mutations that survived the whole focused suite. Each assertion below reddens exactly one.
  describe('F8 — the fail-safe DIRECTIONS, pinned individually', () => {
    it('a real marker with an unreadable tail is MALFORMED (no-op), never an append', () => {
      const body = 'Desc.\n\n## Escalation reason\n\nnot a bullet at all\n';
      expect(reconcileEscalationReasonBlock(body, ['fresh reason'])).toEqual({ body, changed: false });
      // Honest note on what this can and cannot prove. Since F1 restored the raw pre-check, flipping
      // `!blockMatch` from `{malformed:true}` to `null` is now BEHAVIOURALLY EQUIVALENT here: a located real
      // marker always implies the raw bytes, so the null path lands on the raw guard and fails safe anyway.
      // That is defence in depth, not an untested branch — but it does mean no input can distinguish them, so
      // the DIRECTION is pinned at the source instead of pretended to be pinned by a behaviour assertion.
      const lib = readFileSync(resolve(HERE, '..', 'lib', 'review-escalation.mjs'), 'utf8');
      expect(lib).toMatch(/if \(!blockMatch\) return \{ malformed: true \};/);
    });

    it('a ZERO-bullet block is malformed, not "a clean block that happens to be empty"', () => {
      // `(?:- .*\n)+` → `*` would read this as clean and replace it.
      const body = 'Desc.\n\n## Escalation reason\n\n\n<!-- policy-set: v1 aaaaaaaaaaaa -->\n';
      expect(reconcileEscalationReasonBlock(body, ['fresh reason'])).toEqual({ body, changed: false });
    });

    it('a mid-line mention of the marker is not a marker (the line-start anchor)', () => {
      // The tail here is a byte-perfect block, so dropping `(^|\n)` from `markerLineRe` makes this read as a
      // CLEAN block starting mid-sentence — and the replace then eats the words before it.
      const body = 'See ## Escalation reason\n\n- blast-radius (x)\n\n<!-- policy-set: v1 aaaaaaaaaaaa -->\n';
      const result = reconcileEscalationReasonBlock(body, ['fresh reason']);
      expect(result).toEqual({ body, changed: false });
      expect(result.body.startsWith('See ')).toBe(true);
    });

    it('the replace region STOPS at the next `##` heading — a following section survives verbatim', () => {
      // `regionEnd = scanned.length` would swallow this heading and everything under it.
      const tail = '\n## Reviewer notes\n\nKeep me.\n';
      const body = 'Desc.' + buildEscalationReasonBlock(['blast-radius (x)']) + tail;
      const result = reconcileEscalationReasonBlock(body, ['size (602 ≥ 400 changed lines)']);
      expect(result.changed).toBe(true);
      expect(result.body.endsWith(tail)).toBe(true);
      expect(result.body).toContain('Keep me.');
    });

    it('a replace never doubles the blank line that led into the block', () => {
      // Dropping the `.slice(2)` on the fresh block would leave `\n\n\n\n` before the marker.
      const body = 'Desc.' + buildEscalationReasonBlock(['blast-radius (x)']);
      const result = reconcileEscalationReasonBlock(body, ['size (602 ≥ 400 changed lines)']);
      expect(result.body).toBe('Desc.' + buildEscalationReasonBlock(['size (602 ≥ 400 changed lines)']));
      expect(result.body).not.toMatch(/\n\n\n/);
    });
  });
});

// #3044-review F7 — the two call sites had ZERO tests naming any of this, and every mutation of the inline
// `durableRecorded` branches survived the full focused suite. The decision is now a pure function, so each
// direction reddens a named test.
describe('review-escalation — #3044 decideDurableEscalationRecord (attest by effect, on the TRUSTED reader)', () => {
  const REASONS = ['size (500 ≥ 400 changed lines)'];
  const realBody = 'Desc.' + buildEscalationReasonBlock(REASONS);

  describe('the write branch attests from the VERIFIED effect, never from having tried', () => {
    it('changed + verified → true', () => {
      expect(decideDurableEscalationRecord({ changed: true, verified: true, liveBody: '', reasons: REASONS })).toBe(true);
    });
    it('changed + UNVERIFIED → false, even though a well-formed block was computed and the edit "succeeded"', () => {
      // `durableRecorded = true` here would end the pass claiming a record that a racing write may have
      // clobbered — and suppress the skip-stamp that is the only remaining trace.
      expect(decideDurableEscalationRecord({ changed: true, verified: false, liveBody: realBody, reasons: REASONS })).toBe(false);
    });
  });

  describe('the no-write branch attests from the QUOTED-REGION-AWARE reader, never the raw bytes', () => {
    it('unchanged + a real, well-formed block already present → true (the routine re-park with nothing new)', () => {
      expect(decideDurableEscalationRecord({ changed: false, verified: false, liveBody: realBody, reasons: REASONS })).toBe(true);
    });
    it('unchanged + a body with NO block → false (the malformed/fail-safe case must stay loud)', () => {
      expect(decideDurableEscalationRecord({ changed: false, verified: false, liveBody: 'Desc.', reasons: REASONS })).toBe(false);
    });
    it('unchanged + a marker that exists only inside a FENCE → false', () => {
      // `liveBody.includes('## Escalation reason')` — the raw spelling — would attest here, and that is the
      // exact GUARD-ON-RAW/ATTEST-ON-TRUSTED regression an earlier round already caught once.
      const documented = 'Docs:\n\n```\n' + buildEscalationReasonBlock(['documented example']) + '\n```\n';
      expect(bodyAlreadyCarriesReasonBlock(documented)).toBe(true); // raw says yes…
      expect(decideDurableEscalationRecord({ changed: false, verified: false, liveBody: documented, reasons: REASONS })).toBe(false); // …trusted says no
    });
    it('a DE-ESCALATED park (no reasons) records nothing here — the skip-stamp must still fire', () => {
      expect(decideDurableEscalationRecord({ changed: false, verified: false, liveBody: realBody, reasons: [] })).toBe(false);
    });
  });
});

// #3044-review F7 — the call-site WIRING, source-level (the same technique as pr-land's contract guards):
// these branches live inside `runCli`, which no unit test can reach.
describe('#3044 write-site wiring (source-level contract)', () => {
  it('pr-land edits the body ONLY when the reconcile reports a change', () => {
    const src = readFileSync(resolve(HERE, '..', 'pr-land.mjs'), 'utf8');
    expect(src).toMatch(/const reconciled = reconcileEscalationReasonBlock\(liveBody, verdict\.reasons\)/);
    expect(src).toMatch(/if \(reconciled\.changed\) forge\.editBody\(prNum, reconciled\.body\)/);
    // The old unguarded append (and its hand-rolled raw pre-check) stay gone — the guard lives in the
    // reconcile function now, so a second one here would be a fork of it.
    expect(src).not.toMatch(/liveBody \+ buildEscalationReasonBlock/);
  });
  it('merge-ai-prs attests durableRecorded through the shared pure decision, never inline branches', () => {
    const src = readFileSync(resolve(HERE, '..', 'merge-ai-prs.mjs'), 'utf8');
    expect(src).toMatch(/durableRecorded = decideDurableEscalationRecord\(\{ changed: reconciled\.changed, verified, liveBody, reasons: parkReasons \}\)/);
    // …and never re-derives it inline from either reader.
    expect(src).not.toMatch(/durableRecorded = bodyHasEscalationReason/);
    expect(src).not.toMatch(/durableRecorded = verified/);
    // The body write is still gated on the reconcile's own change decision.
    expect(src).toMatch(/if \(reconciled\.changed\) \{/);
  });
});

describe('review-escalation — #2366 hasUnclearedReviewLabel (the concurrent-lander merge refusal)', () => {
  it('refuses a PR carrying review:pending alone', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }])).toBe(true);
  });
  it('refuses a PR carrying review:human alone', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.human }])).toBe(true);
  });
  it('refuses a PR carrying review:changes alone', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.changes }])).toBe(true);
  });
  it('review:accepted clears it — and alongside a stale review:changes too (#2974)', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.accepted }])).toBe(false);
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.changes }, { name: REVIEW_LABELS.accepted }])).toBe(false);
  });
  // #x9xqexm — the two HOLD pairs no longer clear. Both are producible by NO sanctioned writer (`--to=accepted`
  // and `--to=clear-human` remove `pending` as they add `accepted`, and `--to=accepted` is refused outright on a
  // `review:human` PR), so each means "the drain re-parked a stale accept" — and since #x9xqexm the drain no
  // longer deletes the accept, this NON-SCORING predicate is the only thing that reads that state. `pending` is
  // the common one: the re-park applies it whenever the fresh score is not `humanRequired` (the PR #984 shape).
  it('…but NOT alongside review:human, and NOT alongside review:pending', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.human }, { name: REVIEW_LABELS.accepted }])).toBe(true);
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.accepted }])).toBe(true);
    // The #2423 relief valve still waives the pending pair — an operator naming ONE PR explicitly, exactly as
    // it waives a bare review:pending. It never waives the human pair.
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.accepted }], { allowPending: true })).toBe(false);
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.human }, { name: REVIEW_LABELS.accepted }], { allowPending: true })).toBe(true);
  });
  it('a PR with no review labels at all is never refused', () => {
    expect(hasUnclearedReviewLabel([])).toBe(false);
    expect(hasUnclearedReviewLabel([{ name: 'ready-to-merge' }])).toBe(false);
  });
  it('tolerant of a missing/odd labels shape (never throws)', () => {
    expect(hasUnclearedReviewLabel(null)).toBe(false);
    expect(hasUnclearedReviewLabel(undefined)).toBe(false);
  });
  it('accepts plain string labels too (not only {name} objects)', () => {
    expect(hasUnclearedReviewLabel([REVIEW_LABELS.pending])).toBe(true);
    expect(hasUnclearedReviewLabel([REVIEW_LABELS.accepted, REVIEW_LABELS.changes])).toBe(false);
    expect(hasUnclearedReviewLabel([REVIEW_LABELS.accepted, REVIEW_LABELS.pending])).toBe(true); // #x9xqexm
  });
});

describe('review-escalation — #2832 label/hold self-consistency primitives', () => {
  it('REVIEW_HOLD_LABELS is exactly the four hold labels (accepted/redteam are NOT holds)', () => {
    // PR #4631 (operator ruling a): the drain's own mechanical park, `review:held-mechanical`, is a hold too.
    expect(REVIEW_HOLD_LABELS).toEqual([REVIEW_LABELS.pending, REVIEW_LABELS.changes, REVIEW_LABELS.human, REVIEW_LABELS.heldMechanical]);
    expect(REVIEW_HOLD_LABELS).not.toContain(REVIEW_LABELS.accepted);
  });
  it('isReviewHoldLabel is true for each hold label, false for accepted/ready/anything else', () => {
    expect(isReviewHoldLabel(REVIEW_LABELS.pending)).toBe(true);
    expect(isReviewHoldLabel(REVIEW_LABELS.changes)).toBe(true);
    expect(isReviewHoldLabel(REVIEW_LABELS.human)).toBe(true);
    expect(isReviewHoldLabel(REVIEW_LABELS.accepted)).toBe(false);
    expect(isReviewHoldLabel(READY_TO_MERGE_LABEL)).toBe(false);
    expect(isReviewHoldLabel('some:other')).toBe(false);
    expect(isReviewHoldLabel(undefined)).toBe(false);
  });
  describe('readyMergeConflictsWithHold — the contradictory (held AND ready) state', () => {
    for (const hold of ['review:pending', 'review:changes', 'review:human']) {
      it(`ready-to-merge + ${hold} → CONFLICT (must be stripped)`, () => {
        expect(readyMergeConflictsWithHold([{ name: READY_TO_MERGE_LABEL }, { name: hold }])).toBe(true);
      });
      it(`${hold} WITHOUT ready-to-merge → no conflict (nothing to strip)`, () => {
        expect(readyMergeConflictsWithHold([{ name: hold }])).toBe(false);
      });
    }
    it('ready-to-merge alone (no hold) → consistent, not a conflict', () => {
      expect(readyMergeConflictsWithHold([{ name: READY_TO_MERGE_LABEL }])).toBe(false);
    });
    it('review:accepted clears a review:changes hold, so ready-to-merge alongside it is consistent (#2974)', () => {
      expect(readyMergeConflictsWithHold([{ name: READY_TO_MERGE_LABEL }, { name: REVIEW_LABELS.changes }, { name: REVIEW_LABELS.accepted }])).toBe(false);
      expect(readyMergeConflictsWithHold([{ name: READY_TO_MERGE_LABEL }, { name: REVIEW_LABELS.accepted }])).toBe(false);
    });
    it('…but accepted + pending IS contradictory since #x9xqexm — that pair is a stale re-park, not a clearance', () => {
      // It inherits directly from `hasUnclearedReviewLabel`, which is the point: ONE hold predicate, so the
      // go-ahead strip and the merge refusal can never disagree about what a label set means.
      expect(readyMergeConflictsWithHold([{ name: READY_TO_MERGE_LABEL }, { name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.accepted }])).toBe(true);
    });
    it('tolerant of a missing/odd labels shape (never throws)', () => {
      expect(readyMergeConflictsWithHold(null)).toBe(false);
      expect(readyMergeConflictsWithHold([])).toBe(false);
    });
  });
});

describe('review-escalation — #984 F2 decideParkReadyStrip (the drain park strip, keyed on OBSERVED holds)', () => {
  // THE REGRESSION THIS BLOCK EXISTS FOR. The shipped strip lived inside `if (gate.applyLabel && !DRY_RUN)`,
  // so it ran only for the two holds whose `applyLabel` decideReviewGate re-returns every pass
  // (review:pending / review:human). `review:changes` returns `wait-author` with NO applyLabel — so a PR that
  // reached `review:changes` + `ready-to-merge` stayed contradictory forever, with no sweeper (the per-pass
  // reconcile strip was deliberately dropped from #984 — see backlog `xtw8e93`). PR #984 itself was in that
  // state when the review that found this was recorded.
  it('review:changes yields NO applyLabel from decideReviewGate, yet the go-ahead is still stripped', () => {
    const labels = [REVIEW_LABELS.changes, READY_TO_MERGE_LABEL];
    const gate = decideReviewGate({ escalate: true, labels });
    // The precondition that made the applyLabel-nested strip unreachable for this hold:
    expect(gate.action).toBe('wait-author');
    expect(gate.applyLabel).toBeFalsy();
    // The OLD key, spelled out: `isReviewHoldLabel(gate.applyLabel)` is FALSE here, so the shipped strip could
    // not fire no matter how the surrounding guard was written.
    expect(isReviewHoldLabel(gate.applyLabel)).toBe(false);
    // The NEW key fires. This is the assertion that fails on the pre-hoist shape.
    expect(decideParkReadyStrip(labels, { applyLabel: gate.applyLabel })).toBe(true);
  });
  it('a review:changes PR is stripped even when the drain applies nothing at all (no applyLabel argument)', () => {
    expect(decideParkReadyStrip([REVIEW_LABELS.changes, READY_TO_MERGE_LABEL])).toBe(true);
  });

  for (const hold of REVIEW_HOLD_LABELS) {
    it(`an ALREADY-held ${hold} PR carrying the go-ahead is stripped with no applyLabel (standing reconcile)`, () => {
      expect(decideParkReadyStrip([{ name: hold }, { name: READY_TO_MERGE_LABEL }])).toBe(true);
    });
    it(`a FRESH ${hold} park (hold not yet observed) still strips — the atomic park strip survives the hoist`, () => {
      expect(decideParkReadyStrip([{ name: READY_TO_MERGE_LABEL }], { applyLabel: hold })).toBe(true);
    });
    it(`${hold} WITHOUT the go-ahead is never a strip target (nothing to remove)`, () => {
      expect(decideParkReadyStrip([{ name: hold }])).toBe(false);
      expect(decideParkReadyStrip([], { applyLabel: hold })).toBe(false);
    });
  }

  // THE HOISTING SAFETY PROPERTY the review asked to be proven: a legitimately QUEUED PR must never be
  // un-queued by the widened key.
  it('a legitimately queued PR (review:accepted + ready-to-merge) is NEVER stripped', () => {
    expect(decideParkReadyStrip([REVIEW_LABELS.accepted, READY_TO_MERGE_LABEL])).toBe(false);
    // …and it does not even reach a park branch: decideReviewGate merges it. xvzc4v4: a matching accepted/head
    // SHA — the SHA-coverage gate is a separate concern from what this test is proving.
    expect(decideReviewGate({ escalate: true, labels: [REVIEW_LABELS.accepted, READY_TO_MERGE_LABEL], acceptedSha: 'abc1234', headSha: 'abc1234' }).action).toBe('merge');
  });
  it('review:accepted clears a leftover review:changes — that accepted PR keeps its go-ahead (#2974)', () => {
    expect(decideParkReadyStrip([REVIEW_LABELS.changes, REVIEW_LABELS.accepted, READY_TO_MERGE_LABEL])).toBe(false);
  });
  it('…but a leftover review:pending next to accepted DOES strip since #x9xqexm', () => {
    // The accept no longer deletes on re-park, so `[accepted, pending]` is a live state rather than a
    // transient one — and it means the re-score found the accept stale. A held PR may not keep the go-ahead.
    expect(decideParkReadyStrip([REVIEW_LABELS.pending, REVIEW_LABELS.accepted, READY_TO_MERGE_LABEL])).toBe(true);
  });
  it('an unlabelled/clean PR carrying only the go-ahead is never stripped', () => {
    expect(decideParkReadyStrip([READY_TO_MERGE_LABEL])).toBe(false);
    expect(decideParkReadyStrip([READY_TO_MERGE_LABEL], { applyLabel: null })).toBe(false);
  });

  // #2409 / #x9xqexm — a stale-acceptance re-park must strip the go-ahead. The `staleAcceptance` input shipped
  // meaning "this same park is about to REMOVE review:accepted, so do not let it clear the hold". #x9xqexm ends
  // that removal — a re-score never deletes a human's verdict — so the option's original reason is gone and its
  // narrower one (the accept is KNOWN STALE, so it may not clear the hold being written) takes over. The
  // OUTCOME must be identical either way: `hasUnclearedReviewLabel` now refuses `accepted + pending` and
  // `accepted + human` directly, which are the only labels a stale re-park applies. That redundancy is
  // deliberate — the round-2 review flagged that a reader could delete the now-pointless filter and leave the
  // go-ahead standing on a held PR, and the fix is to make the deletion HARMLESS rather than to forbid it.
  it('a #2409 stale-acceptance re-park strips — WITH the staleAcceptance filter and, since #x9xqexm, without it', () => {
    const labels = [REVIEW_LABELS.accepted, READY_TO_MERGE_LABEL];
    for (const applyLabel of [REVIEW_LABELS.human, REVIEW_LABELS.pending]) {
      expect(decideParkReadyStrip(labels, { applyLabel, staleAcceptance: true })).toBe(true);
      expect(decideParkReadyStrip(labels, { applyLabel, staleAcceptance: false })).toBe(true);
    }
    // …and the gate really does produce that shape.
    const gate = decideReviewGate({ escalate: true, labels, acceptedSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
    expect(gate.staleAcceptance).toBe(true);
    expect(decideParkReadyStrip(labels, { applyLabel: gate.applyLabel, staleAcceptance: gate.staleAcceptance })).toBe(true);
  });

  it('accepts plain-string and {name} label shapes alike, and never throws on an odd one', () => {
    expect(decideParkReadyStrip([{ name: REVIEW_LABELS.human }, READY_TO_MERGE_LABEL])).toBe(true);
    expect(decideParkReadyStrip(null)).toBe(false);
    expect(decideParkReadyStrip(undefined, { applyLabel: REVIEW_LABELS.human })).toBe(false);
    expect(decideParkReadyStrip([null, undefined, { name: null }, READY_TO_MERGE_LABEL], { applyLabel: REVIEW_LABELS.changes })).toBe(true);
  });
});

describe('review-escalation — #2366 hasUnclearedReviewLabel { allowPending } (the --no-review-escalation operator override)', () => {
  // allowPending: true is the `--label ... --no-review-escalation` path — the operator deliberately waived the
  // rubric to land a green-but-parked review:pending PR (#2262), so review:pending no longer refuses; but the
  // human-only / reviewer-rejected gates are NEVER waivable by this flag and must still refuse (#2285).
  it('honors the operator on review:pending (no longer refused under the override)', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }], { allowPending: true })).toBe(false);
    expect(hasUnclearedReviewLabel([REVIEW_LABELS.pending], { allowPending: true })).toBe(false);
  });
  it('STILL refuses review:human under the override (gate-self is human-only, never waivable — #2285)', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.human }], { allowPending: true })).toBe(true);
  });
  it('STILL refuses review:changes under the override (reviewer rejected; author must re-push)', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.changes }], { allowPending: true })).toBe(true);
  });
  it('refuses review:human even when a stale review:pending rides alongside under the override', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.human }], { allowPending: true })).toBe(true);
  });
  it('review:accepted clears pending and a stale changes under the override (#2974: the verdict wins)', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.accepted }], { allowPending: true })).toBe(false);
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.changes }, { name: REVIEW_LABELS.accepted }], { allowPending: true })).toBe(false);
  });
  // #x9xqexm — the ONE pair that is no longer cleared. The drain stopped DELETING a stale `review:accepted` when
  // it re-parks (deleting a human's recorded clearance was never what stopped the merge), so `accepted + human`
  // is now a state this non-scoring path can actually observe — and it must fail closed on it.
  it('review:accepted does NOT clear a co-present review:human — the pair fails closed', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.human }, { name: REVIEW_LABELS.accepted }], { allowPending: true })).toBe(true);
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.human }, { name: REVIEW_LABELS.accepted }])).toBe(true);
  });
  it('default (allowPending omitted / false) is the bare-sweep behaviour — review:pending still refuses', () => {
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }])).toBe(true);
    expect(hasUnclearedReviewLabel([{ name: REVIEW_LABELS.pending }], { allowPending: false })).toBe(true);
  });
});

// ── #3343 — the basis a verdict is scored on can be the PR's own file set (merge-base or ancestry) or the
//    un-narrowed base TIP, which may name files only UPSTREAM touched. Those two used to be byte-identical at
//    this gate. They are the input to the ONE-WAY half of the rubric: statute / declarative-leash force
//    `review:human`, `decideSetLabel` then refuses `accepted` on that PR, and only the human ceremony clears
//    it. So the scorer is told which basis it got. ────────────────────────────────────────────────────────
describe('scoreEscalation — an un-narrowed basis is visible, and never relaxes the gate (#3343)', () => {
  const statute = ['docs/agent/platform-decisions.md'];

  it('an un-narrowed basis is REPORTED — `signals.basisUntrusted` plus a reason — instead of being indistinguishable from a narrowed one', () => {
    const v = scoreEscalation({ changedFiles: ['backlog/a.md'], humanBasisFiles: ['backlog/a.md'], basisNarrowed: false });
    expect(v.basisUntrusted).toBe(true);
    expect(v.signals.basisUntrusted).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('basis un-narrowed'))).toBe(true);
  });

  it('NEGATIVE DIRECTION — an un-narrowed basis does NOT suppress the statute gate: a real statute edit still earns review:human', () => {
    const v = scoreEscalation({ changedFiles: statute, humanBasisFiles: statute, basisNarrowed: false });
    expect(v.humanRequired).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('statute ('))).toBe(true);
    expect(v.careLevel).toBe('high');
  });

  it('NEGATIVE DIRECTION — nor does it suppress the declarative-leash (gate-self) half of the gate', () => {
    const leash = ['scripts/lib/gate-config.mjs'];
    const v = scoreEscalation({ changedFiles: leash, humanBasisFiles: leash, basisNarrowed: false });
    expect(v.humanRequired).toBe(true);
  });

  it('the default is TRUSTED — a caller that supplies no `basisNarrowed` scores exactly as before, with no extra reason and no `basisUntrusted`', () => {
    const before = scoreEscalation({ changedFiles: statute, humanBasisFiles: statute });
    expect(before.basisUntrusted).toBe(false);
    expect(before.signals.basisUntrusted).toBeUndefined();
    expect(before.reasons.some((r) => r.startsWith('basis un-narrowed'))).toBe(false);
    expect(before).toEqual(scoreEscalation({ changedFiles: statute, humanBasisFiles: statute, basisNarrowed: true }));
  });

  it('an EMPTY basis is never flagged — there is no verdict to qualify, so an unscored PR gains no reason', () => {
    const v = scoreEscalation({ changedFiles: [], humanBasisFiles: [], basisNarrowed: false });
    expect(v.basisUntrusted).toBe(false);
    expect(v.escalate).toBe(false);
    expect(v.reasons).toEqual([]);
  });
});
