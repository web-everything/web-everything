// CLI fixtures inject the readCwds seam without probing host processes or adding a production override.
const loader = `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/lane-lease-liveness.mjs')) {
    const actual = JSON.stringify(url + '?actual');
    return { format: 'module', shortCircuit: true, source:
      'export { journalLiveProcessRefusal } from ' + actual + ';' +
      'import { staleTakeoverHasLiveProcesses as probe } from ' + actual + ';' +
      'export const staleTakeoverHasLiveProcesses = (dir, options) => probe(dir, { ...options, readCwds: () => [] });'
    };
  }
  return nextLoad(url, context);
}`;
const preload = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});`;
export const emptyCwdsArgs = [`--import=data:text/javascript,${encodeURIComponent(preload)}`];
