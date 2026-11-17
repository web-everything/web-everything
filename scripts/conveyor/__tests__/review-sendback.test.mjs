import { describe, it, expect, vi } from 'vitest';
import { planSendBacks, renderFindingsBody } from '../review-sendback.mjs';
import { runSendBackTick, resolveSendBackPolicy } from '../review-sendback-io.mjs';
import { readFileSync } from 'node:fs';
const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
const ref = (seat, summary = 'Broken case!', file = 'a.js', line = 4) => ({
  key: JSON.stringify([seat, file, line, summary]), finding: { summary, file, line } });
const pr = { number: 7, headRefOid: head, state: 'OPEN', labels: ['review:pending'] };
const entry = { kind: 'fix', mode: 'block-ruled-referral', prNumber: 7, blockRuledReferrals: [ref('correctness')] };
const plan = { repo, dispatch: [entry] };
const pick = (p = pr, e = entry, sentLedger = {}) => planSendBacks({ plan: { repo, dispatch: [e] }, prs: [p], sentLedger });
function fixture(extra = {}) {
  let disk = { sent: {}, escalated: {} };
  const o = { repo, plan, prs: [pr], agents: [], enabled: true,
    readLedger: () => structuredClone(disk), saveLedger: v => { disk = structuredClone(v); },
    readLive: vi.fn(() => pr), execute: vi.fn(), publish: vi.fn(), log: vi.fn(), ...extra };
  return { o, tick: () => runSendBackTick(o) };
}
describe('review send-back', () => {
  it('picks the block-ruled fix entry and renders findings', () => {
    expect(pick()).toEqual([expect.objectContaining({ repo, prNumber: 7, headSha: head, key: `${repo}#7@${head}` })]);
  });
  it.each(['review:changes', 'review:human'])('skips %s even alongside pending', label => {
    expect(pick({ ...pr, labels: ['review:pending', label] })).toEqual([]);
    expect(pick({ ...pr, labels: [label] })).toEqual([]);
  });
  it.each([{ kind: 'review' }, { mode: 'takeover' }, { mode: 'ordinary' }])('skips other dispatch modes %j', patch => {
    expect(pick(pr, { ...entry, ...patch })).toEqual([]);
  });
  it('deduplicates identical normalized text across seats but keeps distinct findings at one location', () => {
    const body = renderFindingsBody([ref('a'), ref('b', 'BROKEN   case.', 'b.js', 8), ref('c', 'other', 'b.js', 8)]);
    expect(body.match(/^- /gm)).toHaveLength(2);
    expect(body).toContain('seats: a, b');
    expect(body).toContain('other');
  });
  it('is idempotent per head and sends again on a new head', () => {
    const { o, tick } = fixture(); tick(); tick();
    expect(o.execute).toHaveBeenCalledTimes(1);
    o.prs = [{ ...pr, headRefOid: 'b'.repeat(40) }]; o.readLive.mockReturnValue(o.prs[0]); tick();
    expect(o.execute).toHaveBeenCalledTimes(2);
  });
  it('uses sanctioned review-set-label argv with a nonempty body file and bounded output', () => {
    const { o, tick } = fixture();
    o.execute.mockImplementation((node, argv, opts) => {
      expect(node).toBe(process.execPath);
      expect(argv).toEqual(['scripts/review-set-label.mjs', '7', '--to=changes', `--repo=${repo}`, expect.stringMatching(/^--body-file=/), `--expect-head=${head}`]);
      expect(readFileSync(argv[4].slice(12), 'utf8')).toContain('Broken case!');
      expect(opts.maxBuffer).toBe(1024 * 1024);
    }); tick(); expect(o.execute).toHaveBeenCalledTimes(1); expect(o.log).not.toHaveBeenCalled();
  });
  it.each([null, { ...pr, headRefOid: 'b'.repeat(40) }, { ...pr, labels: ['review:human'] }, { ...pr, labels: undefined }])('fails closed on changed or incomplete live state %j', live => {
    const { o, tick } = fixture({ readLive: () => live }); tick(); expect(o.execute).not.toHaveBeenCalled();
  });
  it('logs failed reads and sends and retries without recording', () => {
    const { o, tick } = fixture(); o.readLive.mockImplementationOnce(() => { throw new Error('unreadable'); });
    tick(); o.execute.mockImplementationOnce(() => { throw new Error('send failed'); }); tick(); tick(); tick();
    expect(o.execute).toHaveBeenCalledTimes(2); expect(o.log).toHaveBeenCalledTimes(2);
  });
  it('fails closed with an operator fallback on a corrupt ledger', () => {
    const { o, tick } = fixture({ readLedger: () => ({}) }); tick();
    expect(o.execute).not.toHaveBeenCalled(); expect(o.publish).not.toHaveBeenCalled();
    expect(o.log).toHaveBeenCalledWith(expect.stringContaining('inspect manually'));
  });
  it('rejects empty findings and incomplete agent evidence', () => {
    expect(() => renderFindingsBody([])).toThrow('no blocking findings');
    const { o, tick } = fixture({ agents: null }); tick(); expect(o.execute).not.toHaveBeenCalled();
  });
  it.each(['read', 'send'])('bounds oversized batches and reports remaining work despite persistent %s failures', failure => {
    const prs = Array.from({ length: 20 }, (_, i) => ({ ...pr, number: i + 1 }));
    const readLive = vi.fn((_, n) => {
      if (failure === 'read' && n <= 16) throw new Error('persistent read failure');
      return prs.find(p => p.number === n);
    });
    const execute = vi.fn((_, argv) => {
      if (Number(argv[1]) <= 16) throw new Error('persistent send failure');
    });
    const { o, tick } = fixture({ prs, plan: { dispatch: prs.map(p => ({ ...entry, prNumber: p.number })) }, readLive, execute });
    tick();
    expect(readLive.mock.calls.map(([, n]) => n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(execute).toHaveBeenCalledTimes(failure === 'read' ? 0 : 16);
    expect(o.log).toHaveBeenCalledWith(expect.stringContaining('budget exhausted'));
    // Receipts-only historical state migrates, and even failed actions persist traversal progress.
    expect(o.readLedger().cursors[repo]).toBe(16);
    expect(o.readLedger().sent).toEqual({});
    readLive.mockClear(); execute.mockClear();
    // The next invocation reloads the durable ledger; discovery order may change between ticks.
    o.prs = [...prs].reverse();
    tick();
    expect(readLive.mock.calls[0]).toEqual([repo, 17]);
    expect(readLive).toHaveBeenCalledTimes(16);
    expect(execute).toHaveBeenCalledWith(process.execPath,
      expect.arrayContaining(['17']), expect.any(Object));
    expect(o.readLedger().sent[`${repo}#17@${head}`]).toBe(true);
  });
  it('fails closed with an operator fallback on a corrupt traversal cursor', () => {
    const { o, tick } = fixture({ readLedger: () => ({ sent: {}, escalated: {}, cursors: { [repo]: 'bad' } }) });
    tick(); expect(o.readLive).not.toHaveBeenCalled(); expect(o.execute).not.toHaveBeenCalled();
    expect(o.log).toHaveBeenCalledWith(expect.stringContaining('traversal cursor unreadable'));
  });
  it('keeps traversal progress separate for each repository and resumes after a removed PR', () => {
    const otherRepo = 'frontier-ui/frontierui';
    let disk = { sent: {}, escalated: {}, cursors: { [repo]: 16, [otherRepo]: 5 } };
    const prs = [18, 1, 17].map(number => ({ ...pr, number }));
    const { o, tick } = fixture({ prs, plan: { dispatch: prs.map(p => ({ ...entry, prNumber: p.number })) },
      readLedger: () => structuredClone(disk), saveLedger: v => { disk = structuredClone(v); },
      readLive: vi.fn(() => { throw new Error('unreadable'); }) });
    tick(); expect(o.readLive.mock.calls.map(([, n]) => n)).toEqual([17, 18, 1]);
    expect(disk.cursors[otherRepo]).toBe(5);
  });
  it('honors the policy kill switch and logs source', () => {
    const log = vi.fn();
    expect(resolveSendBackPolicy({ env: { WE_REVIEW_SEND_BACK_BLOCK_RULED: '0' }, tool: {}, log })).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('source: env'));
    const { o, tick } = fixture({ enabled: false }); tick(); expect(o.execute).not.toHaveBeenCalled();
  });
  it('escalates stood-down once per head with no live agent, even if send-back is disabled', () => {
    const stood = { ...pr, labels: ['review-status:stood-down'] };
    const { o, tick } = fixture({ prs: [stood], readLive: () => stood, enabled: false }); tick(); tick();
    expect(o.publish).toHaveBeenCalledTimes(1);
    expect(o.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stood-down', pr: 7, repo, head }));
    const next = { ...stood, headRefOid: 'b'.repeat(40) }; o.prs = [next]; o.readLive = () => next; tick();
    expect(o.publish).toHaveBeenCalledTimes(2);
  });
  it('does not escalate a live agent or an unreadable live label', () => {
    const stood = { ...pr, labels: ['review-status:stood-down'] };
    const { o, tick } = fixture({ prs: [stood], agents: [{ laneHeadOid: head, state: 'working', pidAlive: true }] });
    tick(); expect(o.publish).not.toHaveBeenCalled();
    o.agents = []; o.readLive = () => ({ ...stood, labels: null }); tick(); expect(o.publish).not.toHaveBeenCalled();
  });
  it('retries a failed attention publication', () => {
    const stood = { ...pr, labels: ['review-status:stood-down'] };
    const { o, tick } = fixture({ prs: [stood], readLive: () => stood });
    o.publish.mockImplementationOnce(() => { throw new Error('feed failed'); }); tick(); tick(); tick();
    expect(o.publish).toHaveBeenCalledTimes(2);
  });
});
