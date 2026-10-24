// @vitest-environment node
/** PR digest declaration, selector and fail-closed lifecycle evidence tests. */
import { describe, expect, it, vi } from 'vitest';
import { renderPrDigest, prDigestOperation, PR_DIGEST_EFFECT } from '../pr-digest.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, validateReferralRecord, validateOperatorRuling } from '../../lib/jury-core.mjs';
import { parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';

describe('pr-digest', () => {
  it('rejects missing, conflicting and invalid PR selectors before reading GitHub', async () => {
    const reader = vi.fn();
    const declaration = prDigestOperation();
    const registry = createRegistry(); registry.register(declaration);
    for (const input of [{}, { pr: 42, all: true }, { pr: -1 }, { pr: 1.5 }]) {
      expect(() => declaration.steps[0].step.fn({ input })).toThrow('supply exactly one');
    }
    for (const argv of [[], ['--pr=42', '--all'], ['--pr=-1'], ['--pr=1.5']]) {
      const outcome = await runOperationCli({ declaration, argv, registry, store: createMemoryRunStore(),
        sinks: { [PR_DIGEST_EFFECT]: reader }, newRunId: () => 'invalid-digest' });
      expect(outcome.code).not.toBe(0);
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it('declares CLI flags for single PR, --all and path overrides', () => {
    const declaration = prDigestOperation();
    const parsed = parseOperationArgv(declaration, ['--pr=42', '--out-dir=digests', '--ledger=ledger', '--daemon-log=daemon']);
    expect(parsed.ok).toBe(true); expect(parsed.input.pr).toBe(42);
    expect(parseOperationArgv(declaration, ['--all']).input.all).toBe(true);
  });
});

const head = 'a'.repeat(40), repo = 'web-everything/web-everything';
const pr = { number: 42, title: 'Digest', body: '', headRefOid: head, labels: [] };
const render = (comments, extra = {}) => renderPrDigest({ pr, repo, comments: comments.map(c => ({ author: { login: 'chalbert' }, trusted: true, ...c })), lastComment: 1, validateRuling: (r, referral, body) => referral ? validateReferralRecord(r) : validateOperatorRuling(r) && buildOperatorRulingComment(r) === body?.replace(/\r\n/g, '\n').trimEnd(), ...extra });
const original = { file: 'x', line: 1, summary: 'claim', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const key = referralFindingKey('judge', original);
const referralFor = runId => ({ body: `Mandatory review owner: judge\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify({
  version: 1, repo, pr: 42, head, runId, reviewer: mandatoryReferralReviewer(runId), authorBody: '', attempted: true,
  referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }], rulings: [],
}))} -->` });
const referral = referralFor('review');
const operator = (patch = {}) => ({ version: 1, repo, pr: 42, head, actor: 'chalbert', channel: 'test', reason: 'verified',
  at: '2026-10-23T10:00:00Z', clearerId: '', rulings: [{ runId: 'review', key, result: 'not-real' }], ...patch });
const encoded = record => ({ body: validateOperatorRuling(record) ? buildOperatorRulingComment(record) : `Operator ruling\n<!-- mandatory-referral-operator-ruling-v1: ${Buffer.from(JSON.stringify(record)).toString('base64')} -->` });

describe('fail-closed digest evidence', () => {
  it('shows a current-head block ruling as a blocker', () => {
    expect(render([encoded(operator({ rulings: [{ runId: 'review', key, result: 'block' }] }))])).toContain('Blocked on: blocking ruling');
  });
  it.each([undefined, ''])('refuses structured clearance when the repo option is absent or empty (%s)', repo => {
    const text = render([referral, encoded(operator())], { repo });
    expect(text).toContain('incomplete; inspect GitHub thread');
    expect(text).toContain('Blocked on: referrals need a ruling');
  });
  it('clears a referral only with a valid bound ruling', () => {
    expect(render([referral, encoded(operator())])).toContain('Blocked on: nothing detected');
  });
  it.each([
    ['unknown result', { rulings: [{ runId: 'review', key, result: 'accepted' }] }],
    ['missing result', { rulings: [{ runId: 'review', key }] }],
    ['wrong repo', { repo: 'other/repo' }], ['wrong PR', { pr: 43 }], ['missing repo', { repo: undefined }],
    ['null record', null],
  ])('refuses %s structured rulings', (_name, patch) => {
    const text = render([referral, encoded(patch === null ? null : operator(patch))]);
    expect(text).toContain('Blocked on: referrals need a ruling');
  });
  it.each([null, {}, { key }, { key, result: 'unknown' }])('refuses malformed visible JSON ruling %j', ruling => {
    expect(render([referral, { body: `Operator ruling\nHead: ${head}\nRulings: ${JSON.stringify([ruling])}` }])).toContain('Blocked on: referrals need a ruling');
  });
  it('keeps an older-head block informational', () => {
    expect(render([encoded(operator({ head: 'b'.repeat(40), rulings: [{ runId: 'review', key, result: 'block' }] }))])).toContain('Blocked on: nothing detected');
  });
  it.each([
    { rulings: [{ key, result: 'unknown' }] }, { rulings: [{ key }] }, { repo: 'other/repo' }, { pr: 43 },
  ])('refuses invalid URI-encoded referral rulings %j', patch => {
    const record = operator(patch);
    const body = `<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify(record))} -->`;
    expect(render([referral, { body }])).toContain('Blocked on: referrals need a ruling');
  });
  it.each(['mandatory-referrals-v1', 'mandatory-referral-operator-ruling-v1'])('refuses a truncated %s marker without visible prose', marker => {
    for (const suffix of ['', ': %7B']) {
      const text = render([{ body: `<!-- ${marker}${suffix}` }]);
      expect(text).toContain('incomplete; inspect GitHub thread');
      expect(text).toContain('Blocked on: referrals need a ruling');
    }
  });
  it.each(['worker evidence is missing', 'The worker said "fix-end"', 're-armed for re-review', '🔓 conveyor fix-end — fix claim released'])('does not clear a send-back from incidental prose: %s', body => {
    const text = render([{ id: 10, body: '## review — changes requested' }, { body }]);
    expect(text).toContain('evidence: missing');
    expect(text).toContain('Blocked on: open send-back without evidence');
  });
  it('counts only a later trusted marker naming this send-back as posted evidence', () => {
    const change = { id: 10, body: '## review — changes requested' };
    const evidence = { body: '<!-- addresses-operator-send-back: 10 -->' };
    expect(render([change, evidence])).toContain('evidence: posted');
    expect(render([change, { body: `## Fix evidence\n${evidence.body}` }])).toContain('evidence: posted');
    expect(render([change, { ...evidence, trusted: false }])).toContain('evidence: missing');
    expect(render([change, { body: '<!-- addresses-operator-send-back: 11 -->' }])).toContain('evidence: missing');
    expect(render([evidence, change])).toContain('evidence: missing');
    expect(render([change, { body: `Quoted:\n${evidence.body}` }])).toContain('evidence: missing');
  });
});

describe('second audit regressions', () => {
  it.each(['not-real', 'card', 'block'])('keeps visible %s rulings informational and never clears referrals', result => {
    const text = render([referral, { body: `Operator ruling\nHead: ${head}\nRulings: ${JSON.stringify([{ runId: 'review', key, result }])}` }]);
    expect(text).toContain(`${result}=1`);
    expect(text).toContain('informational only');
    expect(text).toContain('Blocked on: referrals need a ruling');
  });
  it('does not clear the same finding in a different review run on the same head', () => {
    const comments = [referralFor('A'), referralFor('B'), encoded(operator({ rulings: [{ runId: 'A', key, result: 'not-real' }] }))];
    expect(render(comments)).toContain('Blocked on: referrals need a ruling');
    expect(render([...comments, encoded(operator({ rulings: [{ runId: 'B', key, result: 'not-real' }] }))])).toContain('Blocked on: nothing detected');
  });
  it('uses each operator ruling runId even when its envelope carries another runId', () => {
    expect(render([referralFor('B'), encoded(operator({ runId: 'B', rulings: [{ runId: 'A', key, result: 'not-real' }] }))]))
      .toContain('Blocked on: referrals need a ruling');
  });
  it.each([head, head.slice(0, 7), head.toUpperCase()])('rejects evidence on the send-back head %s', evidenceHead => {
    const change = { id: 10, body: `## review — changes requested\non head \`${head}\`` };
    const evidence = h => ({ body: `## Fix evidence\nHead: \`${h}\`\n<!-- addresses-operator-send-back: 10 -->` });
    expect(render([change, evidence(evidenceHead)])).toContain('Blocked on: open send-back without evidence');
    expect(render([change, evidence('b'.repeat(40))])).toContain('evidence: posted');
    expect(render([change, { body: '<!-- addresses-operator-send-back: 10 -->' }])).toContain('evidence: missing');
  });
});

it('refuses structured clearance when no shared validator is supplied', () => {
  expect(renderPrDigest({ pr, repo, comments: [referral, encoded(operator())].map(c => ({ author: { login: 'chalbert' }, ...c, trusted: true })), lastComment: 1 }))
    .toContain('Blocked on: referrals need a ruling');
});

it('ignores incidental head prose and hidden head text when checking send-back evidence', () => {
  const change = { id: 10, body: `## review — changes requested\non head \`${head}\`` };
  for (const suffix of [`\nabout head ${'b'.repeat(40)}`, `\n<!-- Head: \`${'b'.repeat(40)}\` -->`]) {
    expect(render([change, { body: '<!-- addresses-operator-send-back: 10 -->' + suffix }]))
      .toContain('Blocked on: open send-back without evidence');
  }
});
it('uses the observed live head when named send-back evidence omits its head', () => {
  const text = renderPrDigest({ repo, pr: { ...pr, headRefOid: 'b'.repeat(40) }, lastComment: 11,
    comments: [{ id: 10, author: { login: 'chalbert' }, trusted: true, body: `## review — changes requested\non head \`${head}\`` },
      { author: { login: 'chalbert' }, trusted: true, body: '<!-- addresses-operator-send-back: 10 -->' }] });
  expect(text).toContain('evidence: posted');
});

describe('current ruling transitions', () => {
  const block = encoded(operator({ rulings: [{ runId: 'review', key, result: 'block' }] }));
  it.each(['not-real', 'card'])('later same-head ruling replaces an earlier block', result => {
    const correction = encoded(operator({ rulings: [{ runId: 'review', key, result,
      ...(result === 'card' ? { card: 'we:backlog/123-digest-fixture.md' } : {}) }] }));
    const text = render([referral, block, correction]);
    expect(text).toContain('block=1'); // Retain historical observations in the visible digest.
    expect(text).toContain('Blocked on: nothing detected');
    expect(render([referral, correction, block])).toContain('Blocked on: blocking ruling');
  });
  it.each([
    { head: 'b'.repeat(40) },
    { rulings: [{ runId: 'other-run', key, result: 'not-real' }] },
    { rulings: [{ runId: 'review', key: 'other-finding', result: 'not-real' }] },
    { repo: 'other/repo' },
    { pr: 43 },
    { rulings: [{ runId: 'review', key, result: 'card' }] },
  ])('keeps a block when the later correction has different or incomplete binding: %j', patch => {
    expect(render([referral, block, encoded(operator(patch))])).toContain('Blocked on: blocking ruling');
  });
  it('keeps a block when its later correction is visible prose or untrusted', () => {
    const visible = { body: `Operator ruling\nHead: ${head}\nRulings: ${JSON.stringify([{ runId: 'review', key, result: 'not-real' }])}` };
    for (const correction of [visible, { ...encoded(operator()), trusted: false }]) {
      expect(render([referral, block, correction])).toContain('Blocked on: blocking ruling');
    }
  });
});


describe('third audit canonical evidence', () => {
  const block = encoded(operator({ rulings: [{ runId: 'review', key, result: 'block' }] }));
  it.each([
    ['quoted', body => `> ${body.replaceAll('\n', '\n> ')}`],
    ['fenced', body => `\`\`\`markdown\n${body}\n\`\`\``],
    ['appended note', body => `${body}\nEdited by hand`],
    ['edited visible text', body => body.replace('verified', 'unverified')],
    ['marker only', body => body.split('\n').at(-1)],
  ])('refuses %s operator clearance and retains the current block', (_name, edit) => {
    expect(render([referral, block, { body: edit(encoded(operator()).body) }]))
      .toContain('Blocked on: blocking ruling');
  });
  it.each([
    body => `> ${body.replaceAll('\n', '\n> ')}`,
    body => `${body}\nAppended note`,
    body => `\`\`\`\n${body}\n\`\`\``,
  ])('refuses referral records outside a final-line trailer', edit => {
    const text = render([{ body: edit(referral.body) }]);
    expect(text).toContain('incomplete; inspect GitHub thread');
    expect(text).toContain('Blocked on: referrals need a ruling');
  });
  it.each(['', '## Fix evidence\n', `## Fix evidence\nHead: \`${'b'.repeat(40)}\`\n`])('resolves every addressed send-back in one evidence comment (%s)', prefix => {
    const text = render([{ id: 10, body: '## review — changes requested' },
      { id: 11, body: '## review — changes requested' },
      { body: `${prefix}<!-- addresses-operator-send-back: 10 -->\n<!-- addresses-operator-send-back: 11 -->` }]);
    expect(text.match(/evidence: posted/g)).toHaveLength(2);
    expect(text).toContain('Blocked on: nothing detected');
  });
});

it('accepts a reviewer clearance only in a final-line referral trailer', () => {
  const record = JSON.parse(decodeURIComponent(referral.body.match(/mandatory-referrals-v1: (\S+) -->/)[1]));
  record.rulings = [{ id: 'clear', key, reviewerId: record.reviewer.id, lens: record.reviewer.lens,
    result: 'not-real', rationale: 'verified', evidence: ['x:1'] }];
  expect(validateReferralRecord(record)).toBe(true);
  const body = `Mandatory review owner: judge\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify(record))} -->`;
  const block = encoded(operator({ rulings: [{ runId: 'review', key, result: 'block' }] }));
  expect(render([referral, block, { body }])).toContain('Blocked on: nothing detected');
  for (const edited of [`${body}\nAdded note`, `> ${body.replaceAll('\n', '\n> ')}`, `\`\`\`\n${body}\n\`\`\``]) {
    expect(render([referral, block, { body: edited }])).toContain('Blocked on: blocking ruling');
  }
});
it.each([['four-space', '    '], ['tab', '\t']])('refuses %s-indented reviewer clearance and retains the block', (_name, indent) => {
  const record = JSON.parse(decodeURIComponent(referral.body.match(/mandatory-referrals-v1: (\S+) -->/)[1]));
  record.rulings = [{ id: 'clear', key, reviewerId: record.reviewer.id, lens: record.reviewer.lens,
    result: 'not-real', rationale: 'verified', evidence: ['x:1'] }];
  expect(validateReferralRecord(record)).toBe(true);
  const trailer = `<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify(record))} -->`;
  const body = `Mandatory review owner: judge\n${trailer}`;
  const block = encoded(operator({ rulings: [{ runId: 'review', key, result: 'block' }] }));
  for (const example of [body.split('\n').map(line => indent + line).join('\n'), `Mandatory review owner: judge\n${indent}${trailer}`]) {
    const text = render([referral, block, { body: example }]);
    expect(text).toContain('Blocked on: blocking ruling');
    expect(text).toContain('incomplete; inspect GitHub thread');
    expect(text).not.toContain('Blocked on: nothing detected');
  }
});
it.each([
  ['backtick', '```', '```'],
  ['tilde', '~~~', '~~~'],
  ['backtick with language', '```markdown', '```'],
  ['indented tilde', '   ~~~text', '~~~'],
  ['long backtick', '````', '````'],
])('refuses reviewer clearance inside an unterminated %s fence and retains the block', (_name, opener, closer) => {
  const record = JSON.parse(decodeURIComponent(referral.body.match(/mandatory-referrals-v1: (\S+) -->/)[1]));
  record.rulings = [{ id: 'clear', key, reviewerId: record.reviewer.id, lens: record.reviewer.lens,
    result: 'not-real', rationale: 'verified', evidence: ['x:1'] }];
  expect(validateReferralRecord(record)).toBe(true);
  const body = `Mandatory review owner: judge\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify(record))} -->`;
  const block = encoded(operator({ rulings: [{ runId: 'review', key, result: 'block' }] }));
  const otherFence = closer[0] === '`' ? '~~~' : '```';
  for (const ending of ['', `\n${otherFence}`, `\n${closer.slice(0, -1)}`, `\n${closer} still code`]) {
    // A different fence character, a short run, or trailing prose cannot close this fence.
    const example = `${opener}\nExample${ending}\n${body}`;
    for (const text of [example, example.replaceAll('\n', '\r\n')]) {
      const digest = render([referral, block, { body: text }]);
      expect(digest).toContain('Blocked on: blocking ruling');
      expect(digest).toContain('incomplete; inspect GitHub thread');
      expect(digest).not.toContain('Blocked on: nothing detected');
    }
  }
  expect(render([referral, block, { body: `${opener}\nExample\n${closer}\n${body}` }]))
    .toContain('Blocked on: nothing detected');
});
it('accepts canonical operator rendering with CRLF and trailing whitespace', () => {
  const body = encoded(operator()).body.replaceAll('\n', '\r\n') + '\r\n  ';
  expect(render([referral, { body }])).toContain('Blocked on: nothing detected');
});
it.each(['> <!-- addresses-operator-send-back: 11 -->', '\`\`\`\n<!-- addresses-operator-send-back: 11 -->\n\`\`\`',
  'Quoted example:\n<!-- addresses-operator-send-back: 11 -->'])('does not treat a later example as another addressed send-back (%s)', example => {
  const text = render([{ id: 10, body: '## review — changes requested' }, { id: 11, body: '## review — changes requested' },
    { body: `## Fix evidence\n<!-- addresses-operator-send-back: 10 -->\n${example}` }]);
  expect(text.match(/evidence: posted/g)).toHaveLength(1);
  expect(text).toContain('Blocked on: open send-back without evidence');
});

it('rejects a forged trust flag on an outsider clearance at the renderer boundary', () => {
  const block = encoded(operator({ rulings: [{ runId: 'review', key, result: 'block' }] }));
  expect(render([referral, block, { ...encoded(operator()), trusted: true, author: { login: 'outsider' } }]))
    .toContain('Blocked on: blocking ruling');
});
