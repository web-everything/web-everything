/** Call before loading tool dependencies. Tests inject the check as a parameter;
 * no process environment value exempts a production invocation from validation.
 */
import { guardToolCheckout } from './stale-tool-guard.mjs';

export async function guardToolEntry({ check = guardToolCheckout } = {}) {
  try {
    const status = await check({ entry: process.argv[1] });
    if (status !== undefined) process.exit(status);
  } catch (error) {
    console.error(String(error.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
    process.exit(1);
  }
}
