/** Gates the importing tool's body. Tool dependencies must use dynamic imports in that body:
 * textual order among static sibling imports cannot delay their side effects across this await.
 */
import { guardToolCheckout } from './stale-tool-guard.mjs';

// Tests inject a check through this function; the production entry always uses the real guard.
export async function runToolCheckoutGuard({ check = guardToolCheckout, entry = process.argv[1] } = {}) {
  try {
    const status = await check({ entry });
    if (status !== undefined) process.exit(status);
  } catch (error) {
    console.error(String(error.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
    process.exit(1);
  }
}

await runToolCheckoutGuard();
