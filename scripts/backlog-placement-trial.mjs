#!/usr/bin/env node
/**
 * @file scripts/backlog-placement-trial.mjs
 * @description READ-ONLY trial of the backlog split: classify every backlog card by target repo
 * (plateau-app | everstandards/<repo|unknown> | we | unsure). Rules run in order and each is named.
 * Never edits a card. Writes reports/data/backlog-placement-trial.json and prints counts to stdout.
 * Unreadable frontmatter -> `unsure` (counted and listed, never dropped). One pass, no state.
 * Usage: node scripts/backlog-placement-trial.mjs [--dir=backlog] [--out=reports/data/backlog-placement-trial.json]
 */
import fs from 'node:fs';
import path from 'node:path';

const PLATEAU_WORDS = ['plateau', 'product', 'business', 'delivery', 'daemon', 'conveyor', 'drain', 'lane', 'ci', 'merge', 'forge', 'operator', 'coordination'];
const STANDARDS_WORDS = ['everstandards', 'ship', 'platform-forever', 'everflow', 'move-to-everstandards'];
const WE_WORDS = ['intents', 'blocks', 'plugs', 'adapters', 'components', 'demos'];
const PLATEAU_SCOPE = /^we:(scripts\/(conveyor|merge-ai-prs|lane-pool|guard-)|skills-src\/conveyor)/;

/** Split a card into frontmatter text and body; null front when unreadable. */
export function splitCard(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return m ? { front: m[1], body: m[2] } : { front: null, body: text };
}

function listField(front, name) {
  const out = [];
  const inline = new RegExp(`^${name}:\\s*\\[(.*)\\]\\s*$`, 'm').exec(front);
  if (inline) {
    for (const v of inline[1].split(',')) out.push(v.trim().replace(/^["']|["']$/g, ''));
    return out.filter(Boolean);
  }
  const block = new RegExp(`^${name}:\\s*\\r?\\n((?:\\s+-\\s*.*\\r?\\n?)+)`, 'm').exec(front);
  if (block) {
    for (const l of block[1].split(/\r?\n/)) {
      const t = /^\s+-\s*(.*)$/.exec(l);
      if (t) out.push(t[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return out.filter(Boolean);
}

function explicitTarget(body) {
  const m = /^(?:Placement|move-to):\s*(.*)$/im.exec(body);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (/plateau/.test(v)) return 'plateau-app';
  const es = /everstandards(?:[/:\s]+([a-z0-9._-]+))?/.exec(v);
  if (es) return `everstandards/${es[1] && !/^(settled|private)$/.test(es[1]) ? es[1] : 'unknown'}`;
  if (/@webeverything|\bwe\b|web-everything/.test(v)) return 'we';
  return null;
}

/** Classify one card text. Returns { target, rule, confidence }. */
export function classifyCard(text) {
  const { front, body } = splitCard(text);
  if (front === null) return { target: 'unsure', rule: 'unreadable-frontmatter', confidence: 'none' };
  const ex = explicitTarget(body);
  if (ex) return { target: ex, rule: 'explicit-placement', confidence: 'high' };
  const words = [...listField(front, 'tags'), ...listField(front, 'areas'), ...listField(front, 'area')].map((w) => w.toLowerCase());
  const hit = (list) => words.find((w) => list.some((x) => w === x || w.startsWith(`${x}-`)));
  const p = hit(PLATEAU_WORDS);
  if (p) return { target: 'plateau-app', rule: `tag-plateau:${p}`, confidence: 'medium' };
  const s = hit(STANDARDS_WORDS);
  if (s) return { target: 'everstandards/unknown', rule: `tag-standards:${s}`, confidence: 'medium' };
  const w = hit(WE_WORDS);
  if (w) return { target: 'we', rule: `tag-we:${w}`, confidence: 'medium' };
  const scopes = listField(front, 'scope');
  if (scopes.some((x) => PLATEAU_SCOPE.test(x))) return { target: 'plateau-app', rule: 'scope-plateau', confidence: 'medium' };
  if (scopes.some((x) => /^we:(src|blocks|intents|plugs)\//.test(x))) return { target: 'we', rule: 'scope-we-standard', confidence: 'medium' };
  return { target: 'unsure', rule: 'no-rule-matched', confidence: 'none' };
}

/** Run over a directory; read-only. */
export function runTrial(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const cards = [];
  for (const f of files) {
    let r;
    try {
      r = classifyCard(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      r = { target: 'unsure', rule: 'unreadable-file', confidence: 'none' };
    }
    // numeric card id only (unique per backlog); slugs can carry private host terms (R971)
    cards.push({ id: f.replace(/\.md$/, '').split('-')[0], ...r });
  }
  const byTarget = {};
  const byRule = {};
  for (const c of cards) {
    byTarget[c.target] = (byTarget[c.target] || 0) + 1;
    byRule[c.rule] = (byRule[c.rule] || 0) + 1;
  }
  return { total: cards.length, byTarget, byRule, cards };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const res = runTrial(arg('dir', 'backlog'));
  const out = arg('out', 'reports/data/backlog-placement-trial.json');
  fs.writeFileSync(out, `${JSON.stringify(res, null, 1)}\n`);
  console.log(`cards: ${res.total}`);
  console.log('by target:', JSON.stringify(res.byTarget));
  const top = Object.entries(res.byRule).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [r, n] of top) console.log(`  ${n}\t${r}`);
}
