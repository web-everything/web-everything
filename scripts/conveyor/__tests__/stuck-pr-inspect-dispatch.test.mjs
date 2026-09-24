/**
 * @file scripts/conveyor/__tests__/stuck-pr-inspect-dispatch.test.mjs
 * @description Pins the diagnosis-only inspection dispatch (epic #3383): brief-fill refusals, the `inspect-*`
 *   session-slug grammar across repos, the disallowedTools argv shape (single `=`-joined element, never two),
 *   and the plan→fill→spawn composition with every IO point injected.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fillInspectBrief, INSPECT_BRIEF_PLACEHOLDERS, canonicalInspectPlaceholder, inspectSessionSlug,
  planInspectDispatch, INSPECT_DISPATCH_DISALLOWED_TOOLS, inspectDispatchDisallowedToolsArgs, dispatchInspection,
  noInspectionStarted,
} from '../stuck-pr-inspect-dispatch.mjs';

describe('inspectSessionSlug', () => {
  it('mints inspect-<pr> for WE and inspect-<tag>-<pr> for a sibling repo', () => {
    expect(inspectSessionSlug(2505, 'we')).toBe('inspect-2505');
    expect(inspectSessionSlug(176, 'plateau-app')).toBe('inspect-pa-176');
    expect(inspectSessionSlug(9, 'frontierui')).toBe('inspect-fui-9');
  });
  it('refuses no PR number', () => {
    expect(() => inspectSessionSlug('', 'we')).toThrow(/needs a PR number/);
  });
});

describe('planInspectDispatch', () => {
  it('resolves the gh slug and session slug for a valid PR/repo', () => {
    expect(planInspectDispatch({ pr: '2505', repo: 'chalbert/web-everything' })).toEqual({
      pr: 2505, repo: 'chalbert/web-everything', repoKey: 'we', sessionSlug: 'inspect-2505',
    });
  });
  it('refuses a non-positive-integer PR', () => {
    expect(() => planInspectDispatch({ pr: 'abc', repo: 'chalbert/web-everything' })).toThrow(/positive integer/);
    expect(() => planInspectDispatch({ pr: -1, repo: 'chalbert/web-everything' })).toThrow(/positive integer/);
  });
  it('refuses a non-constellation repo', () => {
    expect(() => planInspectDispatch({ pr: 1, repo: 'someone/else' })).toThrow(/is not a constellation repo/);
  });
});

describe('fillInspectBrief', () => {
  const template = 'PR {{PR}} in {{REPO}} as {{SESSION_SLUG}} — stage {{STAGE}}, {{MINUTES_SINCE}}m over {{THRESHOLD_MINUTES}}m.';
  const values = { PR: 2505, REPO: 'chalbert/web-everything', SESSION_SLUG: 'inspect-2505', STAGE: 'conflict', MINUTES_SINCE: 390, THRESHOLD_MINUTES: 45 };

  it('substitutes every declared placeholder', () => {
    const { prompt, unknownTokens } = fillInspectBrief(template, values);
    expect(prompt).toBe('PR 2505 in chalbert/web-everything as inspect-2505 — stage conflict, 390m over 45m.');
    expect(unknownTokens).toEqual([]);
  });

  it('refuses an empty template', () => {
    expect(() => fillInspectBrief('', values)).toThrow(/template is empty/);
    expect(() => fillInspectBrief('   ', values)).toThrow(/template is empty/);
  });

  it('refuses a missing/blank value for a declared placeholder', () => {
    expect(() => fillInspectBrief(template, { ...values, STAGE: '' })).toThrow(/no value for the brief placeholder \{\{STAGE\}\}/);
    expect(() => fillInspectBrief(template, { ...values, STAGE: undefined })).toThrow(/no value for the brief placeholder \{\{STAGE\}\}/);
  });

  it('refuses a value with characters unsafe for an unquoted shell paste', () => {
    expect(() => fillInspectBrief(template, { ...values, STAGE: 'conflict; rm -rf /' })).toThrow(/has characters the brief cannot carry safely/);
  });

  it('refuses a MISSPELLED placeholder rather than silently leaving it unfilled', () => {
    expect(() => fillInspectBrief('{{Pr}}', values)).toThrow(/MISSPELLED placeholder/);
  });

  it('reports (never throws on) a genuinely unknown token', () => {
    const { unknownTokens } = fillInspectBrief(`${template} {{SOME_EXAMPLE}}`, values);
    expect(unknownTokens).toEqual(['{{SOME_EXAMPLE}}']);
  });

  it('canonicalInspectPlaceholder recognizes case/separator variants of every declared name', () => {
    for (const name of INSPECT_BRIEF_PLACEHOLDERS) {
      expect(canonicalInspectPlaceholder(name.toLowerCase())).toBe(name);
    }
    // A multi-word name typo'd with a different separator (space/hyphen) still canonicalizes.
    expect(canonicalInspectPlaceholder('session-slug')).toBe('SESSION_SLUG');
    expect(canonicalInspectPlaceholder('session slug')).toBe('SESSION_SLUG');
    expect(canonicalInspectPlaceholder('minutes since')).toBe('MINUTES_SINCE');
    expect(canonicalInspectPlaceholder('totally-unknown')).toBeNull();
  });
});

describe('inspectDispatchDisallowedToolsArgs', () => {
  it('is ONE =-joined argv element, never two separate ones (the variadic-swallowing hazard)', () => {
    const args = inspectDispatchDisallowedToolsArgs();
    expect(args).toHaveLength(1);
    expect(args[0]).toBe(`--disallowedTools=${INSPECT_DISPATCH_DISALLOWED_TOOLS.join(',')}`);
  });
  it('denies gh pr comment NOTHING — the brief\'s own required last step must still be reachable', () => {
    expect(INSPECT_DISPATCH_DISALLOWED_TOOLS.some((p) => p.includes('gh pr comment'))).toBe(false);
  });
  it('denies every label/edit/merge mutation and every write-side script', () => {
    for (const must of [
      'Bash(gh pr edit:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr review:*)', 'Bash(gh label:*)',
      'Bash(node scripts/backlog.mjs:*)', 'Bash(node scripts/lane-pool.mjs:*)',
    ]) expect(INSPECT_DISPATCH_DISALLOWED_TOOLS).toContain(must);
  });
  it('denies EVERY git command — this agent runs in the primary checkout, with no lane to absorb a reset/clean (PR #2553 review)', () => {
    const prefixes = INSPECT_DISPATCH_DISALLOWED_TOOLS.map((p) => p.slice('Bash('.length, -':*)'.length));
    const blocked = (cmd) => prefixes.some((d) => cmd === d || cmd.startsWith(`${d} `));
    for (const cmd of [
      'git push origin HEAD', 'git commit -m x', 'git checkout main', 'git switch -c x', 'git reset --hard',
      'git clean -fd', 'git branch -D x', 'git stash', 'git merge x', 'git rebase main', 'git cherry-pick abc',
      'git restore .', 'git rm -r x', 'git worktree add ../x', 'git -C . reset --hard', 'git -c core.x=y clean -fdx',
    ]) expect(blocked(cmd), cmd).toBe(true);
  });
  it('WIRING: the brief never tells the agent to run a git command (it is denied git wholesale)', () => {
    const brief = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../skills-src/conveyor/stuck-pr-inspect-brief.md'), 'utf8',
    );
    expect([...brief.matchAll(/`(git [^`]+)`/g)].map((m) => m[1])).toEqual([]);
  });
  it('the brief tells the agent to redact secrets before quoting any log/process output in its public comment', () => {
    const brief = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../skills-src/conveyor/stuck-pr-inspect-brief.md'), 'utf8',
    );
    expect(brief).toMatch(/\*\*Redact before you quote\.\*\*/);
    for (const term of ['token', 'environment', 'home-directory']) expect(brief).toContain(term);
  });
  it('denies `gh api` — the raw-REST bypass that closes/labels/merges past every per-verb rule (PR #2553 review)', () => {
    // Every GitHub write the review named reaches through `gh api`: PATCH state=closed, POST .../labels, PUT .../merge.
    expect(INSPECT_DISPATCH_DISALLOWED_TOOLS).toContain('Bash(gh api:*)');
  });
  it('denies every OTHER GitHub-write gh verb family too, not only the ones first thought of', () => {
    for (const must of [
      'Bash(gh pr close:*)', 'Bash(gh pr reopen:*)', 'Bash(gh pr ready:*)', 'Bash(gh pr lock:*)',
      'Bash(gh pr unlock:*)', 'Bash(gh pr update-branch:*)', 'Bash(gh pr create:*)',
      'Bash(gh issue:*)', 'Bash(gh workflow:*)', 'Bash(gh run:*)', 'Bash(gh repo:*)', 'Bash(gh release:*)',
      'Bash(gh secret:*)', 'Bash(gh variable:*)', 'Bash(gh cache:*)', 'Bash(gh ruleset:*)',
      // indirection back to raw REST
      'Bash(gh alias:*)', 'Bash(gh extension:*)', 'Bash(gh auth:*)',
      // GitHub-writing repo scripts (their child `gh` escapes Bash deny rules) + the recursive-dispatch sweep
      'Bash(node scripts/conveyor/stuck-pr-watch.mjs sweep:*)', 'Bash(node scripts/conveyor/stand-down.mjs:*)',
      'Bash(node scripts/conveyor/rearm-review.mjs:*)', 'Bash(node scripts/conveyor/stuck-pr-inspect-dispatch.mjs:*)',
    ]) expect(INSPECT_DISPATCH_DISALLOWED_TOOLS).toContain(must);
  });
  it('keeps the brief\'s own timeline read reachable (only the sweep verb of the watch is denied)', () => {
    const cmd = 'node scripts/conveyor/stuck-pr-watch.mjs timeline --pr=1 --repo=chalbert/web-everything';
    const prefixes = INSPECT_DISPATCH_DISALLOWED_TOOLS.map((p) => p.slice('Bash('.length, -':*)'.length));
    expect(prefixes.filter((d) => cmd.startsWith(d))).toEqual([]);
  });
  it('WIRING: the brief never tells the agent to run a gh command its own deny list refuses', () => {
    const brief = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../skills-src/conveyor/stuck-pr-inspect-brief.md'), 'utf8',
    );
    const ghCmds = [...brief.matchAll(/`(gh [^`]+)`/g)].map((m) => m[1]);
    expect(ghCmds.length).toBeGreaterThan(0);
    const denied = INSPECT_DISPATCH_DISALLOWED_TOOLS
      .filter((p) => p.startsWith('Bash(gh ')).map((p) => p.slice('Bash('.length, -':*)'.length));
    for (const cmd of ghCmds) expect(denied.filter((d) => cmd.startsWith(d))).toEqual([]);
    expect(brief).toContain('stuck-pr-watch.mjs timeline --pr={{PR}} --repo={{REPO}}');
  });
  it('INVARIANT: any per-verb `gh` deny list must also deny `gh api` (or deny `gh` wholesale)', () => {
    const perVerb = INSPECT_DISPATCH_DISALLOWED_TOOLS.some((p) => p.startsWith('Bash(gh '));
    const wholesale = INSPECT_DISPATCH_DISALLOWED_TOOLS.includes('Bash(gh:*)');
    expect(!perVerb || wholesale || INSPECT_DISPATCH_DISALLOWED_TOOLS.includes('Bash(gh api:*)')).toBe(true);
  });
});

describe('dispatchInspection — plan → fill → mint → spawn, every IO point injected', () => {
  it('builds the expected argv and returns the parsed agent id', () => {
    const spawnAgent = vi.fn(() => 'backgrounded · abcd1234 · inspect-2505\n');
    const readBrief = () => 'Inspecting {{PR}} on {{REPO}} as {{SESSION_SLUG}} — {{STAGE}}/{{MINUTES_SINCE}}/{{THRESHOLD_MINUTES}}';
    const result = dispatchInspection({
      pr: 2505, repo: 'chalbert/web-everything', stage: 'conflict', minutesSince: 390.2, thresholdMinutes: 45,
      root: '/repo', readBrief, mintSessionId: () => 'uuid-1', spawnAgent,
    });
    expect(result.agentId).toBe('abcd1234');
    expect(result.sessionSlug).toBe('inspect-2505');
    expect(result.repo).toBe('chalbert/web-everything');
    expect(result.prompt).toContain('inspect-2505');
    expect(result.prompt).toContain('conflict/390/45');

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    const [argv, opts] = spawnAgent.mock.calls[0];
    expect(argv).toContain('--bg');
    expect(argv).toContain('-n');
    expect(argv).toContain('inspect-2505');
    expect(argv.some((a) => typeof a === 'string' && a.startsWith('--disallowedTools='))).toBe(true);
    expect(opts).toEqual(expect.objectContaining({ cwd: '/repo' }));
  });

  // #x8mpubm follow-up (live-caught 2026-09-24) — this dispatch never wired the gh-app-shim either, the same
  // gap fixed in review-dispatch.mjs/reconcile-fix-dispatch.mjs.
  it('#x8mpubm follow-up — resolveSettingsEnv is called with root, and its result folds into the argv as --settings', () => {
    const resolveSettingsEnv = vi.fn(() => ({ PATH: '/shim:/usr/bin' }));
    const spawnAgent = vi.fn(() => 'backgrounded · abcd1234 · inspect-2505\n');
    dispatchInspection({
      pr: 2505, repo: 'chalbert/web-everything', stage: 'conflict', minutesSince: 390.2, thresholdMinutes: 45,
      root: '/repo', readBrief: () => '{{PR}}{{REPO}}{{SESSION_SLUG}}{{STAGE}}{{MINUTES_SINCE}}{{THRESHOLD_MINUTES}}',
      mintSessionId: () => 'uuid-1', spawnAgent, resolveSettingsEnv,
    });
    expect(resolveSettingsEnv).toHaveBeenCalledWith('/repo');
    const [argv] = spawnAgent.mock.calls[0];
    expect(argv).toContain('--settings');
    expect(argv[argv.indexOf('--settings') + 1]).toBe(JSON.stringify({ env: { PATH: '/shim:/usr/bin' } }));
  });

  it('refuses to run from a lane checkout (assertNotALaneCheckout)', () => {
    expect(() => dispatchInspection({
      pr: 1, repo: 'chalbert/web-everything', stage: 'fix', minutesSince: 50, thresholdMinutes: 45,
      root: '/some/path/.lanes/web-everything/lane-9',
      readBrief: () => '{{PR}}{{REPO}}{{SESSION_SLUG}}{{STAGE}}{{MINUTES_SINCE}}{{THRESHOLD_MINUTES}}',
      spawnAgent: vi.fn(),
    })).toThrow();
  });

  describe('noInspectionStarted — only a failure that PROVES no agent exists (PR #2553 review)', () => {
    const base = {
      pr: 1, repo: 'chalbert/web-everything', stage: 'fix', minutesSince: 50, thresholdMinutes: 45, root: '/repo',
      readBrief: () => '{{PR}}{{REPO}}{{SESSION_SLUG}}{{STAGE}}{{MINUTES_SINCE}}{{THRESHOLD_MINUTES}}',
      mintSessionId: () => 'uuid-1',
    };
    const caught = (o) => { try { dispatchInspection({ ...base, ...o }); } catch (e) { return e; } return null; };
    it('true for a pre-spawn failure (lane checkout, unreadable brief) — spawn is never reached', () => {
      const spawnAgent = vi.fn();
      expect(noInspectionStarted(caught({ root: '/x/.lanes/web-everything/lane-9', spawnAgent }))).toBe(true);
      expect(noInspectionStarted(caught({ readBrief: () => { throw new Error('ENOENT brief'); }, spawnAgent }))).toBe(true);
      expect(spawnAgent).not.toHaveBeenCalled();
    });
    it('true for a spawn refused before `claude` ran (ENOENT / EACCES)', () => {
      for (const code of ['ENOENT', 'EACCES']) {
        const e = caught({ spawnAgent: () => { throw Object.assign(new Error(`spawn claude ${code}`), { code }); } });
        expect(noInspectionStarted(e), code).toBe(true);
      }
    });
    it('FALSE for a timeout or a non-zero exit — the session may already exist', () => {
      expect(noInspectionStarted(caught({ spawnAgent: () => { throw Object.assign(new Error('t'), { code: 'ETIMEDOUT' }); } }))).toBe(false);
      expect(noInspectionStarted(caught({ spawnAgent: () => { throw Object.assign(new Error('exit 1'), { status: 1 }); } }))).toBe(false);
    });
  });
});
