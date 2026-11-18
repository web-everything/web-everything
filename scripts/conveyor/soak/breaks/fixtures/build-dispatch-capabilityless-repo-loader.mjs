/** Transport-only ESM hook for the offline build-dispatch soak child process. */
const target = new URL('../../../open-pr-fetch.mjs', import.meta.url).href;

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url !== target) return loaded;
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  return {
    ...loaded,
    source: `${source}
      // Preserve the real REST pagination and response normalization. Only the
      // process transport is replaced, for both the pre-fix and fixed daemon.
      export const buildDispatchSoakCalls = [];
      let buildDispatchSoakStatus;
      export function resetBuildDispatchSoakTransport(status) {
        buildDispatchSoakCalls.length = 0;
        buildDispatchSoakStatus = status;
      }
      const realBuildDispatchFetch = fetchOpenPrsRest;
      fetchOpenPrsRest = (options) => realBuildDispatchFetch({
        ...options,
        env: { WE_GH_ETAG_CACHE: '0' },
        exec: (_command, args) => {
          const endpoint = args.find(arg => arg.startsWith('repos/'));
          buildDispatchSoakCalls.push(endpoint);
          if (endpoint.startsWith('repos/longshoreai/longshore/')) {
            const message = 'gh: HTTP ' + buildDispatchSoakStatus;
            throw Object.assign(new Error(message), { stderr: message });
          }
          return JSON.stringify(endpoint.includes('/files?')
            ? [{ filename: 'src/already-building.mjs' }]
            : [{ number: 6910, head: { ref: 'lane/existing-build' }, labels: [], draft: false }]);
        },
      });
    `,
  };
}
