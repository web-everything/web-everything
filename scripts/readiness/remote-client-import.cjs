/** Native command-only loader, required lazily by admission. Keep the computed import outside daemon closures. */
exports.importRemoteClient = async function importRemoteClient(specifier) {
  return import(specifier);
};
