/** Delivery routing is data; callers inject the shared readSettings() reader. */
const table = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  return cfg;
}

export function loadDeliveryRoutes(readSettingsFn) {
  if (typeof readSettingsFn !== 'function') throw new TypeError('Delivery routes need a readSettings reader.');
  const { routes, modes, daemonDegradedModes } = readSettingsFn() ?? {};
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
