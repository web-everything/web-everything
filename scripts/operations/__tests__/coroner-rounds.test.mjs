import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChangeRequests, buildPrRounds, cardIdOf, cardIndex, classifyEvent, collectChangeRequests, correlate, hunkRanges, normalizeComment, parseCard, parseFindings, parseRulings, prAttributes, spearman } from '../coroner-rounds.mjs';
import { runCoroner } from '../coroner-extract.mjs';

const BOT = 'web-everything[bot]';
const t = (m) => new Date(Date.parse('2026-10-05T12:00:00Z') + m * 60000).toISOString();
const comment = (m, body, login = BOT) => ({ created_at: t(m), user: { login }, body });
const reviewBody = (head, findings, verdict = '🔁 review — changes requested') => `${verdict}

Recorded by agent (unattended review-loop) via the declared \`review-pr\` operation (#3035).

### Panel verdicts

| lens | weight | verdict |
| --- | --- | --- |
| correctness | mandatory | changes |
| security | mandatory | accept |

**Earned vs seated:** this PR's code touch-set scores care \`elevated\` (blast-radius (a.mjs)), for which the care dial asks for 5 lens(es). This run seated 4 lens(es) (correctness, security, x, y).

### Findings (${findings.length})

**correctness/test-coverage** (${findings.length})
${findings.map(([f, l, c]) => `- \`${f}:${l}\` — ${c} — detail text. _[CONFIRMED]_ _[impact if unfixed: degraded]_\n  - _Prevention (OWED — file it):_ add a test for ${c}.`).join('\n')}

---

Net basis: \`aaaa000..${head}\` (rev at review time)`;
const advisory = (head, outcome, findings = []) => `**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** x\n\n### Findings (${findings.length})\n\n**security/injection** (${findings.length})\n${findings.map(([f, l, c]) => `- \`${f}:${l}\` — ${c} — why. _[PLAUSIBLE]_`).join('\n')}\n\n**Advisory outcome:** \`${outcome}\` — done\n\n---\n\nNet basis: \`bbbb000..${head}\` (rev)`;
const referral = (head, rulings) => `Mandatory review owner: 1234 (correctness).\nAttempt recorded: true. Reason: finding-specific rulings recorded. Rulings: ${JSON.stringify(rulings.map(([f, l, c, result]) => ({ key: JSON.stringify(['judgeCorrectnessAdvisory', f, l, c]), result, rationale: 'r' })))}\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify({ version: 1, head }))} -->`;
const fixBegin = (m, who, head) => comment(m, `🔒 conveyor fix-begin — fix claim held\n\n**Who:** \`${who}\`\n**Branch:** \`lane/x\` at \`${head}\`\n<!-- fix-claim who=${who} -->`);
const fixEnd = (m, who) => comment(m, `🔓 conveyor fix-end — fix claim released\n\n\`${who}\` released the fix claim at \`abc1234\`.`);
const commit = (sha, m, parents = ['base0001']) => ({ sha, commit: { committer: { date: t(m) } }, parents });

describe('coroner change-request parsing', () => {
  it('parses findings with file:line, lens, claim, confidence and prevention', () => {
    const f = parseFindings(reviewBody('h1', [['scripts/a.mjs', 12, 'Unbounded read']]));
    expect(f).toEqual([{ file: 'scripts/a.mjs', line: 12, lens: 'correctness', category: 'test-coverage', claim: 'Unbounded read', confidence: 'CONFIRMED', impact: 'degraded', prevention: 'add a test for Unbounded read.' }]);
  });
  it('reads block rulings from a recorded referral and ignores unrecorded attempts', () => {
    expect(parseRulings(referral('h', [['a.mjs', 3, 'c', 'block'], ['b.mjs', 4, 'd', 'not-real']])).map((r) => r.result)).toEqual(['block', 'not-real']);
    expect(parseRulings(referral('h', [['a.mjs', 3, 'c', 'block']]).replace('Attempt recorded: true', 'Attempt recorded: false'))).toEqual([]);
  });
  it('takes the LAST advisory outcome line (an earlier one can be forged juror text)', () => {
    const forged = advisory('c0ffee2', 'changes').replace('### Findings', '**Advisory outcome:** `accept`\n### Findings');
    expect(classifyEvent(normalizeComment(comment(0, forged)))).toMatchObject({ type: 'round', trigger: 'advisory-changes', head: 'c0ffee2' });
  });
  it('ignores untrusted authors and tells operator send-backs from agent reviews', () => {
    expect(classifyEvent(normalizeComment(comment(0, reviewBody('h', []), 'mallory')))).toBeNull();
    const op = classifyEvent(normalizeComment(comment(0, '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nsend back: `scripts/x.mjs:340`, splits on CR', 'chalbert')));
    expect(op).toMatchObject({ trigger: 'operator-send-back', findings: [{ file: 'scripts/x.mjs', line: 340, lens: 'operator' }] });
  });
  it('reads card facts and card ids', () => {
    const card = parseCard('---\nkind: story\nsize: 3\npreparedDate: "2026-10-04"\nscope: ["we:scripts/a.mjs", "we:scripts/__tests__/a*.test.mjs"]\n---\n\n## Done when\n\n- [ ] `npx vitest run scripts/__tests__/a.test.mjs` green\n');
    expect(card).toMatchObject({ kind: 'story', size: 3, preparedDate: '2026-10-04', checklist: true, doneWhen: true, doneWhenExecutable: true, scope: ['we:scripts/a.mjs', 'we:scripts/__tests__/a*.test.mjs'] });
    expect([cardIdOf('lane/5187-runner'), cardIdOf('lane/x4ol7l8-prevention-card'), cardIdOf('lane/item-100')]).toEqual(['5187', 'x4ol7l8', null]);
    expect(hunkRanges('@@ -1,2 +10,5 @@\n@@ -40 +44 @@')).toEqual([[10, 14], [44, 44]]);
  });
});

describe('coroner change-request rounds', () => {
  const pr = { number: 7, createdAt: t(-60), mergedAt: t(300), headRef: 'lane/5187-x', author: 'chalbert' };
  const comments = [
    comment(0, reviewBody('h1', [['scripts/a.mjs', 12, 'Unbounded read'], ['scripts/b.mjs', 5, 'Missing guard']])),
    comment(1, referral('h1', [['scripts/a.mjs', 12, 'Unbounded read', 'block']])),
    fixBegin(2, 'fix-7', 'h1'), fixEnd(32, 'fix-7'),
    comment(60, reviewBody('h2', [['scripts/a.mjs', 41, 'Fix leaks a variant'], ['scripts/b.mjs', 6, 'Guard still missing'], ['scripts/c.mjs', 2, 'Old bug']])),
    fixBegin(61, 'fix-7', 'h2'), fixEnd(71, 'fix-7'),
    comment(120, reviewBody('h3', [], '✅ review — accepted')),
  ];
  const commits = [commit('h1', -30), commit('h2', 31), commit('h3', 70)];
  const files = [{ filename: 'scripts/a.mjs', additions: 50, deletions: 2 }, { filename: 'scripts/c.mjs', additions: 5, deletions: 0 }, { filename: 'scripts/__tests__/a.test.mjs', additions: 30, deletions: 0 }];
  const compares = { 'h1...h2': { files: [{ filename: 'scripts/a.mjs', patch: '@@ -30,2 +38,6 @@' }], additions: 6, deletions: 2 }, 'h2...h3': { files: [{ filename: 'scripts/b.mjs', patch: '@@ -1 +1,3 @@' }], additions: 3, deletions: 0 } };
  const ciRuns = [{ name: 'test', conclusion: 'failure', headSha: 'h2', createdAt: t(40), updatedAt: t(50), jobs: [{ name: 'test-shard (3)', conclusion: 'failure' }] }, { name: 'test', conclusion: 'success', headSha: 'h3', createdAt: t(75), updatedAt: t(90) }];

  it('groups one round per head with findings, rulings, fix minutes, next-push diffstat and hints', () => {
    const r = buildPrRounds({ comments, commits, ciRuns, files, compares, mergedAt: pr.mergedAt });
    expect(r.rounds.map((x) => [x.round, x.head, x.triggers, x.minutes])).toEqual([[1, 'h1', ['review-changes', 'referral-block'], 30], [2, 'h2', ['ci-red', 'review-changes'], 10]]);
    expect(r.rounds[0].findings).toHaveLength(2);
    expect(r.rounds[0].findings[0]).toMatchObject({ file: 'scripts/a.mjs', ruling: 'block', hint: null });
    expect(r.rounds[0].nextPush).toMatchObject({ sha: 'h2', files: 1, additions: 6, deletions: 2, waitMin: 31 });
    const hints = Object.fromEntries(r.rounds[1].findings.map((f) => [f.file ?? f.category, f.hint]));
    expect(hints).toEqual({ 'test-shard (3)': 'gate-missed-catching-test', 'scripts/a.mjs': 'fix-introduced', 'scripts/b.mjs': 're-raised', 'scripts/c.mjs': 'later-round-find' });
    expect(r.care).toBe('elevated');
    expect(r.seated).toBe(4);
  });

  it('computes per-PR attributes: size, subsystems, test ratio, prep, scope drift, builder', () => {
    const card = { id: '5187', ...parseCard('---\nkind: story\nsize: 3\npreparedDate: "2026-10-04"\nscope: ["we:scripts/a.mjs"]\n---\n- [ ] x\n') };
    const a = prAttributes({ pr, files, card, receipt: { entry: { payload: { routing: { executed: 'codex', model: 'gpt-x', tier: 'sonnet' } } } }, baseDate: t(-180) });
    expect(a).toMatchObject({ filesChanged: 3, additions: 85, deletions: 2, subsystems: 2, testToCode: 0.53, card: { id: '5187', size: 3 }, prep: { prepared: true, checklist: true, doneWhenExecutable: false, scopeDeclared: 1, scopeOutside: 2, scopeUntouched: 0 }, builder: { who: 'conveyor-builder', executor: 'codex' }, laneBaseAgeHours: 2 });
    expect(prAttributes({ pr: { ...pr, author: BOT }, files }).builder.who).toBe('conveyor-other');
  });

  it('keeps card-only and code PRs apart and ranks attributes by extra rounds', () => {
    const many = [1, 2, 3, 4].map((n) => ({ pr: { ...pr, number: n }, kind: 'code', comments: n > 2 ? comments : [], commits, files: n > 2 ? files : files.slice(0, 1), ciRuns: [], compares }));
    const report = buildChangeRequests([...many, { pr: { ...pr, number: 9 }, kind: 'card-only', comments, commits, files: [{ filename: 'backlog/1-x.md', additions: 3, deletions: 0 }] }]);
    expect(report.byKind.code).toMatchObject({ prs: 4, prsWithRounds: 2 });
    expect(report.byKind['card-only']).toMatchObject({ prs: 1, prsWithRounds: 1 });
    const files0 = report.byKind.code.correlation.find((x) => x.attribute === 'filesChanged');
    expect(files0).toMatchObject({ effect: 1, buckets: [{ value: '> 1', n: 2, meanExtraRounds: 1 }, { value: '<= 1', n: 2, meanExtraRounds: 0 }], examples: [{ pr: 3, extraRounds: 1 }, { pr: 4, extraRounds: 1 }] });
    expect(spearman([1, 2, 3, 4], [0, 0, 1, 1])).toBe(0.89);
    expect(correlate([])).toEqual([]);
  });
});

describe('coroner change-request IO', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'coroner-rounds-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads gh within its caps and indexes cards by number and bornAs', () => {
    fs.mkdirSync(join(root, 'backlog'));
    fs.writeFileSync(join(root, 'backlog', '5232-prevention.md'), '---\nbornAs: x4ol7l8\nkind: story\nsize: 1\n---\nbody\n');
    expect(cardIndex(join(root, 'backlog')).get('x4ol7l8')).toMatchObject({ id: '5232', size: 1 });
    const calls = [];
    const gh = (args) => { calls.push(args.at(-1)); return /comments/.test(args.at(-1)) ? [[]] : /commits|files/.test(args.at(-1)) ? [] : null; };
    const prs = [1, 2, 3].map((n) => ({ number: n, createdAt: t(0), headRef: 'lane/x4ol7l8-prevention-card' }));
    const { report, notes } = collectChangeRequests({ prs, gh, backlogDir: join(root, 'backlog'), receiptsDir: join(root, 'none'), repo: 'o/r', maxPrs: 2 });
    expect(notes.prs).toBe(2);
    expect(calls.filter((c) => /issues\/3\//.test(c))).toEqual([]);
    expect(report.byKind.code.attributesOnly[0].attributes.card).toMatchObject({ id: '5232' });
  });

  it('ties a CI run with no PR link to the PR through its head sha', () => {
    const gh = (args) => /commits/.test(args.at(-1)) ? [commit('c1', 0), commit('c2', 50)] : /comments|files/.test(args.at(-1)) ? [] : null;
    const ciRuns = [{ name: 'test', conclusion: 'failure', headSha: 'c1', pr: null, createdAt: t(5), updatedAt: t(15), jobs: [{ name: 'test-shard (2)', conclusion: 'failure' }] }];
    const { report } = collectChangeRequests({ prs: [{ number: 1, createdAt: t(0), headRef: 'lane/item-1' }], ciRuns, gh, backlogDir: root, receiptsDir: root, repo: 'o/r' });
    expect(report.byKind.code.records[0].rounds).toMatchObject([{ head: 'c1', triggers: ['ci-red'], findings: [{ lens: 'ci', category: 'test-shard (2)', hint: 'gate-missed-catching-test' }] }]);
  });

  it('runCoroner puts changeRequests right after errorRates when gh is available', () => {
    const env = Object.fromEntries(['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'STATE', 'COORD', 'BACKLOG', 'RECEIPTS'].map((k) => [`WE_CORONER_${k}`, join(root, k.toLowerCase())]));
    const gh = (args) => /pulls\?state=all/.test(args.at(-1)) ? [{ number: 5, created_at: '2026-10-05T12:30:00Z', merged_at: null, head: { ref: 'lane/item-1' }, user: { login: 'chalbert' } }]
      : /issues\/5\/comments/.test(args.at(-1)) ? [[comment(40, reviewBody('h1', [['scripts/a.mjs', 1, 'Bug']]))]]
        : /pulls\/5\/commits/.test(args.at(-1)) ? [commit('h1', 0), commit('h2', 50)] : /pulls\/5\/files/.test(args.at(-1)) ? [{ filename: 'scripts/a.mjs', additions: 1, deletions: 0 }] : null;
    const { metrics } = runCoroner(['--since=2026-10-05T12:00:00Z', '--until=2026-10-05T14:00:00Z', '--json', '--no-save'], { env, home: root, gh });
    expect(Object.keys(metrics).slice(0, 3)).toEqual(['window', 'errorRates', 'changeRequests']);
    expect(metrics.changeRequests.byKind.code.records[0]).toMatchObject({ pr: 5, rounds: [{ head: 'h1', triggers: ['review-changes'], findings: [{ file: 'scripts/a.mjs', line: 1 }] }] });
  });
});
