import { describe, expect, it, vi } from 'vitest';

// Keep the real REST reader and response normalization. Replace only its transport,
// so a regression cannot make a network call or require access to longshore.
const transport = vi.hoisted(() => ({ calls: [], deniedRepo: 'longshoreai/longshore', status: 404 }));
vi.mock('../../../scripts/conveyor/open-pr-fetch.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOpenPrsRest: (options) => actual.fetchOpenPrsRest({
      ...options,
      env: { WE_GH_ETAG_CACHE: '0' },
      exec: (_command, args) => {
        const endpoint = args.find(arg => arg.startsWith('repos/'));
        transport.calls.push(endpoint);
        if (endpoint.startsWith(`repos/${transport.deniedRepo}/`)) {
          throw Object.assign(new Error(`gh: HTTP ${transport.status}`), { stderr: `gh: HTTP ${transport.status}` });
        }
        return JSON.stringify(endpoint.includes('/files?')
          ? [{ filename: 'src/already-building.mjs' }]
          : [{ number: 6910, head: { ref: 'lane/existing-build' }, labels: [], body: '', draft: false }]);
      },
    }),
  };
});

import { cliFetchOpenPrs, runBuildDispatchTick } from '../build-dispatch-daemon.mjs';
import { BUILD_DISPATCH_POLICY } from '../../../scripts/conveyor/build-dispatch-policy.mjs';

describe('build-dispatch open-PR capability boundary', () => {
  it.each([403, 404])('continues build selection without reading longshore when it would return HTTP %s', async (status) => {
    transport.calls = [];
    transport.deniedRepo = 'longshoreai/longshore';
    transport.status = status;
    let snapshot;
    const out = await runBuildDispatchTick({
      live: false,
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 1 },
      effects: {
        planTick: () => ({
          decisions: {
            counts: { building: 1, buildingInFlight: 0 },
            spawnBuilds: [{ num: '9001', lane: 15 }],
            admission: {
              queue: [{ num: '9001', scope: ['we:src/new-build.mjs'] }],
              cleared: [{ num: '9001', ready: true }],
            },
          },
          nextState: {},
        }),
        fetchOpenPrs: async () => (snapshot = await cliFetchOpenPrs()),
        listClaims: () => [],
        listRunStoreInFlight: () => [],
        killSwitch: () => ({ engaged: false }),
      },
    });
    expect(out.plan.dispatch.map(row => row.num)).toEqual(['9001']);
    expect(snapshot.map(row => row.repo)).toEqual(['we', 'frontierui', 'plateau-app']);
    expect(snapshot.every(row => row.prs[0].files[0].path === 'src/already-building.mjs')).toBe(true);
    expect(transport.calls).toHaveLength(6); // pulls + files for each build-capable repo
    expect(transport.calls.some(endpoint => endpoint.includes('/longshore/'))).toBe(false);
  });

  it('still rejects unreadable PR evidence from a build-capable repo', async () => {
    transport.calls = [];
    transport.deniedRepo = 'frontier-ui/frontierui';
    transport.status = 403;
    await expect(cliFetchOpenPrs()).rejects.toThrow('HTTP 403');
    expect(transport.calls.some(endpoint => endpoint.includes('/frontierui/'))).toBe(true);
  });
});
