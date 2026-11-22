/**
 * @file scripts/ci/dep-trace-loader.mjs
 * @description Node 22 module.register loader; sends loaded file URLs to the importing process.
 */
let port;
export function initialize(data) { port = data.port; }
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.startsWith('file:')) port?.postMessage(url);
  return result;
}
