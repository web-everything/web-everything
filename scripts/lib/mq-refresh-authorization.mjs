import { execFileSyncThrottled } from './gh-throttle.mjs';
import { createMqLiveReader, readDrainQueueSafety, redTeamEnqueueHold } from './drain-queue-safety.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { readDrainRedTeamEvidence } from './drain-red-team-evidence.mjs';
import { readStandingRuling, readOperatorIssues, headIsCardOnly, headBelongsToPr, readUneditedCommentIds, standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { resolveApprovalLicensesEnqueue, proveHumanOnlyLicense } from './human-only-enqueue-license.mjs';
import { readPinnedChangedFiles, workflowEditHold } from './merge-queue-enqueue.mjs';
import { decideDrainWorkflowEditHold, resolveDrainWorkflowEditHuman } from './drain-workflow-edit-hold.mjs';
import { parseLatestHumanClearedSha } from './review-escalation.mjs';
import { resolveSkipRebaseApprovedHumanSurface, readApprovedHumanSurfaceHold } from './approved-human-surface-hold.mjs';
export function createMqRefreshAuthorization({ repo, pr, head, root, exec: raw = execFileSyncThrottled,
  approvedHeadHold, enqueueAllowed, log = line => process.stderr.write(`  ${line}\n`) }) {
  const live = createMqLiveReader(raw);
  const exec = (cmd, args, opts) => live(cmd, args, { cwd: root, timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...opts });
  const gh = args => exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { personalRoute: false } });
  return { approvedHeadHold: approvedHeadHold ?? (() => {
    try {
      const setting = resolveSkipRebaseApprovedHumanSurface();
      log(`merge-queue: skipRebaseApprovedHumanSurface=${setting.value} (${setting.source})`);
      if (setting.envInvalid || !['on', 'off'].includes(setting.value) || !['env', 'settings'].includes(setting.source)) return true;
      return readApprovedHumanSurfaceHold({ setting: setting.value, repo, pr, expectedHead: head, exec }).hold;
    } catch { return true; }
  }), enqueueAllowed: enqueueAllowed ?? (() => {
    try {
      const comments = readCompletePrComments(pr, { repo, exec });
      const safety = readDrainQueueSafety({ log });
      if (safety.value.waitForRedTeamBeforeEnqueue) {
        const evidence = readDrainRedTeamEvidence({ repo, pr, head });
        const standingRuling = standingRulingScope({ repo, pr: { number: pr, headRefOid: head, comments } }, {
          readRuling: slug => readStandingRuling(slug, { readIssues: target => readOperatorIssues(target, { gh }) }),
          cardOnly: target => headIsCardOnly(target, { belongs: identity => headBelongsToPr(identity, { gh }) }),
          unedited: target => readUneditedCommentIds(target, { gh }),
        });
        if (redTeamEnqueueHold({ ...evidence, repo, pr, head, comments, standingRuling })) return false;
      }
      const live = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,baseRefName']));
      if (live?.headRefOid !== head || typeof live.baseRefName !== 'string' || !live.baseRefName) return false;
      const read = readPinnedChangedFiles({ headSha: head, base: live.baseRefName, cwd: root, exec });
      if (read.error) return false;
      const workflow = resolveDrainWorkflowEditHuman();
      log(`policy · drainWorkflowEditHuman=${workflow.value} (${workflow.source})`);
      if (decideDrainWorkflowEditHold({ files: read.files, filesComplete: true, headSha: head,
        humanClearedSha: parseLatestHumanClearedSha(comments), setting: workflow.value }).hold) return false;
      const surface = workflowEditHold({ files: read.files, expectedCount: read.files?.length });
      if (!surface.hold) return true;
      if (!surface.humanOnly) return false;
      const setting = resolveApprovalLicensesEnqueue();
      log(`human-only approvalLicensesEnqueue=${setting.value} (${setting.source})`);
      if (!setting.value) return false;
      const license = proveHumanOnlyLicense({ repo, pr, headSha: head, cwd: root, exec });
      return license?.licensed === true && ['exact', 'numbering', 'mechanical'].includes(license.tier);
    } catch { return false; }
  }) };
}
