import { describe, it, expect, vi } from 'vitest';
import { runReviewLabelCli } from '../review-set-label.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
const head = 'a'.repeat(40), moved = 'b'.repeat(40);

describe('pinned changes checks every durable write', () => {
  it.each(['ledger', 'comment', 'label'])('refuses head movement before %s', step => {
    let liveHead = head;
    const writes = [];
    const stateProvider = {
      readPrState: () => ({ headRefOid: liveHead, labels: [], comments: [], state: 'OPEN', body: '' }),
      readLabels: () => [],
      postComment: () => { writes.push('comment'); if (step === 'label') liveHead = moved; },
      setLabels: () => writes.push('label'),
    };
    let reads = 0;
    const read = stateProvider.readPrState;
    stateProvider.readPrState = () => { if (++reads === 2 && step === 'ledger') liveHead = moved; return read(); };
    const provider = createGhProvider({ exec: (argv) => {
      if (argv[0] === 'pr' && argv[1] === 'view') return JSON.stringify(stateProvider.readPrState());
      if (argv[0] === 'pr' && argv[1] === 'comment') { stateProvider.postComment(); return ''; }
      if (argv[0] === 'pr' && argv[1] === 'edit') { stateProvider.setLabels(); return ''; }
      throw new Error(`unexpected fake gh argv: ${JSON.stringify(argv)}`);
    } });
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
    try {
      expect(() => runReviewLabelCli({ argv: ['7183', '--repo=o/n', '--to=changes', `--expect-head=${head}`],
        provider, emit: () => {}, verdictBody: 'Resolve conflict', defaultActor: 'test',
        buildComment: () => 'finding', successResult: o => o, refusalResult: o => o,
        appendApproval: () => {}, signalFix: () => {},
        appendVerdict: () => { writes.push('ledger'); if (step === 'comment') liveHead = moved; return { ok: true }; },
      })).toThrow();
      expect(writes).toEqual(['ledger', 'comment', 'label'].slice(0, ['ledger', 'comment', 'label'].indexOf(step)));
    } finally { exit.mockRestore(); }
  });
});
