/** PR #5502: a permanently unreadable merge must not starve later postmortems. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPostmortemPass } from '../../pass-daemons/pr-postmortem-pass.mjs';
import { DEFAULTS } from '../../../operations/coroner-pr-postmortem.mjs';

const SOURCE = 'scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs';
export default {
  id: 'postmortem-poison-merge',
  title: 'postmortem watcher quarantines poison merges and publishes later PRs across restarts',
  card: 'PR #5502',
  fixedBy: { sha:'HEAD', where:'lane/pr-postmortem', paths:[SOURCE] },
  fixPresent(root) { return fs.readFileSync(join(root,SOURCE),'utf8').includes('state.quarantined.push'); },
  async run() {
    const dir = fs.mkdtempSync(join(tmpdir(),'soak-poison-merge-'));
    const violations = [], reads = [];
    const at = minute => new Date(Date.UTC(2026,9,17,0,minute)).toISOString();
    try {
      const args = { repo:'example/repo', dir, settings:{value:DEFAULTS},
        listMerged:async (_repo,since) => [2,3].filter(() => at(600) >= since).map(number => ({number,merged_at:at(600)})),
        collect:async (repo,pr) => {
          reads.push(pr);
          if (pr === 2) throw Error('PR exceeds 200 observed heads; refusing incomplete check history');
          return {repo,pr,openedAt:at(0),mergedAt:at(600)};
        } };
      let result;
      for (const minute of [700,701,702,703]) {
        try { result = await runPostmortemPass({...args,now:at(minute)}); }
        catch (e) { if (minute >= 702) violations.push(`retry budget did not release window: ${e.message}`); }
      }
      if (result?.cursor !== at(703) || result?.quarantined?.[0]?.pr !== 2) violations.push('missing durable quarantine/cursor');
      if (reads.join(',') !== '2,3,2,2') violations.push(`unexpected reads: ${reads}`);
      const reports = fs.readdirSync(dir).filter(name => name.endsWith('-3.md'));
      if (reports.length !== 1) violations.push('later PR report missing');
      return {violations};
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  },
  judge(report) { return report.violations; },
};
