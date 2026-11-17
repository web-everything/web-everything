#!/usr/bin/env node
/**
 * @file Proposal-first merge of a small knowledge store into the canonical one.
 *
 * By default this only PRINTS the plan and writes nothing. Entries are matched by slug (file stem)
 * and by frontmatter `name:`. Per entry: "add" (only in source), "same" (identical), "conflict"
 * (same slug or name, different content). Conflicts are listed and NEVER overwritten.
 * `--apply` is an explicit flag that copies only the "add" entries into the target and appends their
 * index lines to the target MEMORY.md. It is not run automatically anywhere.
 *
 * Feeds card 0k (the private, versioned knowledge repo): the plan output is the reviewable diff to
 * commit into that repo before it becomes the one canonical store.
 *
 * usage: node scripts/operations/knowledge-store-sync.mjs [--from=MEMORY_DIR] [--to=MEMORY_DIR]
 *          [--cwd=DIR] [--home=DIR] [--canonical-dir=DIR] [--apply] [--json]
 *   defaults: from = the store this session would load; to = the canonical store
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listEntries, parseArgs as parseCheckArgs, projectKey } from './knowledge-store-check.mjs';

/** Frontmatter `name:` of an entry, or ''. */
export function entryName(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const m = fm && /^name:\s*(.+)$/m.exec(fm[1]);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

function load(dir) {
  return listEntries(dir).map((file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    return { file, slug: file.replace(/\.md$/, ''), name: entryName(text), text };
  });
}

/** Pure plan from two entry lists. */
export function planMerge(source, target) {
  const bySlug = new Map(target.map((e) => [e.slug, e]));
  const byName = new Map(target.filter((e) => e.name).map((e) => [e.name, e]));
  const plan = { add: [], same: [], conflict: [] };
  for (const e of source) {
    const hit = bySlug.get(e.slug) || (e.name && byName.get(e.name));
    if (!hit) plan.add.push(e.file);
    else if (hit.text === e.text) plan.same.push(e.file);
    else plan.conflict.push({ file: e.file, against: hit.file });
  }
  return plan;
}

/** Index lines in source MEMORY.md that point at the given files. */
export function indexLinesFor(memoryDir, files) {
  const index = join(memoryDir, 'MEMORY.md');
  if (!existsSync(index)) return [];
  return readFileSync(index, 'utf8').split('\n').filter((l) => files.some((f) => l.includes(`(${f})`)));
}

/** Copy "add" entries only; never overwrites. Returns the files written. */
export function applyPlan(plan, fromDir, toDir) {
  for (const file of plan.add) if (existsSync(join(toDir, file))) throw new Error(`refusing to overwrite ${file}`);
  for (const file of plan.add) copyFileSync(join(fromDir, file), join(toDir, file));
  const lines = indexLinesFor(fromDir, plan.add);
  if (lines.length) appendFileSync(join(toDir, 'MEMORY.md'), `${lines.join('\n')}\n`);
  return plan.add;
}

export function formatPlan(plan, fromDir, toDir, applied) {
  const lines = [`merge plan: ${fromDir} -> ${toDir}`, `add: ${plan.add.length}  same: ${plan.same.length}  conflict: ${plan.conflict.length}`];
  for (const f of plan.add) lines.push(`  + ${f}`);
  for (const c of plan.conflict) lines.push(`  ! ${c.file} conflicts with ${c.against} (kept as-is in target; resolve by hand)`);
  lines.push(applied ? `APPLIED: copied ${plan.add.length} entries` : 'proposal only: nothing written (add --apply to copy the "add" entries)');
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(`${s}\n`)) {
  let apply = false;
  let json = false;
  const rest = [];
  let from = '';
  let to = '';
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('--from=')) from = a.slice(7);
    else if (a.startsWith('--to=')) to = a.slice(5);
    else rest.push(a);
  }
  let opts;
  try {
    opts = parseCheckArgs(rest);
  } catch (err) {
    out(err.message);
    return 2;
  }
  const root = join(opts.home, '.claude', 'projects');
  const fromDir = from || join(root, projectKey(opts.cwd), 'memory');
  const toDir = to || join(root, projectKey(opts.canonicalDir), 'memory');
  if (!existsSync(fromDir) || !existsSync(toDir)) {
    out(`both stores must exist (from: ${fromDir}, to: ${toDir})`);
    return 2;
  }
  if (fromDir === toDir) {
    out('from and to are the same store; nothing to merge');
    return 0;
  }
  const plan = planMerge(load(fromDir), load(toDir));
  if (apply) applyPlan(plan, fromDir, toDir);
  out(json ? JSON.stringify({ fromDir, toDir, applied: apply, ...plan }, null, 2) : formatPlan(plan, fromDir, toDir, apply));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
