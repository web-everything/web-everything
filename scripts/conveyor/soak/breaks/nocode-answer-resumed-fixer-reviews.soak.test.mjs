import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: mkdtempSync(join(tmpdir(), 'nocode-reviews-')) };
});
vi.mock('node:os', async original => ({ ...await original(),
  homedir: () => fixture.root, tmpdir: () => fixture.root, userInfo: () => ({ homedir: fixture.root }),
}));
vi.mock('../../../lib/settings-files.mjs', async original => ({ ...await original(), readSettings: () => ({}) }));
vi.mock('../../../lib/github-app-identity.mjs', async original => ({ ...await original(),
  readBotLogins: () => ['web-everything'],
}));
vi.mock('../../../lib/policy-cascade.mjs', async original => ({ ...await original(),
  readPlatformPreferences: () => ({ prefs: {}, errors: [] }), platformPreference: () => undefined,
}));

import b from './nocode-answer-resumed-fixer.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import reviewContract from '../../../lib/review-policy.contract.json';
import routingPolicy from '../../../lib/dispatch-routing-policy.json';
import providerCapacity from '../../../settings/provider-capacity.json';
import cardBatchPolicy from '../../../lib/card-batch-policy.json';
import reviewSeeds from '../../../review-precedents.seeds.json';
import workerResultSchema from '../../../../schemas/worker-result.v1.json';
import sweptRepos from '../../../lib/swept-repos.json';

beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(fixture.root);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

async function replay(snapshot = {}) {
  const dir = mkdtempSync(join(fixture.root, 'case-'));
  try {
    const head = 'a'.repeat(40);
    const comment = (id, body) => ({ id, body, author: { login: 'web-everything' } });
    const claim = id => comment(id, `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/fixture\` at \`${head}\``);
    const fixturePath = join(dir, 'thread.json');
    writeFileSync(fixturePath, JSON.stringify({ liveHead: head, comments: [
      comment('verdict', `🔁 review — changes requested\n<!-- reviewed-sha: ${head} -->`),
      claim('initial'), comment('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head })),
      comment('replaced-answer', 'Replaced by the real answer producer.'), claim('resume'),
    ] }));
    const deniedFile = join(dir, 'denied.jsonl');
    const preload = join(dir, 'ports.mjs');
    const contractFile = join(dir, 'review-policy.contract.json');
    writeFileSync(contractFile, JSON.stringify(reviewContract));
    const routingFile = join(dir, 'dispatch-routing-policy.json');
    writeFileSync(routingFile, JSON.stringify(routingPolicy));
    const capacityFile = join(dir, 'provider-capacity.json');
    writeFileSync(capacityFile, JSON.stringify(providerCapacity));
    const batchFile = join(dir, 'card-batch-policy.json');
    writeFileSync(batchFile, JSON.stringify(cardBatchPolicy));
    const seedsFile = join(dir, 'review-precedents.seeds.json');
    writeFileSync(seedsFile, JSON.stringify(reviewSeeds));
    const schemaFile = join(dir, 'worker-result.v1.json');
    writeFileSync(schemaFile, JSON.stringify(workerResultSchema));
    const reposFile = join(dir, 'swept-repos.json');
    writeFileSync(reposFile, JSON.stringify(sweptRepos));
    // Keep production code imports, but route settings to fixture data and reject host data reads.
    writeFileSync(preload, String.raw`import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
const root = ${JSON.stringify(fixture.root)}, denied = ${JSON.stringify(deniedFile)};
const read = fs.readFileSync, list = fs.readdirSync;
const inside = path => path === root || path.startsWith(root + sep);
const pathOf = value => resolve(value instanceof URL ? fileURLToPath(value) : String(value));
const refuse = path => { fs.appendFileSync(denied, JSON.stringify(path) + '\n'); throw Error('unported fixture read: ' + path); };
fs.readFileSync = (value, ...args) => {
  if (typeof value === 'number') return read(value, ...args);
  const path = pathOf(value);
  if (path.endsWith('/scripts/lib/review-policy.contract.json')) return read(${JSON.stringify(contractFile)}, ...args);
  if (path.endsWith('/scripts/lib/dispatch-routing-policy.json')) return read(${JSON.stringify(routingFile)}, ...args);
  if (path.endsWith('/scripts/settings/provider-capacity.json')) return read(${JSON.stringify(capacityFile)}, ...args);
  if (path.endsWith('/scripts/lib/card-batch-policy.json')) return read(${JSON.stringify(batchFile)}, ...args);
  if (path.endsWith('/scripts/review-precedents.seeds.json')) return read(${JSON.stringify(seedsFile)}, ...args);
  if (path.endsWith('/schemas/worker-result.v1.json')) return read(${JSON.stringify(schemaFile)}, ...args);
  if (path.endsWith('/scripts/lib/swept-repos.json')) return read(${JSON.stringify(reposFile)}, ...args);
  if (['/scripts/dispatch-settings.json', '/scripts/lib/delivery-priority-settings.json',
    '/scripts/lib/delivery-platform-preferences.json', '/scripts/settings/fix-executor.json',
    '/scripts/drain-gate-settings.json', '/scripts/settings/gh-throttle.json',
    '/scripts/settings/human-clearance-carry.json']
    .some(suffix => path.endsWith(suffix))) {
    return args[0] ? '{}' : Buffer.from('{}');
  }
  if (!inside(path) && !path.includes('/node_modules/') && !/\.(?:[cm]?js|node)$/.test(path)
    && !path.endsWith('/package.json')) return refuse(path);
  return read(value, ...args);
};
fs.readdirSync = (value, ...args) => {
  const path = pathOf(value);
  if (path.endsWith('/scripts/settings')) return [];
  if (!inside(path)) return refuse(path);
  return list(value, ...args);
};
const ClockDate = Date;
globalThis.Date = class extends ClockDate {
  constructor(...args) { super(...(args.length ? args : [1800000000000])); }
  static now() { return 1800000000000; }
};
os.homedir = () => root;
os.userInfo = () => ({ username: 'fixture', homedir: root, uid: 1000, gid: 1000, shell: '/fixture' });
syncBuiltinESMExports();
`);
    const observed = [];
    const report = await b.run({ caseName: 'nocode-resume-rearms', fixturePath, env: {}, ...snapshot,
      spawn: (command, args, options) => {
        expect(options.cwd.startsWith(fixture.root + '/')).toBe(true);
        const state = JSON.parse(readFileSync(options.env.SOAK_STATE, 'utf8'));
        const child = spawnSync(command, ['--import', preload, ...args], {
          ...options, env: { ...options.env, PATH: options.cwd },
        });
        expect(child.error).toBeUndefined();
        observed.push({ state, status: child.status, stdout: child.stdout });
        return child;
      },
    });
    expect(existsSync(deniedFile) ? readFileSync(deniedFile, 'utf8') : '').toBe('');
    expect(observed).toHaveLength(1);
    return { report, ...observed[0] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it('models the reviews array requested by production gh pr view in every fake PR snapshot', async () => {
  const result = await replay();
  expect(result.state.reviews).toEqual([]);
  expect(b.judge(result.report)).toEqual([]);
}, 120000);

it.each([
  ['missing', undefined],
  ['changes requested', [{ state: 'CHANGES_REQUESTED' }]],
  ['oversized', Array.from({ length: 1001 }, () => ({ state: 'APPROVED' }))],
])('soak judge detects a refused no-code resume with %s reviews, without labels or a re-arm marker', async (_name, reviews) => {
  const result = await replay({ reviews });
  expect(result.state.reviews).toEqual(reviews);
  expect(result.status).toBe(1);
  expect(result.stdout, JSON.stringify(result.report)).toContain('formal reviews unreadable, oversized or still hold the repair');
  expect(result.report.reports[0]).toMatchObject({ labelWrites: 0, markers: 0, noChange: 1 });
  expect(b.judge(result.report)).toEqual(expect.arrayContaining([
    expect.stringContaining('formal reviews unreadable, oversized or still hold the repair'),
  ]));
}, 120000);
