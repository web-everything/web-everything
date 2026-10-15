/** Mechanical shape check for a completed prepare, shared by observation and lane recovery. */
import { readField } from '../backlog/frontmatter.mjs';
import matter from 'gray-matter';

const REQUIRED = ['design', 'mvp', 'test plan', 'proof plan'];

/** Split a card body into `## ` sections. Headings inside a CommonMark fence never count, but fenced lines under a real heading are content. */
function readSections(body) {
  const sections = new Map();
  let name = null;
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      else if (name) sections.set(name, `${sections.get(name)}\n${line}`);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      if (name) sections.set(name, `${sections.get(name)}\n${line}`);
      continue;
    }
    const heading = line.match(/^(#{1,2})\s+(.*)$/);
    if (heading) {
      name = heading[1] === '##' ? heading[2].trim().toLowerCase() : null;
      if (name && !sections.has(name)) sections.set(name, '');
      continue;
    }
    if (name) sections.set(name, `${sections.get(name)}\n${line}`);
  }
  return sections;
}

export function validatePrepareCard(raw, { operatorTask = false } = {}) {
  // Ignore frontmatter and comments: headings must be actual card sections.
  const body = String(raw).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/<!--[^]*?-->/g, '');
  const sections = readSections(body);
  const missing = REQUIRED.filter(name => !sections.get(name)?.trim());
  if (operatorTask) {
    const complete = text => Boolean(text?.trim()) && !/\b(?:TODO|TBD)\b/i.test(text);
    for (const name of REQUIRED) if (!complete(sections.get(name)) && !missing.includes(name)) missing.push(name);
    if (!['done when', 'acceptance', 'acceptance criteria'].some(name => complete(sections.get(name)))) missing.push('done when');
    if (![...sections].some(([name, text]) => /^edge cases\b/.test(name) && complete(text))) missing.push('edge cases');
    const scope = matter(String(raw), {}).data.scope;
    if (!Array.isArray(scope) || !scope.length || !scope.every(p => typeof p === 'string' && /^we:[^/\s][^\s]*$/.test(p) && !p.includes('..'))) missing.push('we:-prefixed scope');
  }
  return { ok: missing.length === 0, missing: missing.map(name => ({ design: 'Design', mvp: 'MVP', 'test plan': 'Test plan', 'proof plan': 'Proof plan', 'done when': 'Done when', 'edge cases': 'Edge cases' })[name] ?? name) };
}

export function prepareCardStatus(raw) {
  const stamp = readField(raw, 'preparedDate');
  return {
    preparedDate: /^\d{4}-\d{2}-\d{2}$/.test(stamp ?? '') ? stamp : null,
    hasSections: validatePrepareCard(raw).ok,
  };
}
