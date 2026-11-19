/** Delivery routing is data; callers inject the shared readSettingsChecked() reader. */
const table = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requiredDegradedModes = { 'daemon-tooling': 'debug-to-merge' };

function validate(cfg) {
  if (!table(cfg) || !table(cfg.routes) || !Object.keys(cfg.routes).length ||
      !table(cfg.modes) || !table(cfg.daemonDegradedModes)) {
    throw new Error('Delivery routes incomplete; restore scripts/settings/delivery-routes.json before dispatching.');
  }
  for (const rules of Object.values(cfg.modes)) {
    if (typeof rules !== 'string' || !rules.trim()) throw new Error('Delivery mode rules must be nonempty text.');
  }
  for (const [kind, mode] of [...Object.entries(cfg.routes), ...Object.entries(cfg.daemonDegradedModes)]) {
    if (!Object.hasOwn(cfg.routes, kind) || typeof mode !== 'string' || !Object.hasOwn(cfg.modes, mode)) {
      throw new Error(`Invalid delivery route for ${kind}; restore scripts/settings/delivery-routes.json before dispatching.`);
    }
  }
  for (const [kind, mode] of Object.entries(requiredDegradedModes)) {
    if (!Object.hasOwn(cfg.daemonDegradedModes, kind) || cfg.daemonDegradedModes[kind] !== mode) {
      throw new Error(`Delivery degraded route for ${kind} must be ${mode}; restore scripts/settings/delivery-routes.json before dispatching.`);
    }
  }
  return cfg;
}

export function loadDeliveryRoutes(readSettingsFn) {
  if (typeof readSettingsFn !== 'function') throw new TypeError('Delivery routes need a readSettingsChecked reader.');
  const evidence = readSettingsFn({ namespace: '' });
  if (!table(evidence) || !Array.isArray(evidence.taint) || !Array.isArray(evidence.duplicates)) {
    throw new Error('Delivery routes need checked settings evidence; repair the settings reader before dispatching.');
  }
  const duplicates = evidence.duplicates.filter(({ path }) =>
    ['routes', 'modes', 'daemonDegradedModes'].some(key => path === key || path.startsWith(`${key}.`)));
  // Only taint from our own file (or a duplicate leaf touching our keys) is ours to refuse; other features' layers
  // are not this setting's business.
  // An unreadable layer could own our keys, so it still refuses; only another file's dotted-key style is ignored.
  const taint = evidence.taint.filter(({ source, reason }) =>
    String(source).includes('delivery-routes') || reason !== 'dotted key');
  if (taint.length || duplicates.length) {
    throw new Error(`Delivery routes settings taint: ${JSON.stringify({ taint, duplicates })}; repair the named settings layers before dispatching.`);
  }
  const { routes, modes, daemonDegradedModes } = evidence.value ?? {};
  return validate({ routes, modes, daemonDegradedModes });
}

export function modeForKind(cfg, kind, { daemonDegraded = false } = {}) {
  validate(cfg);
  if (typeof kind !== 'string' || !Object.hasOwn(cfg.routes, kind)) {
    throw new Error(`Unknown delivery kind ${JSON.stringify(kind)}; choose a kind from scripts/settings/delivery-routes.json.`);
  }
  return daemonDegraded === true && Object.hasOwn(cfg.daemonDegradedModes, kind)
    ? cfg.daemonDegradedModes[kind] : cfg.routes[kind];
}

export function briefModeText(cfg, kind, opts) {
  const mode = modeForKind(cfg, kind, opts);
  return `Mode: ${mode}\n${cfg.modes[mode]}`;
}
