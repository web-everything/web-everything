/**
 * @file forge.capabilities port (ship/forge-adapter v0.1). An adapter declares, per interface, `native`,
 * `emulated` or `unsupported`. Core code asks `requireCapability` before a protected action; an unsupported or
 * undeclared interface returns a person-routed event, never a silent skip.
 */
export const SUPPORT_LEVELS = Object.freeze(['native', 'emulated', 'unsupported']);

/** @returns {{ok:true, support:string}|{ok:false, route:'person', event:object}} */
export function requireCapability(capabilities, name) {
  const support = capabilities?.[name]?.support;
  if (support === 'native' || support === 'emulated') return { ok: true, support };
  return {
    ok: false,
    route: 'person',
    event: { kind: 'capability-unsupported', interface: name, support: support || 'undeclared' },
  };
}
