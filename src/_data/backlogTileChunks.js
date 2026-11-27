// One ordered selection for the inline preview, facets, totals and paginated tile fragments.
const loadBacklog = require('./backlog.js');
const CHUNK_SIZE = 100;
function build(backlog) {
  function view(statusOrder, prefix) {
    const items = statusOrder.flatMap(status => backlog.filter(item => item.status === status));
    const chunks = [];
    for (let offset = CHUNK_SIZE; offset < items.length; offset += CHUNK_SIZE) {
      chunks.push({ url: `${prefix}/${chunks.length + 1}.html`, items: items.slice(offset, offset + CHUNK_SIZE) });
    }
    return { items, statusOrder, inline: items.slice(0, CHUNK_SIZE), chunks, urls: chunks.map(chunk => chunk.url) };
  }
  return {
    tracked: view(['open', 'active', 'preparing', 'parked', 'closed'], '/backlog/tracked-tiles'),
    resolved: view(['resolved'], '/backlog/resolved/tiles'),
  };
}
module.exports = () => build(loadBacklog());
module.exports.build = build;
