/**
 * @file skills-src/conveyor/__tests__/fix-brief-gate-command.test.mjs
 * @description Brief-lint (#4369): every verify-lane command a fix / ci-heal brief tells its agent to run must be
 *   one the agent's own guard permits for that dispatch kind, and step 4 must key its red branch to the `check`
 *   output. Fails if a brief names a command `dispatchedAgentVerificationReason` denies.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dispatchedAgentVerificationReason } from '../../../scripts/guard-bash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fill(text) {
  return text.replace(/\{\{WE_ROOT\}\}/g, '/we').replace(/\{\{GATE_COMMAND\}\}/g, 'node /we/scripts/verify-lane.mjs run --repo=.');
}

function fencedCommands(text) {
  const cmds = [];
  for (const m of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of m[1].split('\n')) {
      const cmd = line.replace(/\s+#.*$/, '').trim();
      if (cmd) cmds.push(cmd);
    }
  }
  return cmds;
}

for (const [file, kind] of [['fix-agent-brief.md', 'fix'], ['fix-agent-ci-brief.md', 'ci-heal']]) {
  describe(`${file} — gate commands vs the ${kind} guard`, () => {
    const filled = fill(readFileSync(join(HERE, '..', file), 'utf8'));
    const gateLines = fencedCommands(filled).filter((c) => /verify-lane|test:unit|heavy-admission/.test(c));

    it('names a verify-lane request and hands the wait to the harness (#5137) in its bash fences', () => {
      expect(gateLines.some((c) => /verify-lane\.mjs request\b/.test(c))).toBe(true);
      const marks = fencedCommands(filled).filter((c) => /conveyor\/await-verify\.mjs mark\b/.test(c));
      expect(marks).toHaveLength(1);
      // The record must name the PR's own lane ref and this brief's kind, or the harness cannot push or resume it.
      expect(marks[0]).toContain('--ref={{LANE_REF}}');
      expect(marks[0]).toContain(`--kind=${kind}`);
      expect(marks[0]).toContain('--who={{SESSION_SLUG}}');
      expect(marks[0]).toContain('--attempt=1');
    });

    it('never tells the agent to hold its turn on a blocking check or to push the PR ref itself (#5137)', () => {
      expect(filled).not.toMatch(/check --wait=\d+/);
      expect(fencedCommands(filled).some((c) => /git push origin HEAD:refs\/heads\/\{\{LANE_REF\}\}$/.test(c))).toBe(false);
      expect(filled).toMatch(/\*\*end your turn\*\*/);
    });

    it('no gate/verify command in a bash fence is denied for this kind', () => {
      for (const c of gateLines) expect(dispatchedAgentVerificationReason(c, kind), c).toBeNull();
    });

    it('keys the red branch to the `check` output, not the request call', () => {
      const step4 = filled.split(/### 4\./)[1].split(/### 5\./)[0];
      expect(step4).toMatch(/`check` output/);
      expect(step4).toMatch(/`red` \(exit 2\)/);
    });
  });
}

// #34 — a description-only ci-heal re-runs the check instead of queuing a full local verify.
describe('fix-agent-ci-brief.md — metadata-only heal skips the local verify (#34)', () => {
  const brief = readFileSync(join(HERE, '..', 'fix-agent-ci-brief.md'), 'utf8');
  const rule = brief.split('**Metadata-only skip (#34).**')[1];
  it('skips the gate only when HEAD is the examined commit with a clean tree, and re-runs the failed check', () => {
    expect(rule, 'metadata-only skip rule present').toBeTruthy();
    const para = rule.split('\n\n')[0];
    expect(para).toMatch(/skip steps 4-6/);
    expect(para).toContain('gh run rerun');
    expect(para).toContain('--outcome=healed');
    expect(para).toMatch(/merge[^.]*NOT metadata-only/);
  });

  // Behavioural: run the brief's own predicate against real repos in each state a step-3 repair can leave.
  const predicate = rule && /```bash\n\s*([^\n]+)\n\s*```/.exec(rule)?.[1];
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const skips = (cwd, examined) => spawnSync('bash', ['-c', predicate], { cwd, env: { ...process.env, EXAMINED_HEAD: examined } }).status === 0;
  const withRepo = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-skip-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@example.com');
      git(dir, 'config', 'user.name', 't');
      git(dir, 'config', 'commit.gpgsign', 'false');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git(dir, 'add', 'a.txt');
      git(dir, 'commit', '-qm', 'base');
      fn(dir, git(dir, 'rev-parse', 'HEAD'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('predicate: skips when nothing changed since the examined head', () => {
    expect(predicate, 'predicate fence present').toBeTruthy();
    withRepo((dir, head) => expect(skips(dir, head)).toBe(true));
  });
  it('predicate: does not skip on an uncommitted edit, staged edit, or untracked file', () => {
    withRepo((dir, head) => {
      writeFileSync(join(dir, 'a.txt'), 'changed\n');
      expect(skips(dir, head), 'unstaged edit').toBe(false);
      git(dir, 'add', 'a.txt');
      expect(skips(dir, head), 'staged edit').toBe(false);
      git(dir, 'checkout', '-q', 'HEAD', '--', 'a.txt');
      expect(skips(dir, head), 'clean again').toBe(true);
      writeFileSync(join(dir, 'new.txt'), 'x\n');
      expect(skips(dir, head), 'untracked file').toBe(false);
    });
  });
  it('predicate: does not skip on a new commit, even one with the same tree (a same-tree merge)', () => {
    withRepo((dir, head) => {
      git(dir, 'checkout', '-q', '-b', 'side');
      writeFileSync(join(dir, 'b.txt'), 'b\n');
      git(dir, 'add', 'b.txt');
      git(dir, 'commit', '-qm', 'side');
      git(dir, 'revert', '--no-edit', 'HEAD');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '--no-ff', '--no-edit', 'side');
      expect(git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(git(dir, 'rev-parse', `${head}^{tree}`));
      expect(skips(dir, head)).toBe(false);
    });
  });
  it('does not add the skip to the code-fix brief', () => {
    expect(readFileSync(join(HERE, '..', 'fix-agent-brief.md'), 'utf8')).not.toContain('Metadata-only skip');
  });
});

// #5137 — the fix and ci-heal briefs hand the wait to the harness (asserted above); only the delivery brief still
// waits in bounded chunks itself.
for (const file of ['delivery-agent-brief.md']) {
  it(`${file} instructs bounded waits that are feasible inside the Bash tool's foreground timeout`, () => {
    const text = readFileSync(join(HERE, '..', file), 'utf8');
    const waits = [...text.matchAll(/check --wait=(\d+)/g)].map((m) => Number(m[1]));
    const toolTimeouts = [...text.matchAll(/`timeout: (\d+)`/g)].map((m) => Number(m[1]));
    expect(waits.length).toBeGreaterThan(0);
    expect(toolTimeouts.length).toBeGreaterThan(0);
    // A wait longer than the tool's own timeout is killed before it can settle: every instructed wait must fit.
    for (const wait of waits) expect(wait).toBeLessThan(Math.min(...toolTimeouts));
    // …and the chunks must cover the dispatcher's admission + execution budget (~160 minutes), stated in the brief.
    expect(text).toMatch(/18 consecutive `timeout`s/);
    expect(Math.max(...waits) * 18).toBeGreaterThanOrEqual(150 * 60_000);
    expect(text).not.toMatch(/--wait=9600000|--wait=60000|completion\s+notification/);
    expect(text).toContain('infrastructure-failure');
  });
}

const readBrief = (file) => readFileSync(join(HERE, '..', file), 'utf8');

/** The literals of `required` that `text` does not contain — the brief-lint core, mutation-checked below. */
const missing = (text, required) => required.filter((literal) => !text.includes(literal));

/**
 * Assert every literal is present in the real brief text, and that removing any ONE of them is detected — so each
 * guard is proven to redden on a mutated brief, not just to pass on today's wording.
 */
function expectEachGuarded(text, required) {
  expect(missing(text, required)).toEqual([]);
  for (const literal of required) expect(missing(text.replaceAll(literal, ''), required), `dropping "${literal}"`).toEqual([literal]);
}

const REVERIFY_WORKER = 'Only `web-everything/web-everything` has a reverify worker';

// The exit's three eligibility conditions (failures only outside the change, each passing alone, a repo that has a
// reverify worker) plus the tokens and the fallback — dropping any one tells an agent to hand off a genuinely failing
// change, or to wait on a worker that does not exist.
const LOAD_FLAKE_REQUIRED = {
  'fix-agent-brief.md': [
    'red ONLY on timeouts',
    'pass alone',
    REVERIFY_WORKER,
    'so use the gate-red exit below there',
    'FULL 40-character head sha',
    '--reason=load-flake',
    '--alt-sha=',
    'blocked-on-load-flake',
  ],
  'fix-agent-ci-brief.md': [
    'red ONLY on failures in files your heal did not touch',
    'each of those files passes when run alone',
    REVERIFY_WORKER,
    'for any other repo use the gate-red exit below',
    'FULL 40-character head sha',
    '--reason=load-flake',
    '--alt-sha=',
    'blocked-on-load-flake',
  ],
};

/** The "Load-flake exception." paragraph, up to its bash fence — so a literal elsewhere in the brief cannot satisfy a guard. */
function loadFlakeParagraph(text) {
  const start = text.indexOf('**Load-flake exception.**');
  expect(start, 'brief has a Load-flake exception paragraph').toBeGreaterThanOrEqual(0);
  const fence = text.indexOf('```bash', start);
  // indexOf -1 would make slice(start, -1) swallow the rest of the brief and void the isolation guarantee.
  expect(fence, 'Load-flake exception paragraph is followed by a bash fence').toBeGreaterThan(start);
  return text.slice(start, fence);
}

/** The load-flake exit's bash fence itself — the commands an agent actually runs, not the prose that describes them. */
function loadFlakeFence(text) {
  const start = text.indexOf('**Load-flake exception.**');
  const open = text.indexOf('```bash\n', start);
  expect(open, 'Load-flake exception paragraph is followed by a bash fence').toBeGreaterThan(start);
  const close = text.indexOf('```', open + 8);
  expect(close, 'Load-flake bash fence is closed').toBeGreaterThan(open);
  return text.slice(open, close);
}

// Every token the exit's commands need, each asserted inside the fence only: the same literals recur in the prose
// ("Report `blocked-on-load-flake`…") and in other exits, so a whole-brief `toContain` stays green when the fence loses one.
const LOAD_FLAKE_FENCE_REQUIRED = [
  'stand-down.mjs',
  '--reason=load-flake',
  '--head=<pr-head-sha>',
  '--alt=<saved-alt-branch>',
  '--alt-sha=<saved-sha>',
  '--outcome=blocked-on-load-flake',
  'fix-end',
];

describe('ci-heal load-flake exit', () => {
  for (const [file, required] of Object.entries(LOAD_FLAKE_REQUIRED)) {
    it(`${file} states every load-flake eligibility condition, each guarded against removal`, () => {
      const text = readBrief(file);
      const paragraph = loadFlakeParagraph(text);
      // Conditions live in the paragraph; the command tokens live in the fence that follows it.
      expectEachGuarded(paragraph, required.filter((l) => !/^(--|blocked-on)/.test(l)));
    });

    it(`${file} carries every load-flake command token inside its bash fence, each guarded against removal`, () => {
      expectEachGuarded(loadFlakeFence(readBrief(file)), LOAD_FLAKE_FENCE_REQUIRED);
    });
  }

  it('ci-heal load-flake exit precedes the gate-red exit and preserves the saved heal', () => {
    const text = readBrief('fix-agent-ci-brief.md');
    expect(text).toContain('--outcome=gate-red');
    expect(text.indexOf('--reason=load-flake')).toBeLessThan(text.indexOf('--outcome=gate-red'));
    expect(text).toContain('Otherwise a red gate is a hard stop');
    // The saved heal is what the reverify worker retries: the push target and the `--alt=` handoff must both survive.
    expect(text).toContain('--alt=<saved-alt-branch>');
    // The exit is only safe under its three eligibility conditions: this ordering test must redden if any is dropped,
    // not only the dedicated eligibility test above (the paragraph precedes the command, which precedes the hard stop).
    const paragraph = loadFlakeParagraph(text);
    expectEachGuarded(paragraph, [
      'files your heal did not touch',
      'passes when run alone',
      'push the heal to `{{LANE_REF}}-heal-{{PR_NUM}}-alt`',
      REVERIFY_WORKER,
    ]);
    // Order against the fence's own command, not the first stray mention of the flag elsewhere in the brief.
    const fenceAt = text.indexOf(loadFlakeFence(text));
    expect(text.indexOf(paragraph)).toBeLessThan(fenceAt);
    expect(fenceAt).toBeLessThan(text.indexOf('Otherwise a red gate is a hard stop'));
  });
});

// Each normative sentence's distinctive literal is asserted positively; a `not.toMatch` alone passes whether or not
// the sentence exists, so it can never be the guard.
const FIX_THE_CLASS_REQUIRED = [
  'Fix the class, not the instance',
  'Fix every variant inside `{{SCOPE}}`',
  'does the repair meet the reviewer\'s finding',
  'next variant',
  'is must-fix before re-push',
  'You may dismiss any other self-review finding only as "not the same class" or "outside `{{SCOPE}}` (filed as <card>)"',
  'filed through `file-item`',
  'does the repair itself introduce a new problem',
  'A defect the repair itself introduces is must-fix regardless of class',
  'Deferring ("later", "follow-up") is not a dismissal.',
  'Variants considered:',
];

describe('fix the class', () => {
  it('requires variant discovery, adversarial review, and evidence without deferral', () => {
    expectEachGuarded(readBrief('fix-agent-brief.md'), FIX_THE_CLASS_REQUIRED);
  });

  it('does not restore the old "fix it, or dismiss it with a one-line reason" loophole', () => {
    expect(readBrief('fix-agent-brief.md')).not.toMatch(/fix it, or dismiss it/i);
  });
});
