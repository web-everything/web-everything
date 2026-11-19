/** TT3 partitions the integration inventory; pool selection remains in the Vitest config. */
export const integrationGroups = Object.freeze(['scan-chain', 'sim-scenarios', 'parallel']);

export function integrationGroup(file) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (name === 'stdout-flush.test.mjs' || name === 'gate-entrypoint-integration.test.mjs'
    || /^rust-scan-.*-parity\.test\.mjs$/.test(name)) return 'scan-chain';
  // Include sim-clock too, so all sim files stay together if more acquire a forks pin.
  if (name.startsWith('sim-')) return 'sim-scenarios';
  return 'parallel';
}

export function integrationFilesForGroup(files, group) {
  if (group === undefined) return files;
  if (!integrationGroups.includes(group)) {
    throw new Error(`Unknown WE_INTEGRATION_GROUP: ${JSON.stringify(group)}; use ${integrationGroups.join(', ')} or unset it for all files.`);
  }
  return files.filter((file) => integrationGroup(file) === group);
}
