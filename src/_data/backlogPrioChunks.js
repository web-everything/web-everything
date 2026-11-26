// One ordered prioritisation model for the inline preview and paginated row fragments.
const loadBacklog = require('./backlog.js');
const CHUNK_SIZE = 250;
function build(backlog) {
  const ranked = (predicate) => backlog.filter(predicate).sort((a, b) =>
    a.leverageScore < b.leverageScore ? 1 : a.leverageScore > b.leverageScore ? -1 : 0);
  const leverageItems = ranked(item => item.status === 'open');
  const activeDecisions = ranked(item => item.status === 'active' && item.kind === 'decision');
  const preparingDecisions = ranked(item => item.status === 'preparing');
  const activeBatchables = ranked(item => item.status === 'active' && item.activeBatchable === true);
  const tableRows = activeDecisions.concat(preparingDecisions, activeBatchables, leverageItems);
  const chunks = [];
  for (let offset = CHUNK_SIZE; offset < tableRows.length; offset += CHUNK_SIZE) {
    chunks.push({ url: `/backlog/prio-rows/${chunks.length + 1}.html`, rows: tableRows.slice(offset, offset + CHUNK_SIZE) });
  }
  return { leverageItems, activeDecisions, preparingDecisions, activeBatchables,
    tableRows, inline: tableRows.slice(0, CHUNK_SIZE), chunks, urls: chunks.map(chunk => chunk.url) };
}
module.exports = () => build(loadBacklog());
module.exports.build = build;
