import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGateSelfPath } from '../lib/review-escalation.mjs';
import { aiPr } from './fixtures/merge-ai-prs-fixtures.mjs';

const source = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = '07a3f88b3754b6d514d839a671ca102d770b92d0';

describe('workflow human hold through the drain CLI', () => {
  let root;
  let settings;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-cli-')));
    // Real modules and a private settings file: never edit the working checkout's policy.
    cpSync(join(source, 'scripts'), join(root, 'scripts'), {
      recursive: true, filter: (path) => !path.includes('__tests__'),
    });
    symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'));
    symlinkSync(join(source, 'schemas'), join(root, 'schemas'));
    mkdirSync(join(root, 'backlog'));
    mkdirSync(join(root, 'bin'));
    settings = join(root, 'scripts/drain-gate-settings.json');
    // No real git operations (including writes to .git) or network calls in this fixture.
    writeFileSync(join(root, 'bin/git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(root, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const pr = JSON.parse(process.env.WORKFLOW_PR);
let out = [];
if (a[0] === 'repo') out = 'main';
else if (a[0] === 'pr' && a[1] === 'list') {
  out = [pr];
  if (process.env.FLIP_SETTINGS && a[a.indexOf('--json') + 1].split(',').includes('mergeable')) {
    fs.writeFileSync(process.env.FLIP_SETTINGS, JSON.stringify({ drainWorkflowEditHuman: 'off' }));
  }
} else if (a[0] === 'pr' && a[1] === 'view') out = { ...pr, comments: [] };
fs.writeSync(1, typeof out === 'string' ? out : JSON.stringify(out));
`, { mode: 0o755 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cli = ({ labeled = true, watch = false, setting = 'on', files = [{ path: '.github/workflows/x.yml', changeType: 'MODIFIED' }] } = {}) => {
    writeFileSync(settings, JSON.stringify({ drainWorkflowEditHuman: setting }));
    return spawnSync(process.execPath, [join(root, 'scripts/merge-ai-prs.mjs'),
      '--this-repo', ...(labeled ? ['--label=ready-to-merge', '--no-review-escalation'] : []),
      '--no-reconcile-labels', '--dry-run', ...(watch ? ['--watch', '--interval=0.001', '--max-idle=2'] : ['--json']),
      '--no-drain-lease', '--no-red-main-freeze', '--no-rebase-drop', '--no-heal-collision', '--no-overlap-yield',
    ], { cwd: root, encoding: 'utf8', timeout: 20000, env: {
      ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, LANE_POOL_ROOT: root,
      WE_DRAIN_WORKFLOW_EDIT_HUMAN: '', FLIP_SETTINGS: watch ? settings : '',
      WORKFLOW_PR: JSON.stringify(aiPr({ number: 3432, headRefOid: sha, headRefName: 'lane/3432',
        baseRefName: 'main', labels: [{ name: 'ready-to-merge' }], files,
        statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }],
      })),
    } });
  };

  it.each([true, false])('holds a workflow PR in the bare loop (labeled=%s)', (labeled) => {
    const result = cli({ labeled });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.toMerge).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ num: 3432,
      reason: expect.stringContaining('human-only:'),
      humanRequired: true,
    })]);
    // This positive control also catches accidentally dropping workflowReadOptions:
    // a complete non-workflow listing must not become an unreadable-diff defer.
    const ordinary = cli({ labeled, files: [{ path: 'README.md', changeType: 'MODIFIED' }] });
    expect(ordinary.status, ordinary.stderr).toBe(0);
    expect(JSON.parse(ordinary.stdout).toMerge).toEqual([expect.objectContaining({ num: 3432 })]);
  });

  it.each([true, false])('defers a capped listing when the full read fails (labeled=%s)', (labeled) => {
    const result = cli({ labeled, files: Array.from({ length: 100 }, (_, i) => ({ path: `docs/${i}.md`, changeType: 'MODIFIED' })) });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.toMerge).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ num: 3432,
      reason: expect.stringContaining('workflow-edit change list unreadable'),
    })]);
    expect(report.reconciledLabels).toEqual([]);
  });

  it('reloads and logs the policy on both watch passes after the file changes', () => {
    const result = cli({ watch: true });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stderr.split('\n').filter((line) => line.startsWith('policy · drainWorkflowEditHuman='));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('drainWorkflowEditHuman=on (settings)');
    expect(lines[1]).toContain('drainWorkflowEditHuman=off (settings)');
  });

  it.each(['scripts/drain-gate-settings.json', 'scripts/lib/drain-workflow-edit-hold.mjs'])(
    'requires human review for policy changes to %s', (path) => {
      expect(isGateSelfPath(path)).toBe(true);
    });
});
