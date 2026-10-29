/** Isolate the drain's carry machinery from the review entry files' static import graph. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readDrainAcceptance } from '../merge-ai-prs.mjs';
import { applyHumanClearanceCarry } from '../lib/human-clearance-carry.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { READ_MAX_BUFFER } from '../lib/proc-read.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

const failure = error => ({ carried: null,
  reason: `human clearance evidence unreadable; normal review required: ${String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}` });

/** Emit one JSON line; return an exit code. Unknown evidence always leaves the normal review owed. */
export function run({ pr, repo, cwd = process.cwd(), exec = execFileSyncThrottled,
  readEvidence = readDrainAcceptance, carryOptions = {}, write = line => process.stdout.write(line),
  log = line => process.stderr.write(line),
} = {}) {
  let result, status = 0;
  try {
    if (!Number.isSafeInteger(Number(pr)) || Number(pr) <= 0) throw Error('pr must be a positive integer');
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('repo must be an owner/name slug');
    pr = Number(pr);
    const carryExec = (file, args, options = {}) => exec(file, args, {
      timeout: 60_000, maxBuffer: READ_MAX_BUFFER, ...options, cwd,
    });
    const evidence = readEvidence({ pr, repo, cwd, exec: carryExec });
    if (!/^[0-9a-f]{40}$/i.test(evidence?.headSha ?? '') || evidence.headReadFailed) {
      throw Error('initial head or live net diff unreadable');
    }
    if (!evidence.humanClearance || evidence.humanClearance.sha === evidence.headSha) {
      result = { carried: null, reason: evidence.humanClearance ? 'clearance already bound to the head' : 'no human clearance' };
    } else {
      let liveUnreadable = false;
      const outcome = applyHumanClearanceCarry({ ...carryOptions, evidence, pr, repo, cwd, exec: carryExec, log,
        numberingOnly: !evidence.humanClearance.diff && !evidence.humanClearance.contribution,
        readLiveEvidence: () => {
          try {
            const view = JSON.parse(carryExec('gh', ['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid,reviews'],
              { encoding: 'utf8' }));
            if (!/^[0-9a-f]{40}$/i.test(view?.headRefOid ?? '')) throw Error('live head unreadable');
            const comments = readCompletePrComments(pr, { repo, exec: carryExec });
            const reviews = Array.isArray(view.reviews) ? view.reviews : null;
            if (reviews === null) liveUnreadable = true;
            return { headSha: view.headRefOid, comments, reviews };
          } catch (error) {
            liveUnreadable = true;
            throw error;
          }
        },
      });
      if (liveUnreadable) status = 1;
      if (outcome?.carried?.recorded === true) {
        const { fromSha, toSha, fingerprint } = outcome.carried;
        result = { carried: { fromSha, toSha, fingerprint } };
      } else {
        result = { carried: null, reason: outcome?.reason ?? 'carry not proven; normal review required' };
      }
    }
  } catch (error) {
    status = 1;
    result = failure(error);
  }
  write(`${JSON.stringify(result)}\n`);
  return status;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  try {
    const { values } = parseArgs({ options: { pr: { type: 'string' }, repo: { type: 'string' } } });
    process.exitCode = run(values);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(error))}\n`);
    process.exitCode = 1;
  }
}
