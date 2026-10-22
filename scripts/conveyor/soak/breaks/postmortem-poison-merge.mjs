/** PR #5502: a permanently unreadable merge must not starve later postmortems. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPostmortemPass, listMergedSince } from '../../pass-daemons/pr-postmortem-pass.mjs';
import { DEFAULTS } from '../../../operations/coroner-pr-postmortem.mjs';

const SOURCE = 'scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs';
export async function shiftedListingScenario(moved = 101) {
  const dir = fs.mkdtempSync(join(tmpdir(),'soak-shifted-merge-'));
  const at = minute => new Date(Date.UTC(2026,9,17,0,minute)).toISOString();
  const cursor = join(dir,'merge-cursor-example%2Frepo.json');
  const original = JSON.stringify({cursor:at(500),done:[]});
  const violations = [], reads = [];
  let stable = false, error;
  const listing = Array.from({length:201},(_,i) => ({number:i+1,updated_at:at(650),merged_at:i === 100 ? at(600) : null}));
  const gh = args => {
    const page = Number(new URL(`https://example.test/${args.at(-1)}`).searchParams.get('page'));
    if (!stable && page === 2) for (const row of listing) if (row.number >= 101 && row.number < 101+moved) row.updated_at = at(701);
    return [...listing].sort((a,b) => b.updated_at.localeCompare(a.updated_at) || a.number-b.number)
      .slice((page-1)*100,page*100).map(row => ({...row}));
  };
  const args = {repo:'example/repo',dir,settings:{value:DEFAULTS},
    listMerged:(repo,since,until) => listMergedSince(repo,since,until,{gh}),
    collect:(repo,pr) => { reads.push(pr); return {repo,pr,openedAt:at(0),mergedAt:at(600)}; }};
  try {
    fs.writeFileSync(cursor,original);
    try { await runPostmortemPass({...args,now:at(700)}); } catch (e) { error = e; }
    if (error?.message !== 'listing shifted; cursor retained') violations.push('shifted listing did not abort');
    if (fs.readFileSync(cursor,'utf8') !== original) violations.push('shifted listing advanced persisted cursor');
    stable = true;
    await runPostmortemPass({...args,now:at(702)});
    if (reads.join(',') !== '101' || !fs.existsSync(join(dir,'postmortem-example%2Frepo-101.md'))) violations.push('stable retry lost PR #101');
    return violations;
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
export default {
  id: 'postmortem-poison-merge',
  title: 'postmortem watcher delays quarantine and retries operator recovery across restarts',
  card: 'PR #5502',
  fixedBy: { sha:'HEAD', where:'lane/pr-postmortem', paths:[SOURCE] },
  fixPresent(root) {
    const source = fs.readFileSync(join(root,SOURCE),'utf8');
    return source.includes('MIN_COLLECTION_FAILURE_SPAN_MS') && source.includes('listing shifted; cursor retained');
  },
  async run() {
    const dir = fs.mkdtempSync(join(tmpdir(),'soak-poison-merge-'));
    const violations = [], reads = []; let fail = true;
    const at = minute => new Date(Date.UTC(2026,9,17,0,minute)).toISOString();
    try {
      const args = { repo:'example/repo', dir, settings:{value:DEFAULTS},
        listMerged:async (_repo,since) => [2,3].filter(() => at(600) >= since).map(number => ({number,merged_at:at(600)})),
        collect:async (repo,pr) => {
          reads.push(pr);
          if (pr === 2 && fail) throw Error('PR exceeds 200 observed heads; refusing incomplete check history');
          return {repo,pr,openedAt:at(0),mergedAt:at(600)};
        } };
      let result;
      for (const minute of [700,701,702,730,740]) {
        try { result = await runPostmortemPass({...args,now:at(minute)}); }
        catch (e) { if (minute >= 730) violations.push(`retry budget did not release window: ${e.message}`); }
        if (minute === 702) {
          const early = JSON.parse(fs.readFileSync(join(dir,'merge-cursor-example%2Frepo.json')));
          if (early.quarantined.length) violations.push('transient failure quarantined within two minutes');
        }
      }
      if (result?.cursor !== at(740) || result?.quarantined?.[0]?.pr !== 2) violations.push('missing durable quarantine/cursor');
      if (reads.join(',') !== '2,3,2,2,2') violations.push(`unexpected reads: ${reads}`);
      const reports = fs.readdirSync(dir).filter(name => name.endsWith('-3.md'));
      if (reports.length !== 1) violations.push('later PR report missing');
      // The merge is now well outside discovery; deleting only quarantine must retry it.
      const cursor = join(dir,'merge-cursor-example%2Frepo.json');
      const state = JSON.parse(fs.readFileSync(cursor)); state.quarantined = [];
      fs.writeFileSync(cursor,JSON.stringify(state)); fail = false;
      await runPostmortemPass({...args,now:at(741)});
      if (reads.join(',') !== '2,3,2,2,2,2' || !fs.existsSync(join(dir,'postmortem-example%2Frepo-2.md'))) violations.push('operator quarantine removal did not recover publication');
      violations.push(...await shiftedListingScenario());
      violations.push(...await shiftedListingScenario(1));
      return {violations};
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  },
  judge(report) { return report.violations; },
};
