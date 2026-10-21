// @vitest-environment node
/**
 * @file scripts/operations/__tests__/referral-findings.test.mjs
 * @description Finding inventory through the declared CLI with an injected reader and no external IO.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runReferralFindingsCli } from '../referral-findings-cli.mjs';
import { planOperatorRuling } from '../record-referral-ruling.mjs';
import * as freshness from '../../lib/main-staleness.mjs';
const repo = 'o/r', pr = 7, head = 'a'.repeat(40), runId = 'review-pr-1';
function snapshot({ group = 'open', empty = false } = {}) {
  const seat = 'judgeCorrectnessAdvisory', file = 'scripts/x.mjs', line = 12;
  const summary = "operator's $(words)";
  const key = JSON.stringify([seat, file, line, summary]);
  // Reader order is authoritative, even when ids suggest a different chronology.
  const standing = group === 'open' ? [] : [{ id: 'z-old', result: 'card' }, { id: 'a-new', result: 'block' }];
  const target = { runId, key, seat, file, line, summary, standing,
    rulingIds: standing.map((r) => r.id), ...(group === 'disputed' ? { blockIds: ['a-new'] } : {}) };
  return { open: [], ruled: [], disputed: [],
    ...(!empty ? { [group]: [target], ...(group === 'disputed' ? { ruled: [target] } : {}) } : {}),
    head, now: '2026-10-21T00:00:00Z', clearerId: 'test' };
}
const run = (read, flags = []) => runReferralFindingsCli([`--repo=${repo}`, `--pr=${pr}`, ...flags], { readRulingContext: () => read });

describe('referral-findings', () => {
  it('lists an exact open key, preserves shell quoting and leaves operator placeholders', async () => {
    const read = snapshot();
    const result = await run(read);
    expect(result.code).toBe(0);
    const [f] = result.run.verdict.findings;
    expect(f.finding).toBe(read.open[0].key);
    expect(JSON.parse(f.finding)).toEqual(['judgeCorrectnessAdvisory', 'scripts/x.mjs', 12, "operator's $(words)"]);
    expect(f.group).toBe('open');
    expect(f.standing).toEqual([]);
    expect(f.command).toContain("operator'\\''s $(words)");
    expect(f.command).not.toContain('--supersedes');
    expect(f.command).toContain('--ruling=<block|not-real> --actor=<login> --channel=<where> --reason="<operator\'s words>"');
    expect(f.command).not.toContain('--card=');
    expect(f.cardCommand).toContain('--ruling=card --card=<we:backlog path>');
    expect(f.cardCommand).toContain('--actor=<login> --channel=<where> --reason="<operator\'s words>"');
    expect(result.lines).toContain(f.command);
    expect(result.lines).toContain(f.cardCommand);
    expect(result.run.effects).toEqual([]);
  });
  it.each(['open', 'ruled', 'disputed'].flatMap((group) =>
    ['block', 'not-real', 'card'].map((ruling) => [group, ruling])))('suggests a planner-accepted command for %s / %s', async (group, ruling) => {
    const read = snapshot({ group });
    const before = structuredClone(read);
    const result = await run(read);
    expect(result.code).toBe(0);
    const [f] = result.run.verdict.findings;
    expect(result.run.verdict.findings).toHaveLength(1);
    expect(f.group).toBe(group);
    expect(f.standing).toEqual(group === 'open' ? [] : [
      { id: 'a-new', result: 'block' }, { id: 'z-old', result: 'card' },
    ]);
    expect(f.rulingIds).toEqual(f.standing.map((r) => r.id));
    if (group === 'ruled') expect(f.command).toContain("--supersedes='a-new'");
    else expect(f.command).not.toContain('--supersedes');
    expect(result.lines).toContain(`[${group}] scripts/x.mjs:12 — operator's $(words)`);
    expect(result.lines).toContain(`--finding=${read[group][0].key}`);
    expect(result.lines).toContain(`standing rulings (newest first): ${group === 'open' ? 'none' : 'a-new (block), z-old (card)'}`);
    if (group === 'disputed') {
      expect(f.blockIds).toEqual(['a-new']);
      expect(result.lines).toContain('blockIds: a-new');
    }
    const template = ruling === 'card' ? f.cardCommand : f.command;
    expect(result.lines).toContain(template);
    const shell = template.replace('node scripts/run-fresh.mjs record-referral-ruling', "printf '%s\\0'")
      .replace(/--ruling=<[^>]+>/, `--ruling=${ruling}`)
      .replace('<we:backlog path>', 'we:backlog/123-follow-up.md').replace('<login>', 'chalbert')
      .replace('<where>', 'test channel').replace("<operator's words>", 'checked');
    // Keep a channel containing spaces a single shell argument.
    const flags = execFileSync('/bin/sh', ['-c', shell.replace('--channel=test channel', "--channel='test channel'")],
      { encoding: 'utf8' }).split('\0').filter(Boolean);
    const input = Object.fromEntries(flags.map((flag) => {
      const i = flag.indexOf('=');
      return [flag.slice(2, i), flag.slice(i + 1)];
    }));
    const context = ruling === 'card'
      ? { ...read, card: { ref: input.card, readable: true } } : read;
    expect(input.card).toBe(ruling === 'card' ? 'we:backlog/123-follow-up.md' : undefined);
    let plan;
    expect(() => { plan = planOperatorRuling(context, input); }).not.toThrow();
    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0]).toMatchObject({ runId, key: read[group][0].key });
    expect(plan.supersedes).toEqual(group === 'open' ? [] : ['a-new']);
    expect(read).toEqual(before);
    const json = await run(read, ['--json']);
    expect(JSON.parse(json.lines.join('\n')).verdict.findings).toEqual(result.run.verdict.findings);
  });
  it('reports separate counts for all three reader groups', async () => {
    const read = snapshot();
    for (const group of ['ruled', 'disputed']) {
      read[group] = snapshot({ group })[group].map((f) => ({ ...f, runId: `${runId}-${group}` }));
    }
    const result = await run(read);
    expect(result.run.verdict.findings.map((f) => f.group)).toEqual(['open', 'ruled', 'disputed']);
    expect(result.lines.join('\n')).toContain('1 open finding(s); 1 ruled finding(s); 1 disputed finding(s)');
  });
  it.each(['named', 'wev-prefixed', 'suffixed', 'registered', 'environment'])('refuses a %s daemon clone before invoking its reader', async (kind) => {
    const reader = vi.fn();
    const root = join(homedir(), 'workspace', { named: 'audit-daemon', 'wev-prefixed': 'wev-control', suffixed: 'wev-review-daemon-backup' }[kind] ?? 'resident-clone');
    await expect(runReferralFindingsCli([], { root, readRulingContext: reader,
      env: kind === 'environment' ? { WE_DAEMON_MANAGED_CLONE: '1' } : {},
      cloneRoots: () => kind === 'registered' ? [root] : [] })).rejects.toThrow('refuses daemon clones');
    expect(reader).not.toHaveBeenCalled();
  });
  it('refuses stale lane code without fetching or re-executing in a daemon cwd', async () => {
    const root = join(homedir(), 'workspace', 'lane-test');
    const cwd = join(homedir(), 'workspace', 'wev-control');
    const runGit = vi.fn((args, options) => {
      if (options.cwd !== root) throw new Error('git escaped lane');
      if (args[0] === 'fetch') return { status: 0, stdout: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: '29' };
      throw new Error(`unexpected git command: ${args}`);
    });
    const spawn = vi.fn(), exit = vi.fn();
    const readSettings = vi.fn(() => ({ operatorCli: { freshFallback: 'on' } }));
    const assertFresh = freshness.assertOperatorCliFresh;
    const spy = vi.spyOn(freshness, 'assertOperatorCliFresh').mockImplementation((lane, options) =>
      assertFresh(lane, { ...options, skipUnderVitest: false, run: runGit,
        listBehindFiles: () => ['scripts/operations/referral-findings-cli.mjs'],
        cwd, argv: [process.execPath, join(root, 'scripts/operations/referral-findings-cli.mjs')],
        spawn, exit, readSettings }));
    try {
      const result = await runReferralFindingsCli([`--repo=${repo}`, `--pr=${pr}`], {
        root, env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'on' }, cloneRoots: () => [],
      });
      expect(result.code).not.toBe(0);
      expect(JSON.stringify(result)).toContain(freshness.OPERATOR_CLI_STALE_MARKER);
      expect(spy).toHaveBeenCalledWith(root, expect.objectContaining({
        env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' },
      }));
      expect(runGit.mock.calls.map(([args, options]) => [args[0], options.cwd])).toEqual([
        ['fetch', root], ['rev-list', root],
      ]);
      expect(spawn).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(readSettings).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('reports a PR with no findings', async () => {
    const result = await run(snapshot({ empty: true }));
    expect(result.code).toBe(0);
    expect(result.run.verdict.findings).toEqual([]);
    expect(result.lines.join('\n')).toContain('0 open finding(s); 0 ruled finding(s); 0 disputed finding(s)');
  });
  it('refuses invalid input before reading and malformed referral data before suggesting commands', async () => {
    const reader = vi.fn();
    const result = await runReferralFindingsCli(['--repo=o/r', '--pr=0'], { readRulingContext: reader });
    expect(result.code).not.toBe(0);
    expect(reader).not.toHaveBeenCalled();
    expect((await run({ ...snapshot(), malformed: true })).code).not.toBe(0);
  });
});
