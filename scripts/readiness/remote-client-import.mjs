/** Loads a host-selected module by file URL; isolated so only this tiny file holds a computed dynamic import. */
export async function importRemoteClient(specifier) {
  return import(specifier);
}
