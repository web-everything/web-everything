/**
 * @file daemon-soak-scope.test.mjs — proves `daemon-soak-scope.mjs`'s exported pattern (a) behaves the way
 * `.github/workflows/ci.yml`'s "Does this PR touch daemon code?" grep step intends, and (b) is byte-identical
 * to that step's own embedded pattern, so any future hand-edit to either copy without the other reddens here
 * immediately rather than silently drifting (see that module's header comment for why the two can't literally
 * share one string: ci.yml's step runs as plain bash before `npm ci`, so it cannot `import` this file).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { DAEMON_SOAK_SCOPE_SOURCE, DAEMON_SOAK_SCOPE_PATTERN, isDaemonSoakScopePath, touchesDaemonSoakScope } from '../daemon-soak-scope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI_YML = join(HERE, '..', '..', '..', '.github', 'workflows', 'ci.yml');

describe('daemon-soak-scope', () => {
  it('matches paths the daemon-soak job is meant to catch', () => {
    expect(isDaemonSoakScopePath('scripts/conveyor/soak/breaks/index.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('skills-src/conveyor/SKILL.md')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/lib/daemon-rebuild.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/lib/gh-app-shim.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/lib/main-staleness.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/lane-pool.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/lane-pool-anything.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/review-set-label.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/operations/reconcile-dispatch.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('scripts/operations/fix-dispatch-cli.mjs')).toBe(true);
    expect(isDaemonSoakScopePath('vitest.soak.config.ts')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(isDaemonSoakScopePath('src/_data/blocks.json')).toBe(false);
    expect(isDaemonSoakScopePath('docs/agent/backlog-workflow.md')).toBe(false);
    expect(isDaemonSoakScopePath('scripts/backlog.mjs')).toBe(false);
    // scripts/review-set-label.mjs is anchored with a trailing $ — a same-prefix sibling must not match.
    expect(isDaemonSoakScopePath('scripts/review-set-label-extra.mjs')).toBe(false);
    // scripts/operations/*dispatch*$ requires the dispatch token AND no further path segment.
    expect(isDaemonSoakScopePath('scripts/operations/dispatch/nested.mjs')).toBe(false);
  });

  it('touchesDaemonSoakScope is true if ANY path in the list matches', () => {
    expect(touchesDaemonSoakScope(['README.md', 'scripts/lib/daemon-rebuild.mjs'])).toBe(true);
    expect(touchesDaemonSoakScope(['README.md', 'package.json'])).toBe(false);
    expect(touchesDaemonSoakScope([])).toBe(false);
    expect(touchesDaemonSoakScope(undefined)).toBe(false);
  });

  it('is byte-identical to the pattern embedded in ci.yml\'s "Does this PR touch daemon code?" step', () => {
    const ciYml = readFileSync(CI_YML, 'utf8');
    const m = /grep -E '(\^\(skills-src\/conveyor.*?\))'/.exec(ciYml);
    expect(m, 'expected to find the daemon-soak scope grep -E pattern in ci.yml — has that step moved or been reworded?').toBeTruthy();
    expect(m[1]).toBe(DAEMON_SOAK_SCOPE_SOURCE);
  });

  it('DAEMON_SOAK_SCOPE_PATTERN is constructed from DAEMON_SOAK_SCOPE_SOURCE', () => {
    // `.source` escapes `/` to `\/` (the spec's EscapeRegExpPattern, so the source could round-trip inside a
    // `/…/` literal) — compare against a freshly-built RegExp's `.source`, not the raw string, to avoid a false
    // mismatch on that escaping alone.
    expect(DAEMON_SOAK_SCOPE_PATTERN.source).toBe(new RegExp(DAEMON_SOAK_SCOPE_SOURCE).source);
  });
});

// Execute the actual workflow shell with stubbed git output: the PR adds a card while main
// advances daemon code, and checkout's synthetic merge is distinct from the event's PR head.
const scopeJob = yaml.load(readFileSync(CI_YML, 'utf8')).jobs['daemon-soak-scope'];
const scopeStep = scopeJob.steps.find((step) => step.id === 'scope');
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function runScope({ event = 'pull_request', files = 'backlog/new-card.md', endpointFiles = 'scripts/conveyor/main-only.mjs', renamed = false, gitFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'we-daemon-scope-'));
  const output = join(root, 'output');
  const values = {
    'github.event_name': event,
    'github.event.pull_request.base.sha': baseSha,
    'github.event.pull_request.head.sha': headSha,
  };
  const substitute = (value) => String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`unmodelled workflow expression: ${key}`);
    return values[key];
  });
  const script = `
    git() {
      if [ "$SCOPE_GIT_FAILS" = true ]; then return 128; fi
      case " $* " in
        *" $SCOPE_RANGE "*)
          case " $* " in
            *" --no-renames "*) printf '%s\\n' "$SCOPE_FILES" ;;
            *) printf '%s\\n' "$SCOPE_RENAME_FILES" ;;
          esac ;;
        *) printf '%s\\n' "$SCOPE_ENDPOINT_FILES" ;;
      esac
    }
    ${substitute(scopeStep.run)}
  `;
  try {
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(scopeStep.env ?? {}).map(([key, value]) => [key, substitute(value)])),
        GITHUB_OUTPUT: output,
        SCOPE_RANGE: `${baseSha}...${headSha}`,
        SCOPE_FILES: files,
        SCOPE_RENAME_FILES: renamed ? 'backlog/moved-code.md' : files,
        SCOPE_ENDPOINT_FILES: endpointFiles,
        SCOPE_GIT_FAILS: String(gitFails),
      },
    });
    return { ...result, output: result.status === 0 ? readFileSync(output, 'utf8').trim() : '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('daemon-soak scope workflow uses the PR contribution', () => {
  it('skips a card-only PR despite daemon changes on its divergent base', () => {
    const result = runScope();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('run=false');
  });

  it('runs for daemon edits at the PR head even if the synthetic merge has no endpoint change', () => {
    const result = runScope({ files: 'scripts/conveyor/pr-edit.mjs', endpointFiles: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('run=true');
  });

  it('runs when daemon code is moved outside daemon scope', () => {
    const result = runScope({ files: 'scripts/conveyor/moved.mjs\nbacklog/moved-code.md', endpointFiles: '', renamed: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('run=true');
  });

  it('fails closed when the PR diff cannot be resolved', () => {
    const result = runScope({ gitFails: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it.each(['push', 'merge_group', 'workflow_dispatch'])('always runs on %s without resolving a PR diff', (event) => {
    const result = runScope({ event, gitFails: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('run=true');
  });
});
