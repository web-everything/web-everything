import { ledgerCoversHead } from '../../verdict-ledger.mjs';
import { verdictHead } from '../referrals.mjs';
/** The live verdict holds unless it clears and still covers the current head. */
export default {
  id: 'verdict',
  evaluate({ view, facts }) {
    const cur = view.folded?.current;
    if (!cur) return null; // no verdict yet: not a hold, just not cleared (the PR is in review)
    if (!view.clears) return { code: `verdict:${cur.verdict}`, reason: `live verdict is ${cur.verdict}`, needsYou: cur.verdict === 'human' ? 'a human must clear this PR' : null };
    const head = facts?.head?.sha ?? null;
    const witnessed = verdictHead(cur);
    if (head && witnessed && !(String(head).startsWith(witnessed) || witnessed.startsWith(String(head)))) {
      const { covers, reason } = ledgerCoversHead({ record: cur, headSha: head });
      if (!covers) return { code: 'stale-acceptance', reason: reason || `acceptance witnessed ${witnessed.slice(0, 8)}, head is ${head.slice(0, 8)}` };
    }
    return null;
  },
};
