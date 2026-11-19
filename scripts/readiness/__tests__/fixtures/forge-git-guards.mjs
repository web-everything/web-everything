import {execFileSync} from 'node:child_process';
import {scanDiffBranchCoverage} from '../../../lib/diff-branch-coverage.mjs';
import {DERIVED_ARTIFACT_DIRS, validateUntrackedDerivedArtifacts} from '../../../check-standards-rules.mjs';

// Use the same inventory and classifier as check-standards, never a substitute gate.
export function scanMaterializedGuards(root) {
  const paths=execFileSync('git',['ls-files','--others','--exclude-standard','--',...DERIVED_ARTIFACT_DIRS],
    {cwd:root,encoding:'utf8',maxBuffer:4*1024*1024}).split('\n').filter(Boolean);
  return {coverage:scanDiffBranchCoverage(root,{base:'HEAD'}),artifacts:validateUntrackedDerivedArtifacts(paths)};
}
