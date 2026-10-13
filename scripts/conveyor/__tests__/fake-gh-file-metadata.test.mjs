import { describe, expect, it } from 'vitest';
import { listChangedFilesNative } from './helpers/fake-gh.mjs';
import { decideDrainWorkflowEditHold } from '../../lib/drain-workflow-edit-hold.mjs';

function changedFiles(status, stats) {
  const run = (args) => {
    if (args[0] === 'merge-base') return 'base-sha\n';
    if (!args.includes('--no-renames') || !args.includes('-z')) throw new Error('unsafe file listing');
    if (args.includes('--name-status')) return status;
    if (args.includes('--numstat')) return stats;
    throw new Error(`unexpected git arguments: ${args}`);
  };
  return listChangedFilesNative('/unused-origin', 'main', 'head', { run });
}

describe('fake GitHub file evidence for the drain', () => {
  it('supplies complete metadata so ordinary ready PRs reach the landing planner', () => {
    const files = changedFiles('A\0new.md\0M\0edited.md\0D\0old.md\0',
      '1\t0\tnew.md\0' + '2\t1\tedited.md\0' + '0\t3\told.md\0');
    expect(files.map((f) => f.changeType)).toEqual(['ADDED', 'MODIFIED', 'DELETED']);
    const complete = files.every((f) => ['ADDED', 'MODIFIED', 'DELETED'].includes(f.changeType));
    expect(decideDrainWorkflowEditHold({ files: files.map((f) => f.path), filesComplete: complete })).toEqual({ hold: false });
  });

  it('keeps a workflow removal visible when a file moves out of the workflow directory', () => {
    const files = changedFiles('D\0.github/workflows/check.yml\0A\0docs/check.yml\0',
      '0\t4\t.github/workflows/check.yml\0' + '4\t0\tdocs/check.yml\0');
    expect(decideDrainWorkflowEditHold({ files: files.map((f) => f.path), filesComplete: true }).hold).toBe(true);
    expect(files[0].changeType).toBe('DELETED');
  });

  it('preserves tabs and newlines in paths and handles binary and type changes', () => {
    const path = 'odd\tname\n.bin';
    const files = changedFiles(`T\0${path}\0`, `-\t-\t${path}\0`);
    expect(files).toEqual([{ path, additions: 0, deletions: 0, changeType: 'MODIFIED' }]);
  });
});
