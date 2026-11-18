/** R657: prune-packed/repack must leave borrowed or busy object stores alone. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/daemon-self-sync.mjs';
const BUSY_SOURCE = 'scripts/lib/clone-maintenance.mjs';
const COMMANDS = [
  ['config', '--local', 'fetch.unpackLimit', '1'],
  ['config', '--local', 'transfer.unpackLimit', '1'],
  ['prune-packed'], ['repack', '-d', '-l'],
];

export const cases = [
  'absolute alternate borrower',
  'relative alternate borrower',
  'linked worktree borrower',
  'index lock',
  'Git cwd in clone',
  'Git cwd below clone',
  'partial Git cwd evidence fails closed',
  'unavailable process evidence fails closed',
  'unreadable alternates fail closed',
  'idle clone resumes after borrower detaches',
  'Git in sibling clone permits maintenance',
];

export default {
  id: 'clone-object-maintenance-borrowed-or-busy',
  title: 'R657 object maintenance skips clones with borrowers or active Git',
  card: 'R657 S1',
  fixedBy: { sha: '79172d2438', where: 'main', paths: [SOURCE, BUSY_SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    const busy = readFileSync(join(root, BUSY_SOURCE), 'utf8');
    return source.includes('hasBorrowers(root) !== false || isBusy(root) !== false')
      && source.includes('export function cloneHasObjectBorrowers(')
      && busy.includes('export function cloneGitIsBusy(');
  },
  async run({ root = ROOT, log, caseName } = {}) {
    const { maintainCloneObjects, cloneHasObjectBorrowers } = await import(pathToFileURL(join(root, SOURCE)).href);
    const { cloneGitIsBusy } = await import(pathToFileURL(join(root, BUSY_SOURCE)).href);
    if (caseName !== undefined && !cases.includes(caseName)) throw new Error(`unknown maintenance case: ${caseName}`);
    const base = mkdtempSync(join(tmpdir(), 'soak-object-maintenance-'));
    const violations = [];
    const observations = [];
    try {
      for (const name of caseName === undefined ? cases : [caseName]) {
        const dir = mkdtempSync(join(base, 'case-'));
        const clone = join(dir, 'clone');
        const borrower = join(dir, 'clone-other');
        const objects = join(clone, '.git/objects');
        const borrowerObjects = join(borrower, '.git/objects');
        mkdirSync(join(objects, 'info'), { recursive: true });
        mkdirSync(join(borrowerObjects, 'info'), { recursive: true });
        mkdirSync(join(clone, 'scripts'));
        let roots = [borrower];
        const alternates = join(borrowerObjects, 'info/alternates');
        let processes = '123 /usr/bin/node\n';
        let cwdEvidence = '';
        if (name.includes('alternate borrower') || name === 'linked worktree borrower'
          || name === 'idle clone resumes after borrower detaches') {
          writeFileSync(alternates, name === 'relative alternate borrower'
            ? `${relative(borrowerObjects, objects)}\n` : `${objects}\n`);
        }
        if (name === 'linked worktree borrower') {
          const gitDir = join(borrower, '.git/worktrees/linked');
          const linked = join(dir, 'linked');
          mkdirSync(gitDir, { recursive: true });
          mkdirSync(linked);
          writeFileSync(join(linked, '.git'), `gitdir: ${gitDir}\n`);
          writeFileSync(join(gitDir, 'commondir'), '../..\n');
          roots = [linked];
        }
        if (name === 'idle clone resumes after borrower detaches') {
          // Establish that this same fixture really was borrowed before detachment.
          if (cloneHasObjectBorrowers(clone, { roots }) !== true) violations.push(`${name}: setup did not detect borrower`);
          rmSync(alternates);
        }
        if (name === 'unreadable alternates fail closed') mkdirSync(alternates);
        if (name === 'index lock') writeFileSync(join(clone, '.git/index.lock'), 'busy');
        if (name.startsWith('Git cwd') || name === 'Git in sibling clone permits maintenance') {
          processes = '123 /usr/bin/git\n';
          const cwd = name === 'Git cwd below clone' ? join(clone, 'scripts')
            : name === 'Git in sibling clone permits maintenance' ? borrower : clone;
          cwdEvidence = `p123\nn${realpathSync(cwd)}\n`;
        }
        if (name === 'partial Git cwd evidence fails closed') {
          processes = '123 /usr/bin/git\n456 /usr/bin/git\n';
          cwdEvidence = `p123\nn${realpathSync(borrower)}\n`;
        }
        const exec = (bin) => {
          if (name === 'index lock') throw new Error('index lock should short-circuit process inspection');
          if (name === 'unavailable process evidence fails closed') throw new Error('fixture: ps unavailable');
          if (bin === 'ps') return processes;
          if (bin === 'lsof') return cwdEvidence;
          throw new Error(`unexpected executable: ${bin}`);
        };
        const commands = [];
        const diagnostics = [];
        const result = await maintainCloneObjects({
          root: clone, env: {},
          hasBorrowers: (checkout) => cloneHasObjectBorrowers(checkout, { roots }),
          isBusy: (checkout) => cloneGitIsBusy(checkout, { exec }),
          run: async (args, opts) => {
            commands.push(args);
            if (opts.cwd !== clone) violations.push(`${name}: maintenance escaped fixture clone`);
            return { status: 0, stdout: '' };
          },
          log: { error: (message) => diagnostics.push(message) },
        });
        const idle = name === 'idle clone resumes after borrower detaches'
          || name === 'Git in sibling clone permits maintenance';
        if (result.skipped !== !idle) violations.push(`${name}: expected skipped=${!idle}, got ${result.skipped}`);
        if (JSON.stringify(commands) !== JSON.stringify(idle ? COMMANDS : [])) {
          violations.push(`${name}: unexpected maintenance commands ${JSON.stringify(commands)}`);
        }
        const evidenceFailure = ['unavailable process evidence fails closed', 'unreadable alternates fail closed'].includes(name);
        if (evidenceFailure) {
          if (result.reason !== 'maintenance-failed' || !diagnostics.some(message => message.includes('inspect clone before retrying'))) {
            violations.push(`${name}: missing operator inspection fallback`);
          }
        } else if (result.reason !== undefined || diagnostics.length !== 0) {
          violations.push(`${name}: unexpected evidence failure masqueraded as a safety skip`);
        }
        observations.push({ name, skipped: result.skipped, commands });
        log?.(`${name}: skipped=${result.skipped}, commands=${commands.length}`);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
    return { violations, observations };
  },
  judge: (report) => report.violations,
};
