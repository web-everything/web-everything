import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
export const canonical = (x) => Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
export const digestOf = (x) => ({ sha256: crypto.createHash('sha256').update(canonical(x)).digest('hex') });
export function globRe(g) {
  const segs = g.split('/'); let re = '';
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === '**') { re += last ? '.*' : '(?:[^/]+/)*'; return; }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]') + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}
export const matches = (g, p) => globRe(g).test(p);
export const POLICY_T = 'https://everstandards.dev/ship/file-class-policy/v0.1';
export const PRESET_T = 'https://everstandards.dev/ship/file-class-preset/v0.1';
export const EVAL_T = 'https://everstandards.dev/ship/file-class-evaluation/v0.1';
export const REASON = (k) => `${POLICY_T}/reasons/${k}`;
export const DIFF_KIND = 'x-ship-change-diff';
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const pinOf = (d) => ({ uri: d.id, digest: digestOf(d) });
export const AXES = { committed: [true, false], pr: ['any', 'append', 'none'], writers: ['any', 'named', 'builder'], unit: null };
export const UNITS = ['file', 'item', 'entry'];
export const CLASSES = {
  source: { committed: true, pr: 'any', writers: 'any', unit: 'file' },
  generated: { committed: false, pr: 'none', writers: 'builder', unit: 'file' },
  fragment: { committed: true, pr: 'any', writers: 'any', unit: 'item' },
  'bot-owned': { committed: true, pr: 'none', writers: 'named', unit: 'file' },
  'append-only': { committed: true, pr: 'append', writers: 'any', unit: 'entry' },
};
export function looserClass(a, b) {
  for (const [ax, ord] of Object.entries(AXES)) {
    if (!ord) { if (a[ax] !== b[ax]) return true; continue; }
    if (ord.indexOf(a[ax]) < ord.indexOf(b[ax])) return true;
  }
  return false;
}
export const FAIL = ['committed-generated', 'stale-generated', 'build-failed', 'not-writer', 'writers-unconfigured', 'removed-entry', 'rewrote-entry', 'reordered', 'fragment-name', 'fragment-shape', 'unclassified-blocked', 'not-ignored'];
export const UNKNOWN = ['unclassified', 'ambiguous', 'build-missing', 'writer-unverified', 'entries-unknown', 'fragment-unverified'];
const kindFails = (k) => FAIL.includes(k) || (!UNKNOWN.includes(k)); // an unrecognised (x-) kind fails closed
const find = (docs, pin) => (pin ? (docs ?? []).find((d) => d?.id === pin.uri && same(digestOf(d), pin.digest)) ?? null : null);
export function classTable(chain, presets) {
  const t = { ...CLASSES };
  chain.forEach((p) => { for (const src of [find(presets, p.preset), p]) for (const [n, c] of Object.entries(src?.classes ?? {})) if (!(n in t)) t[n] = c; });
  return t;
}
export function candidates(chain, presets) {
  const rows = [];
  chain.forEach((p, li) => {
    const pre = find(presets, p.preset);
    (pre?.rows ?? []).forEach((r, i) => rows.push({ ...r, li, level: p.level, policy: p, via: 'preset', row: i }));
    (p.rows ?? []).forEach((r, i) => rows.push({ ...r, li, level: p.level, policy: p, via: 'row', row: i }));
  });
  return rows;
}
export const spec = (g) => { const segs = g.split('/'); return [segs.filter((s) => !/[*?]/.test(s)).length, g.replace(/[*?/]/g, '').length]; };
const cmp = (a, b) => {
  const [sa, sb] = [spec(a.glob), spec(b.glob)];
  return sa[0] - sb[0] || sa[1] - sb[1] || a.li - b.li || (a.via === 'row') - (b.via === 'row');
};
export function classify(chain, presets, p) {
  const m = candidates(chain, presets).filter((r) => matches(r.glob, p)).sort(cmp);
  if (!m.length) {
    const u = effectiveUnmatched(chain);
    return { unmatched: u.value ?? null, source: u.source, matching: [] };
  }
  const top = m.at(-1), ties = m.filter((r) => cmp(r, top) === 0 && r.class !== top.class);
  if (ties.length) return { ambiguous: true, matching: m };
  return { class: top.class, row: top, matching: m };
}
export function effectiveUnmatched(chain) {
  let value, source = null;
  chain.forEach((p, li) => { if (p.unmatched !== undefined) { value = p.unmatched; source = { level: p.level, li, policy: p }; } });
  return { value, source };
}
const srcOf = (r) => ({ level: r.level, policy: pinOf(r.policy), via: r.via, row: r.row });
const writerMatch = (id, ws) => (ws ?? []).some((w) => same(w, id));
export function evaluate({ chain, presets = [], change }) {
  assertInput(chain, change);
  const table = classTable(chain, presets), files = [], findings = [];
  const add = (path, kind, src) => findings.push({ path, kind, ...(src ? { source: src } : {}) });
  const rowsAll = candidates(chain, presets);
  for (const f of change.files) {
    const c = classify(chain, presets, f.path);
    if (c.ambiguous) { files.push({ path: f.path, status: f.status, class: null, via: 'ambiguous' }); add(f.path, 'ambiguous'); continue; }
    if (!c.class) {
      if (c.unmatched === 'source') { files.push({ path: f.path, status: f.status, class: 'source', via: 'unmatched', source: { level: c.source.level, policy: pinOf(c.source.policy), via: 'unmatched' } }); continue; }
      files.push({ path: f.path, status: f.status, class: null, via: 'unmatched' });
      add(f.path, c.unmatched === 'block' ? 'unclassified-blocked' : 'unclassified'); continue;
    }
    const cls = table[c.class], src = srcOf(c.row), params = c.row.params ?? {};
    files.push({ path: f.path, status: f.status, class: c.class, source: src });
    if (!cls) { add(f.path, 'unclassified', src); continue; }
    const writes = f.status !== 'deleted';
    if (!cls.committed && writes) add(f.path, 'committed-generated', src);
    if (cls.committed && cls.writers === 'builder' && writes) {
      const b = (change.builds ?? []).find((x) => x.row === c.row.glob);
      if (!b || b.outcome === 'unknown') add(f.path, 'build-missing', src); else if (b.outcome === 'fail') add(f.path, 'stale-generated', src);
    }
    if (cls.writers === 'named') {
      const ws = params.writers, id = change.writer?.identity;
      if (!ws) add(f.path, 'writers-unconfigured', src);
      else if (!id || !writerMatch(id, ws)) add(f.path, 'not-writer', src);
      else if (!['probe', 'replayed'].includes(change.writer.proof?.provenanceTier)) add(f.path, 'writer-unverified', src);
    }
    if (cls.pr === 'append') {
      if (f.status === 'deleted') add(f.path, 'removed-entry', src);
      else if (f.status === 'modified') {
        if (!f.entries) add(f.path, 'entries-unknown', src);
        else {
          const before = f.entries.before, after = f.entries.after, ak = after.map((e) => e.key);
          const lost = before.filter((e) => !ak.includes(e.key)), changed = before.filter((e) => { const a = after.find((x) => x.key === e.key); return a && !same(a.digest, e.digest); });
          if (lost.length) add(f.path, 'removed-entry', src);
          if (changed.length) add(f.path, 'rewrote-entry', src);
          const kept = ak.filter((k) => before.some((e) => e.key === k)), bk = before.map((e) => e.key).filter((k) => kept.includes(k));
          const newIdx = ak.map((k, i) => (before.some((e) => e.key === k) ? -1 : i)).filter((i) => i >= 0);
          const order = params.order;
          let bad = !same(kept, bk);
          if (order === 'append' && newIdx.some((i) => i < ak.length - newIdx.length)) bad = true;
          if (order === 'sorted' && !same(ak, [...ak].sort())) bad = true;
          if (bad) add(f.path, 'reordered', src);
        }
      }
    }
    if (cls.unit === 'item' && writes) {
      const base = f.path.split('/').at(-1);
      if (!new RegExp(params.name).test(base)) add(f.path, 'fragment-name', src);
      if (f.items === undefined) add(f.path, 'fragment-unverified', src); else if (f.items !== 1) add(f.path, 'fragment-shape', src);
    }
  }
  for (const r of rowsAll) {
    const cls = table[r.class];
    if (!cls || cls.writers !== 'builder' || !r.params?.builder) continue;
    const touched = change.files.some((f) => (r.params.builder.from ?? []).some((g) => matches(g, f.path)));
    if (!touched) continue;
    const b = (change.builds ?? []).find((x) => x.row === r.glob);
    if (!b || b.outcome === 'unknown') add(r.glob, 'build-missing', srcOf(r)); else if (b.outcome === 'fail') add(r.glob, 'build-failed', srcOf(r));
  }
  for (const r of rowsAll) if (table[r.class] && !table[r.class].committed && !(change.ignore ?? []).some((l) => l === r.glob || l === `/${r.glob}`)) add(r.glob, 'not-ignored', srcOf(r));
  const seen = new Set(), fs = [];
  for (const x of findings) { const k = `${x.path}|${x.kind}`; if (!seen.has(k)) { seen.add(k); fs.push(x); } }
  fs.sort((a, b) => (a.path + a.kind).localeCompare(b.path + b.kind));
  const failK = fs.filter((x) => kindFails(x.kind)), unkK = fs.filter((x) => !kindFails(x.kind));
  const verdict = failK.length ? 'fail' : unkK.length ? 'unknown' : 'pass';
  return { files, findings: fs, verdict, reason: verdict === 'unknown' ? REASON(unkK[0].kind) : undefined };
}
const cites = (p, path) => (p.loosens ?? []).some((l) => l.path === path && l.approval?.uri);
export function cascadeLoosening({ chain, presets = [], paths }) {
const out = [], table = classTable(chain, presets);
for (const path of paths) {
  const c = classify(chain, presets, path); if (!c.class) continue;
  const w = c.row;
  for (const h of c.matching) if (h.li < w.li && table[w.class] && table[h.class] && looserClass(table[w.class], table[h.class])) {
    const ptr = w.via === 'preset' ? '/preset' : `/rows/${w.row}`;
    if (!cites(w.policy, ptr)) out.push(`${path}: ${w.level} ${w.via} ${w.glob} (${w.class}) loosens ${h.level} ${h.glob} (${h.class}) without an approval at ${ptr} (FCP-007)`);
  }
}
const ORD = ['source', 'block'];
let prev; chain.forEach((p, li) => {
  if (p.unmatched !== undefined && li > 0) { const before = prev; if ((before === undefined || ORD.indexOf(p.unmatched) < ORD.indexOf(before)) && !cites(p, '/unmatched')) out.push(`${p.level} sets unmatched ${p.unmatched}, looser than ${before ?? 'the closed outcome'}, without an approval (FCP-007)`); }
  if (p.unmatched !== undefined) prev = p.unmatched;
});
return out;
}
// Missing or unreadable evidence is an error, never an empty successful evaluation.
function assertInput(chain, change) {
  if (!Array.isArray(chain) || !chain.length || chain.some(p => !p?.id || !Array.isArray(p.rows ?? []))) throw new Error('policy required');
  if (!Array.isArray(change?.files) || !change.files.length || change.files.some(f => !f.path || !['added', 'modified', 'deleted', 'renamed'].includes(f.status))) throw new Error('complete diff required');
  if (new Set(change.files.map(f => f.path)).size !== change.files.length) throw new Error('duplicate path');
}
export function verdict(findings) {
  return findings.some(f => kindFails(f.kind)) ? 'fail' : findings.length ? 'unknown' : 'pass';
}
// Local record only: no subprocess, credentials, GitHub client, label, status or process exit.
// The head is supplied evidence, not a live merge authorization. No rounds or cached successes are consumed.
export function recordOnly(input, output) {
  const data = typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input;
  const { chain, presets = [], change } = data;
  assertInput(chain, change);
  if (typeof change.head !== 'string' || !/^[a-fA-F0-9]{40}$/.test(change.head) || change.head.length !== 40) throw new Error('exact 40-hex head required');
  if (!change.change) throw new Error('change identity required');
  if (cascadeLoosening({ chain, presets, paths: change.files.map(f => f.path) }).length) throw new Error('unapproved cascade loosening');
  const evaluation = { evaluationType: EVAL_T, change: change.change, head: change.head,
    policy: chain.map(pinOf), ...evaluate({ chain, presets, change }) };
  if (output !== undefined) writeFileSync(output, JSON.stringify(evaluation, null, 2) + '\n', { flag: 'wx' });
  return evaluation;
}
