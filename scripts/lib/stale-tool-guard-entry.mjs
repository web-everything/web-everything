/** Gates the importing tool's body. Tool dependencies must use dynamic imports in that body:
 * textual order among static sibling imports cannot delay their side effects across this await.
 */
import { guardToolCheckout } from './stale-tool-guard.mjs';

// Vitest-spawned tool children run fixture checkouts with scrubbed PATH/env; vitest never exists in operator shells.
if (process.env.VITEST !== 'true') try {
  const status = await guardToolCheckout({ entry: process.argv[1] });
  if (status !== undefined) process.exit(status);
} catch (error) {
  console.error(String(error.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  process.exit(1);
}
