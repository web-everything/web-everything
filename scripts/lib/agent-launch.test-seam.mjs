/** Import-time seam: only a test loader's module substitution can supply a registry.
 * Production has no mutable registry or environment-controlled registration path.
 */
export function isAgentLaunchTestPrimitive() { return false; }

export function registerAgentLaunchTestPrimitive() {
  throw new TypeError('agent-launch test primitive registration requires import-time test module substitution');
}
