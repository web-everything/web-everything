/** Concluded head reviews must not stay busy because their process lingers. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/conveyor/review-status-tag.mjs';

export default {
  id: 'concluded-review-lingering-process',
  title: 'accepted and red-team-clear review with a lingering pid clears reviewing',
  card: 'soak-declaration: PRs 7099/7092/7105 lingering review processes',
  fixedBy: { sha: 'HEAD', where: 'review-status-tag.mjs', paths: [PATH] },
  // Behaviour-decided: run/judge must pass even if the implementation is reverted.
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { tagReviewStatus } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
    const { CONFIRMED_BREAKS_DEFAULTS, parseRedTeamComment, redTeamResultId } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/red-team-gate.mjs')).href);
    const violations = [];
    const check = (ok, name) => {
      if (!ok) violations.push(name);
      log?.(`${name}: ${ok ? 'pass' : 'FAIL'}`);
    };
    const accepted = ['review:accepted', 'red-team:clear'];
    const headRefOid = 'a'.repeat(40);
    const now = Date.now();
    const advisory = { author: { login: 'chalbert' }, createdAt: new Date(now - 180_000).toISOString(),
      body: `<!-- we:red-team-advisory pr=7099 rev=${headRefOid} -->\n\nRed team not required on this head: not owed (stored review)` };
    const gate = { author: advisory.author,
      body: `<!-- we:red-team-gate pr=7099 rev=${headRefOid} outcome=no-send-back result=${redTeamResultId(parseRedTeamComment(advisory.body))} -->` };
    const comments = [gate, advisory];
    const newer = { ...advisory, createdAt: new Date(now - 150_000).toISOString(),
      body: `${advisory.body.split('\n')[0]}\n1. [not confirmed] (edge-case, degraded) \`scripts/x.mjs:1\` — newer result\nAdvisory only: red team · recorded verdict \`accept\`.` };
    const olderGate = { ...gate, body: gate.body.replace('outcome=no-send-back',
      'outcome=card-queued') };
    const broken = { ...newer, body: newer.body.replace('[not confirmed]', '[**confirmed**]')
      .replace('degraded', 'broken').replace('`accept`', '`changes`') };
    const carried = { ...broken, body: `<!-- review-verdict-carried from=${'b'.repeat(40)} to=${headRefOid} patch-id=${'c'.repeat(40)} -->\nReview verdict carried across an identical contribution.\n${broken.body}` };
    const degraded = { ...broken, body: broken.body.replace('broken', 'degraded') };
    const card = { ...gate, body: `<!-- we:red-team-gate pr=7099 rev=${headRefOid} outcome=card-queued result=${redTeamResultId(parseRedTeamComment(degraded.body))} -->` };
    for (const [verdict, expectedReview, expectedStatus, prFields = {}, agentFields = {}, standalone = false, readSeal = () => null, recordFields = {}] of [
      [accepted, null, 'ready-to-merge'],
      [accepted, 'reviewing', 'red-team', { commentsComplete: undefined }],
      [accepted, 'reviewing', 'red-team', { commentsComplete: false }],
      [accepted, 'review-stalled', 'red-team', {}, { state: 'blocked' }],
      [accepted, 'reviewing', 'red-team', {}, {}, false, () => null, null],
      [accepted, 'reviewing', 'red-team', {}, {}, false, () => null, 'unreadable'],
      [accepted, null, 'ready-to-merge', {}, {}, false, () => null,
        { status: 'started', endedAt: null, run: null, heartbeatAt: new Date(now - 300_000).toISOString(), timeoutMs: 120_000 }],
      [accepted, 'reviewing', 'red-team', {}, {}, false, () => null,
        { status: 'started', endedAt: null, run: null, heartbeatAt: new Date(now - 60_000).toISOString(), timeoutMs: 120_000 }],
      [accepted, 'reviewing', 'red-team', {}, {}, false, () => ({ unreadable: true })],
      [accepted, 'reviewing', 'red-team', {}, {}, false, () => { throw new Error('sealed evidence unavailable'); }],
      [accepted, 'reviewing', 'red-team', { comments: [broken] }],
      [accepted, 'reviewing', 'red-team', { comments: [...comments, carried] }],
      [accepted, null, 'ready-to-merge', { comments: [degraded, card] }],
      [accepted, 'reviewing', 'red-team', { comments: [degraded] }],
      [accepted, 'reviewing', 'red-team', {}, {}, true],
      [accepted, 'reviewing', 'red-team', { comments: [newer, olderGate, advisory] }],
      [accepted, 'reviewing', 'red-team', { comments: [...comments,
        { ...advisory, createdAt: newer.createdAt, body: advisory.body.split('\n')[0] }] }],
      [accepted, null, 'ready-to-merge', { comments: [
        { ...gate, body: gate.body.replace('outcome=no-send-back', 'outcome=card-queued') }, advisory] }],
      [accepted, null, 'ready-to-merge', { comments: [advisory] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, body: advisory.body.split('\n')[0] }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, body: `quoted\n${advisory.body}` }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, body: advisory.body.replace('pr=7099', 'pr=7105') }] }],
      ...['sent-back', 'round-cap', 'unknown', 'clear'].map(outcome => [accepted, 'reviewing', 'red-team',
        { comments: [...comments, { ...gate, body: gate.body.replace('outcome=no-send-back', `outcome=${outcome}`) }] }]),
      [accepted, 'reviewing', 'red-team', {}, { startedAt: now - 150_000 }],
      [accepted, 'reviewing', 'red-team', {}, { startedAt: undefined, updatedAt: now - 600_000 }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, createdAt: undefined }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, createdAt: new Date(now - 60_000).toISOString() }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, author: { login: 'stranger' } }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, body: advisory.body.replace(headRefOid, 'b'.repeat(40)) }] }],
      [accepted, 'reviewing', 'red-team', { headRefOid: 'b'.repeat(40) }],
      [accepted, 'reviewing', 'red-team', { headRefOid: undefined }],
      [accepted, 'reviewing', 'red-team', { comments: undefined }],
      [accepted, 'reviewing', 'red-team', {}, { startedAt: undefined }],
      [accepted, 'review-stalled', 'red-team', { comments: [] }, { state: 'blocked' }],
      [accepted, 'review-stalled', 'red-team', {}, { state: 'blocked', startedAt: undefined }],
      [['review:accepted'], 'reviewing', 'red-team'],
      [[...accepted, 'review:pending'], 'reviewing', 'red-team'],
      [[...accepted, 'review:human'], 'reviewing', 'red-team'],
      [['review:pending'], 'reviewing', 'awaiting-review'],
      [['review:human'], 'reviewing', 'awaiting-review'],
    ]) {
      let labels = [...verdict, `review-status:${agentFields.state === 'blocked' ? 'review-stalled' : 'reviewing'}`, 'status:awaiting-review'];
      const provider = {
        readLabels: () => labels.map(name => ({ name })), ensureLabel: () => {},
        setLabels: (_repo, _pr, { add, remove }) => {
          labels = labels.filter(name => !remove.includes(name));
          if (add && !labels.includes(add)) labels.push(add);
        },
      };
      const snapshot = { number: 7099, state: 'OPEN', isDraft: false, baseRefName: 'main',
        headRefOid, mergeable: 'MERGEABLE', comments, commentsComplete: true,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...prFields };
      provider.readPrState = () => snapshot;
      const result = tagReviewStatus({ pr: 7099, repo: 'we', provider,
        agents: [{ name: 'review-7099', state: 'working', pid: 7099,
          startedAt: now - 600_000, ...agentFields }],
        ...(standalone ? {} : { prState: snapshot }),
        readConfirmedBreaks: () => ({ value: { ...CONFIRMED_BREAKS_DEFAULTS, findingClasses: {} } }),
        readSealedStatus: readSeal,
        readReviewRecord: () => {
          if (recordFields === 'unreadable') throw Error('review record unreadable');
          return recordFields === null ? null : { session: 'review-7099', pid: 7099,
            startedAt: new Date(now - 600_000).toISOString(), status: 'done',
            endedAt: new Date(now - 180_000).toISOString(),
            run: { op: 'review-pr', pending: null, findings: { read: { netBasis: { rev: headRefOid } }, confirm: 'accept' },
              verdict: { verdict: 'accept' }, stepTimings: [{ step: 'record', finishedAt: new Date(now - 180_000).toISOString() }] },
            ...recordFields };
        },
        readFixClaim: () => null, planRows: [], requiredChecks: ['test'],
        prStatusSettings: { acceptedRedTeamStatus: 'red-team' }, signalFix: () => {},
      });
      const name = `${verdict.join(',')} head=${prFields.headRefOid ?? headRefOid} evidence=${JSON.stringify([prFields, agentFields])}`;
      check(result.label === (expectedReview ? `review-status:${expectedReview}` : null), `${name}: review result`);
      check(JSON.stringify(labels.filter(label => label.startsWith('review-status:')))
        === JSON.stringify(expectedReview ? [`review-status:${expectedReview}`] : []), `${name}: review labels`);
      check(result.prStatus === `status:${expectedStatus}`, `${name}: status result`);
      check(JSON.stringify(labels.filter(label => label.startsWith('status:')))
        === JSON.stringify([`status:${expectedStatus}`]), `${name}: status labels`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
