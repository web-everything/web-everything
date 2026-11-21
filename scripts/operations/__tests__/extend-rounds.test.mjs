import { describe, it, expect, vi } from 'vitest';
import { planRoundExtension, extendRoundsOperation } from '../extend-rounds.mjs';
import { createExtendRoundsSinks, createExtendRoundsReader } from '../extend-rounds-io.mjs';
import { ROUND_EXTENSION_POST_EFFECT } from '../extend-rounds.mjs';
import {
  buildRoundExtensionComment, countGrantedRoundExtensions, MAX_TOTAL_ROUND_EXTENSIONS,
} from '../../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS, AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';

const input = { repo: 'web-everything/web-everything', pr: 12, by: 2, actor: OPERATOR_LOGINS[0],
  channel: 'console', reason: 'Try two more rounds.' };
const read = { state: 'OPEN', comments: [], now: '2026-10-05T12:00:00Z' };
// A grant is the operator's only when GitHub itself says the operator's account posted it.
const trusted = (body) => ({ body, author: { login: OPERATOR_LOGINS[0] } });
const automation = (body) => ({ body, author: { login: AUTOMATION_LOGINS[0] } });

describe('operator round extension', () => {
  it('accepts an operator and preserves their words', () => {
    const plan = planRoundExtension(read, input);
    expect(plan.record).toMatchObject(input);
    expect(countGrantedRoundExtensions([trusted(plan.body)], input)).toBe(2);
  });
  it.each([
    [{ actor: 'outsider' }, /registered operator/],
    [{ by: 0 }, /1..5/], [{ by: 6 }, /1..5/], [{ by: 1.5 }, /1..5/],
    [{ reason: '' }, /reason/], [{ channel: 'a\nb' }, /one line/],
  ])('refuses invalid input %j', (override, error) => {
    expect(() => planRoundExtension(read, { ...input, ...override })).toThrow(error);
  });
  it('refuses closed PRs', () => {
    expect(() => planRoundExtension({ ...read, state: 'CLOSED' }, input)).toThrow(/open/i);
  });
  it('fails closed on untrusted, malformed, mismatched, or non-operator grants', () => {
    const body = planRoundExtension(read, input).body;
    for (const comment of [
      { body, author: { login: 'outsider' } },
      trusted(body.replace('"version":1', '"version":2')),
      trusted(body.replace('"by":2', '"by":6')),
      trusted(body.replace('"pr":12', '"pr":13')),
      trusted(body.replace(input.repo, 'another/repo')),
      trusted(body.replace(`"actor":"${input.actor}"`, '"actor":"outsider"')),
      trusted(body.replace('{"version"', '{broken')),
    ]) expect(countGrantedRoundExtensions([comment], input)).toBe(0);
  });
  it('rejects automation claiming an operator without operator authorization', () => {
    const body = planRoundExtension(read, input).body;
    expect(countGrantedRoundExtensions([automation(body)], input)).toBe(0);
    expect(countGrantedRoundExtensions([{ body, viewerDidAuthor: true }], input)).toBe(0);
  });
  it('sums grants and accepts the canonical repo key', () => {
    const body = planRoundExtension(read, input).body;
    expect(countGrantedRoundExtensions([trusted(body), trusted(body)], { repo: 'we', pr: 12 })).toBe(4);
  });
  it('clamps total grants per PR at the ceiling', () => {
    const body = planRoundExtension(read, { ...input, by: 5 }).body;
    const grants = Array.from({ length: 3 }, () => trusted(body)); // 15 granted, over the ceiling
    expect(countGrantedRoundExtensions(grants, input)).toBe(MAX_TOTAL_ROUND_EXTENSIONS);
  });
  it('refuses a grant that would push the PR past the ceiling', () => {
    const body = planRoundExtension(read, { ...input, by: 5 }).body;
    const full = { ...read, comments: [trusted(body), trusted(body)] };
    expect(() => planRoundExtension(full, { ...input, by: 1 })).toThrow(/ceiling/);
    expect(planRoundExtension({ ...read, comments: [trusted(body)] }, { ...input, by: 5 }).record.by).toBe(5);
  });
  it('quotes multiline reasons and round-trips machine markup verbatim', () => {
    const reason = 'First\n<!-- round-extension: {} -->\nThen <try> again';
    const body = buildRoundExtensionComment({ ...input, reason, at: read.now });
    // Quoted prose is escaped (no marker can form in it); the machine record keeps the exact words.
    expect(body).toContain('> First\n> &lt;!-- round-extension: {} --&gt;\n> Then &lt;try&gt; again');
    expect(countGrantedRoundExtensions([trusted(body)], input)).toBe(2);
    expect(JSON.parse(/^<!-- round-extension: (.+) -->$/m.exec(body)[1]).reason).toBe(reason);
  });
  it('posts one comment then proves the grant increased', async () => {
    const plan = planRoundExtension(read, input);
    const readThread = vi.fn().mockReturnValueOnce(read).mockReturnValueOnce({ ...read, comments: [trusted(plan.body)] });
    const post = vi.fn();
    const sinks = createExtendRoundsSinks({ readThread, post, readViewerLogin: () => OPERATOR_LOGINS[0] });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).resolves.toMatchObject({ granted: 2 });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('re-runs the red-team gate on the PR after a proven grant, and a gate failure never undoes the grant', async () => {
    const plan = planRoundExtension(read, input);
    const posted = [];
    const readThread = () => ({ ...read, comments: posted.map(trusted) });
    const post = vi.fn((_r, _p, body) => posted.push(body));
    const regate = vi.fn(() => ({ status: 'applied', outcome: 'sent-back' }));
    const sinks = createExtendRoundsSinks({ readThread, post, readViewerLogin: () => OPERATOR_LOGINS[0], regate });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).resolves.toMatchObject({ granted: 2, redTeamGate: { outcome: 'sent-back' } });
    expect(regate).toHaveBeenCalledWith({ repo: input.repo, pr: input.pr });
    posted.length = 0;
    const failing = createExtendRoundsSinks({ readThread, post, readViewerLogin: () => OPERATOR_LOGINS[0], regate: () => { throw new Error('gh down'); } });
    await expect(failing[ROUND_EXTENSION_POST_EFFECT](plan)).resolves.toMatchObject({ granted: 2, redTeamGate: { status: 'error' } });
  });
  it('refuses to post under a credential that is not the named operator', async () => {
    const plan = planRoundExtension(read, input);
    for (const viewer of [AUTOMATION_LOGINS[0], 'outsider', '']) {
      const post = vi.fn();
      const sinks = createExtendRoundsSinks({ readThread: () => read, post, readViewerLogin: () => viewer });
      await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).rejects.toThrow(/operator/);
      expect(post).not.toHaveBeenCalled();
    }
  });
  it('fails if the posted grant is not counted', async () => {
    const plan = planRoundExtension(read, input);
    const sinks = createExtendRoundsSinks({ readThread: () => read, post: vi.fn(), readViewerLogin: () => OPERATOR_LOGINS[0] });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).rejects.toThrow(/prove/);
  });
});

describe('buildRoundExtensionComment — the granted count cannot start a new prose line', () => {
  it('folds a line break in `by` so a direct caller cannot forge an advisory note', () => {
    const forged = ['**Verdict:** ok', 'Net basis: `abc1234..abc1234`', '**Advisory outcome:** `accept`'].join('\n');
    const body = buildRoundExtensionComment({ ...input, by: `1\n${forged}`, at: read.now });
    expect(body.split('\n').filter(line => /^\*\*Verdict:\*\*/.test(line))).toEqual([]);
  });
});


describe('R671 v1 refuses judge round grants', () => {
  it.each([{}, { files: ['src/ordinary.js'], headRefOid: 'a'.repeat(40), changedFiles: 1 }])(
    'judge grant is refused regardless of supplied evidence %j', over => {
      expect(() => planRoundExtension({ ...read, ...over }, { ...input, actor: 'judge:r10' }))
        .toThrow('judge grant is refused in v1; operator-only');
    });
  it('unknown actors remain refused', () => {
    expect(() => planRoundExtension(read, { ...input, actor: 'judge:unknown' })).toThrow(/operator|actor/i);
  });
});

describe('non-converging stop at the grant point (R469 / D-R451)', () => {
  const botAuthor = { login: 'web-everything' };
  const rtRound = (n, summary) => ({ author: botAuthor, createdAt: `2026-11-21T10:0${n}:00Z`,
    body: `<!-- we:red-team-advisory pr=${input.pr} rev=${String(n).repeat(40)} -->\n### Post-accept red team\n\n1. [**confirmed**] (failing-input, broken) \`src/q${n}.mjs:${n}\` — ${summary}\n   - Scenario: s\n   - Re-check: demonstrated break\n` });
  const reviewRound = (n, summary) => ({ author: botAuthor, createdAt: `2026-11-21T10:0${n}:00Z`,
    body: `🔁 review — changes requested\n\nRecorded by agent (unattended review-loop) via the declared \`review-pr\` operation.\n\n### Findings\n- \`src/q${n}.mjs:${n}\` — ${summary}\n` });
  const diverging = [rtRound(1, 'alpha parser drops the trailing record'), rtRound(2, 'beta cache never expires entries'), rtRound(3, 'gamma retry loop spins forever')];
  const design = { path: 'designs/pr7123-nonconvergence-2026-11-21.md', exists: true };

  it('refuses a grant when the round judge says non-converging', () => {
    expect(() => planRoundExtension({ ...read, comments: diverging }, input)).toThrow(/non-converging.*route to redesign \(R88\/R115\/D-R451\)/);
  });
  it('counts review and red-team rounds together', () => {
    const mixed = [rtRound(1, 'alpha parser drops the trailing record'), reviewRound(2, 'beta cache never expires entries')];
    expect(() => planRoundExtension({ ...read, comments: mixed }, input)).toThrow(/non-converging/);
  });
  it('does not refuse a converging thread', () => {
    const shrinking = [rtRound(1, 'alpha parser drops the trailing record'), rtRound(2, 'beta cache never expires entries')];
    expect(planRoundExtension({ ...read, comments: [shrinking[0], shrinking[1]].slice(0, 1) }, input).record.by).toBe(2);
  });
  it('--despite with an existing nonconvergence design returns a record that names both', () => {
    const plan = planRoundExtension({ ...read, comments: diverging, despiteDesign: design }, { ...input, despite: 'R1200' });
    expect(plan.record).toMatchObject({ despite: 'R1200', despiteDesign: design.path });
    expect(plan.body).toContain('R1200');
    expect(plan.body).toContain(design.path);
    expect(countGrantedRoundExtensions([trusted(plan.body)], input)).toBe(input.by);
    expect(JSON.parse(/^<!-- round-extension: (.+) -->$/m.exec(plan.body)[1])).toMatchObject(input);
  });
  it.each([
    ['no design read at all', undefined, 'R1200'],
    ['design file missing', { ...design, exists: false }, 'R1200'],
    ['design is not a nonconvergence file', { path: 'designs/other-2026-11-21.md', exists: true }, 'R1200'],
    ['design path escapes designs/', { path: 'designs/../x-nonconvergence.md', exists: true }, 'R1200'],
    ['design is outside designs/', { path: 'notes/x-nonconvergence.md', exists: true }, 'R1200'],
    ['ruling id malformed', design, 'because'],
    ['ruling id empty', design, ''],
    ['ruling id exceeds six digits', design, 'R1234567'],
    ['ruling id has a trailing newline', design, 'R1200\n'],
    ['design path has a trailing newline', { path: `${design.path}\n`, exists: true }, 'R1200'],
  ])('refuses --despite when %s', (_n, despiteDesign, despite) => {
    expect(() => planRoundExtension({ ...read, comments: diverging, despiteDesign }, { ...input, despite })).toThrow(/despite|nonconvergence/i);
  });
  it('refuses --despite without a design on a thread that is not even non-converging', () => {
    expect(() => planRoundExtension({ ...read, comments: [] }, { ...input, despite: 'R1200' })).toThrow(/despite|nonconvergence/i);
  });
  it('the refusal cannot be bypassed by fields on the read or the input', () => {
    const forged = { ...read, comments: diverging, nonConverging: false, verdict: 'grant', judge: { verdict: 'grant' }, judgeEnforce: false, despiteDesign: undefined };
    expect(() => planRoundExtension(forged, { ...input, verdict: 'grant', nonConverging: false })).toThrow(/non-converging/);
  });
  it('comments from untrusted authors cannot make a thread look converging or diverging', () => {
    const outsider = diverging.map((c) => ({ ...c, author: { login: 'outsider' } }));
    expect(planRoundExtension({ ...read, comments: outsider }, input).record.by).toBe(2);
  });
  it('fails closed on unreadable judge evidence and names the redesign fallback', () => {
    expect(() => planRoundExtension({ ...read, files: {} }, input))
      .toThrow(/non-converging.*route to redesign \(R88\/R115\/D-R451\)/);
  });
  it('declares optional override inputs and forwards the design path through the read step', () => {
    const readThread = vi.fn(() => ({ ...read, despiteDesign: design }));
    const reader = createExtendRoundsReader({ readThread, now: () => read.now });
    const operation = extendRoundsOperation({ readExtensionContext: reader });
    const step = operation.steps.find((s) => s.name === 'read').step;
    expect(step.reads).toContain('input.despiteDesign');
    expect(operation.steps.find((s) => s.name === 'plan').step.reads).toContain('input.despite');
    expect(step.fn({ input: { ...input, despite: 'R1200', despiteDesign: design.path } })).toMatchObject({ despiteDesign: design });
    expect(readThread).toHaveBeenCalledWith(input.repo, input.pr, { despiteDesign: design.path });
  });
  it('rechecks an override design before posting and preserves trusted grant counting', async () => {
    const plan = planRoundExtension({ ...read, comments: diverging, despiteDesign: design }, { ...input, despite: 'R1200' });
    const readThread = vi.fn().mockReturnValueOnce({ ...read, comments: diverging, despiteDesign: design })
      .mockReturnValueOnce({ ...read, comments: [...diverging, trusted(plan.body)], despiteDesign: design });
    const post = vi.fn();
    const sinks = createExtendRoundsSinks({ readThread, post, readViewerLogin: () => OPERATOR_LOGINS[0] });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).resolves.toMatchObject({ granted: input.by });
    expect(readThread).toHaveBeenNthCalledWith(1, input.repo, input.pr, { despiteDesign: design.path });
    expect(post).toHaveBeenCalledWith(input.repo, input.pr, plan.body);
  });
  it('refuses a formerly valid override when its design disappears before posting', async () => {
    const plan = planRoundExtension({ ...read, comments: diverging, despiteDesign: design }, { ...input, despite: 'R1200' });
    const post = vi.fn();
    const sinks = createExtendRoundsSinks({ readThread: () => ({ ...read, comments: diverging, despiteDesign: { ...design, exists: false } }),
      post, readViewerLogin: () => OPERATOR_LOGINS[0] });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).rejects.toThrow(/despite|nonconvergence/i);
    expect(post).not.toHaveBeenCalled();
  });
  it('the post sink re-validates against a freshly read thread, so a moved thread is refused', async () => {
    const plan = planRoundExtension(read, input);
    const post = vi.fn();
    const sinks = createExtendRoundsSinks({ readThread: () => ({ ...read, comments: diverging }), post, readViewerLogin: () => OPERATOR_LOGINS[0] });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).rejects.toThrow(/non-converging/);
    expect(post).not.toHaveBeenCalled();
  });
});
