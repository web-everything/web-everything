import { beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(ROOT, 'scripts', 'progress-board.mjs');
const NOW = '2026-08-08T12:00:00.000Z';
process.env.WE_BOARD_NOW = NOW; // freeze the stamp for the in-process `renderPage` cases too

const sandbox = mkdtempSync(join(tmpdir(), 'progress-board-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

let statePath;
let outPath;
let seq = 0;

const SEED = {
  title: 'Test board',
  repo: 'web-everything/web-everything',
  artifactUrl: null,
  phases: { 1: 'First' },
  items: [
    { id: 'alpha', title: 'Alpha', phase: 1, status: 'todo' },
    { id: 'beta', title: 'Beta', phase: 1, status: 'in-progress', pr: 1099 },
  ],
  // Complete on purpose: the board REFUSES to render an `awaiting` decision that cannot be answered from the
  // page, so a seed with a bare title would fail every CLI case here for the wrong reason.
  decisions: [
    {
      id: '2978',
      title: 'A decision',
      status: 'awaiting',
      question: 'Do we take the decision?',
      options: [
        { label: 'Yes', detail: 'take it', recommended: true },
        { label: 'No', detail: 'leave it' },
      ],
      ifNothing: 'nothing moves',
    },
  ],
};

beforeEach(() => {
  seq += 1;
  statePath = join(sandbox, `state-${seq}.json`);
  outPath = join(sandbox, `board-${seq}.html`);
  writeFileSync(statePath, JSON.stringify(SEED, null, 2));
});

/** Run the real CLI. Never throws — exit code + stdout are the assertion surface. */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${outPath}`, '--no-gh', ...args], {
    encoding: 'utf8',
    env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
const page = () => readFileSync(outPath, 'utf8');

const pr = (over = {}) => ({
  number: 1,
  title: 'A pull request',
  state: 'OPEN',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  labels: [],
  ...over,
  labels: (over.labels ?? []).map((name) => ({ name })),
});

// ── The derivation ────────────────────────────────────────────────────────────

export { ROOT, CLI, NOW, sandbox, statePath, outPath, SEED, cli, state, page, pr };
