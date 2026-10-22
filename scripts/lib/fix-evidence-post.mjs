/** Pure, fail-closed assembly of launcher-authored operator send-back evidence. */
function sendBackItemLines(sendBack) {
  const lines = String(sendBack?.body ?? '').split(/\r\n?|\n/)
    .map(line => line.replace(/^(?:[ \t]*>)+[ \t]?/, '').replace(/\t/g, '    '));
  // Deliberately over-count: headings and every nested bullet need evidence too.
  const items = lines.filter(line => /^[^\w\r\n]*(?:\d+[.)]|[-*+])(?:\s|$)/.test(line));
  return items.length ? items : [lines.find(line => line.trim()) ?? ''];
}

export const sendBackItems = sendBack => sendBackItemLines(sendBack).map((_, i) => ({ n: i + 1 }));

export function renderRequiredCitations(openSendBacks) {
  return openSendBacks.flatMap(sendBack => sendBackItemLines(sendBack).map((line, i) =>
    `- send-back ${sendBack.id} item ${i + 1}: <file:line>   (for: ${line.slice(0, 80)})`)).join('\n');
}

export function parseEvidenceCitations(text) {
  const citations = new Map();
  for (const line of String(text ?? '').split(/\r\n?|\n/)) {
    const match = /^- send-back ([^\s<>]+) item (\d+): (\S.*)$/i.exec(line);
    if (match) citations.set(`${match[1]}#${Number(match[2])}`, match[3].trim());
  }
  return citations;
}

function citationPieces(citation) {
  return [...String(citation ?? '').matchAll(/(\S+\.[A-Za-z0-9]+):(\d+)/g)]
    .map(match => ({ path: match[1], line: Number(match[2]) }))
    .filter(piece => !/send|IC_|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|http| ET/i.test(piece.path)
      && /^[\w./-]+$/.test(piece.path));
}

export const isConcreteCitation = citation => citationPieces(citation).length > 0;

const renderPiece = piece => `${piece.path}:${piece.line}`;

export function buildFixEvidenceComment({ openSendBacks, evidenceText, head, verifyCitation }) {
  if (!openSendBacks?.length) return { ok: false, missing: [], reason: 'no-open-send-back' };
  // Strip before parsing too: a citation hidden in an HTML comment is not evidence.
  const evidence = String(evidenceText ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').slice(0, 20000);
  const citations = parseEvidenceCitations(evidence);
  const missing = [], lines = [];
  for (const sendBack of openSendBacks) {
    if (/<(?:li|ol|ul)/i.test(String(sendBack.body ?? ''))) {
      missing.push(`${sendBack.id}#unparsed`);
      continue;
    }
    if (String(sendBack.body ?? '').length >= 4000) {
      missing.push(`${sendBack.id}#truncated`);
      continue;
    }
    for (const { n } of sendBackItems(sendBack)) {
      const key = `${sendBack.id}#${n}`, citation = citations.get(key);
      const verified = citationPieces(citation).filter(piece => {
        try { return verifyCitation(piece) === true; } catch { return false; /* unreadable evidence stays missing */ }
      });
      if (!verified.length) missing.push(key);
      else lines.push(`- send-back ${sendBack.id} item ${n}: ${verified.map(renderPiece).join(', ')}`);
    }
  }
  if (missing.length) return { ok: false, missing };
  const markers = openSendBacks.map(item => `<!-- addresses-operator-send-back: ${item.id} -->`);
  const body = `## Fix evidence\n\nHead: \`${head}\`\n${markers.join('\n')}\nCitations\n${lines.join('\n')}`;
  if (body.split('\n').filter(line => !markers.includes(line)).join('\n').includes('<!--')
    || (body.match(/addresses-operator-send-back/g) ?? []).length !== openSendBacks.length) {
    return { ok: false, missing: openSendBacks.flatMap(item => sendBackItems(item).map(({ n }) => `${item.id}#${n}`)) };
  }
  return { ok: true, body };
}
