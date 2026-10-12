/**
 * Pure backlog ID setting resolution (#4985). No config-file loading or enforcement here.
 * Defaults and built values mirror config/platformDefaults.ts; config tests pin both copies.
 */
export const BACKLOG_ID_DEFAULTS = Object.freeze({
  backlogIdNumbering: 'producer-at-pr-open',
  backlogIdReach: 'tip-tree',
});

export const BACKLOG_ID_BUILT_VALUES = Object.freeze({
  backlogIdNumbering: Object.freeze(['producer-at-pr-open']),
  backlogIdReach: Object.freeze(['tip-tree']),
});

const DECLARED_VALUES = Object.freeze({
  backlogIdNumbering: Object.freeze(['producer-at-pr-open', 'integration-branch']),
  backlogIdReach: Object.freeze(['tip-tree', 'full-history-squash']),
});

function describeValue(value) {
  let text;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = `[unserializable ${typeof value}]`;
  }
  return text.replace(/[`\r\n\u2028\u2029]/g, ' ');
}

function refuse(dimension, refusal, value) {
  return {
    ok: false,
    refusal,
    value,
    reason: `${describeValue(dimension)}: ${refusal} ${describeValue(value)}`,
  };
}

/**
 * Resolve one dimension independently. Only an absent key selects the platform default.
 * Declared bare strings are inline values; other strings are unreadable file pointers.
 * A descriptor selects its override (when defined), otherwise its nearest flavor only.
 *
 * @param {'backlogIdNumbering'|'backlogIdReach'} dimension
 * @param {object} config In-memory project config; no files are read.
 * @returns {{ok: true, value: string}|{ok: false, refusal: string, value: unknown, reason: string}}
 */
export function resolveBacklogIdSetting(dimension, config) {
  if (!Object.hasOwn(DECLARED_VALUES, dimension)) {
    return refuse(dimension, 'unreadable-entry', dimension);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return refuse(dimension, 'unreadable-entry', config);
  }
  if (!Object.hasOwn(config, dimension)) {
    return { ok: true, value: BACKLOG_ID_DEFAULTS[dimension] };
  }

  const entry = config[dimension];
  let value = entry;
  if (typeof entry === 'string') {
    if (!DECLARED_VALUES[dimension].includes(entry)) {
      return refuse(dimension, 'unreadable-entry', entry);
    }
  } else if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return refuse(dimension, 'unreadable-entry', entry);
  } else if (entry.kind === 'extends-flavor' && Array.isArray(entry.flavors)) {
    value = entry.overrides !== undefined ? entry.overrides : entry.flavors[0];
  }

  if (!DECLARED_VALUES[dimension].includes(value)) {
    return refuse(dimension, 'unknown-value', value);
  }
  if (!BACKLOG_ID_BUILT_VALUES[dimension].includes(value)) {
    return refuse(dimension, 'unbuilt-value', value);
  }
  return { ok: true, value };
}
