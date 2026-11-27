import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../dispatch-lane-io.mjs');
  vi.doUnmock('../review-job-store.mjs');
  vi.doUnmock('../codex-delivery-provider.mjs');
  vi.doUnmock('../../dev/active-progress-watch.mjs');
  vi.doUnmock('../completion-store.mjs');
  vi.doUnmock('../../codex-direct-task.mjs');
  vi.doUnmock('../agent-activity-io.mjs');
  vi.doUnmock('../heavy-queue-io.mjs');
});

it('imports the live-work collector before the activity-reader binding initializes', async () => {
  let initialized = false;
  const read = vi.fn(() => ({ rows: [] }));
  const createReader = vi.fn(() => read);
  const unexpected = () => { throw new Error('Unexpected host IO'); };
  vi.doMock('../agent-activity-io.mjs', () => ({
    get createAgentActivityReader() {
      if (!initialized) throw new ReferenceError('Activity reader is not initialized');
      return createReader;
    },
  }));
  vi.doMock('../heavy-queue-io.mjs', () => ({ collectHeavyQueue: unexpected }));
  vi.doMock('../review-job-store.mjs', () => ({ pidAlive: unexpected }));
  const { createLiveWorkCollector } = await import('../live-work-io.mjs');
  const collect = createLiveWorkCollector({
    now: () => 1_800_000_000_000, collectQueue: () => ({ held: [], waiting: [] }),
    isAlive: unexpected, stat: unexpected,
  });
  expect(createReader).not.toHaveBeenCalled();
  initialized = true;
  collect({});
  expect(read).toHaveBeenCalledOnce();
});

it('constructs the import-time reader before dispatch REPO_ROOT initializes, then uses the initialized root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-activity-init-'));
  let initialized = false;
  const run = vi.fn(() => '{"lanes":[]}');
  const unexpected = () => { throw new Error('Unexpected host IO'); };
  vi.doMock('../dispatch-lane-io.mjs', () => ({
    get REPO_ROOT() {
      if (!initialized) throw new ReferenceError('Cannot access REPO_ROOT before initialization');
      return root;
    },
    defaultListAgents: unexpected,
  }));
  vi.doMock('../review-job-store.mjs', () => ({
    listAgentsWithReviewJobs: ({ listAgents }) => listAgents(),
    REVIEW_JOB_KIND: 'review-job', jobLogPath: unexpected,
  }));
  vi.doMock('../codex-delivery-provider.mjs', () => ({ CODEX_THREAD_DIR_NAME: 'threads' }));
  vi.doMock('../../dev/active-progress-watch.mjs', () => ({ BACKLOG_VERB_RE: /claim/ }));
  vi.doMock('../completion-store.mjs', () => ({ resolveCompletionsDir: unexpected, tryReadCompletion: unexpected }));
  vi.doMock('../../codex-direct-task.mjs', () => ({ resolveCodexHome: unexpected }));
  try {
    const { createAgentActivityReader } = await import('../agent-activity-io.mjs');
    const read = createAgentActivityReader({
      exec: unexpected, listAgents: () => [], readJobs: () => new Map(), run,
      projectsDir: join(root, 'projects'), completionsDir: join(root, 'completions'),
      codexHome: join(root, 'codex'), now: () => 1_800_000_000_000,
    });
    expect(run).not.toHaveBeenCalled();
    initialized = true;
    expect(read().rows).toEqual([]);
    expect(run).toHaveBeenCalledWith(process.execPath, [join(root, 'scripts', 'lane-pool.mjs'), 'status', '--json', '--leased-only'],
      expect.objectContaining({ cwd: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
