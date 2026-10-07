#!/usr/bin/env node
/**
 * @file scripts/operations/free-scope-cli.mjs
 * @description IMPURE operator CLI for checking and declaring worker scopes. Injectable output, reader
 * and clock keep command tests isolated from the real GitHub host and shared registry.
 */
import { pathToFileURL } from 'node:url';
import { assessFreeScope, formatFreeScope, parseExcludePr, partitionRegistry, registerScope, releaseScope, DEFAULT_TTL_HOURS } from './free-scope.mjs';
import { collectFreeScope, defaultRegistryPath, readRegistry, updateRegistry } from './free-scope-io.mjs';
const usage = `Usage: free-scope [check|register|release|list] [options]
  --files=a,b --card=<id> --exclude-agent=<name> [--exclude-owner=<token>] --exclude-pr=<n>|<repo>#<n> --json
  register --agent=<name> [--owner=<token>] --purpose=<text> (--files=a,b | --card=<id>) [--ttl-hours=N]
  release --agent=<name> [--owner=<token>]
  list [--json]
  --help
`;
export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr,
  collect = collectFreeScope, now = Date.now } = {}) {
  const print = (text) => stdout.write(`${text}\n`);
  if (argv.includes('--help')) { stdout.write(usage); return 0; }
  try {
    let command = 'check', selected = false;
    const options = {};
    const names = ['files', 'card', 'exclude-agent', 'exclude-pr', 'agent', 'purpose', 'ttl-hours', 'owner', 'exclude-owner'];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (['check', 'register', 'release', 'list'].includes(arg.replace(/^--/, ''))) {
        if (selected) throw new TypeError('free-scope: only one subcommand is allowed');
        command = arg.replace(/^--/, ''); selected = true;
      } else if (arg === '--json') options.json = true;
      else {
        const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
        if (!match || !names.includes(match[1])) throw new TypeError(`free-scope: unknown argument ${arg}`);
        const value = match[2] ?? argv[++i];
        if (value == null || value.startsWith('--')) throw new TypeError(`free-scope: missing value for ${match[1]}`);
        options[match[1]] = value;
      }
    }
    const registry = defaultRegistryPath(env);
    if (command === 'list') {
      const result = partitionRegistry(readRegistry(registry), now());
      print(options.json ? JSON.stringify(result, null, 2) : ['live:', ...result.live.map((e) => `  ${e.agent} (${e.purpose}): ${e.files.join(', ')}`),
        'stale (ignored):', ...result.stale.map((e) => `  ${e.agent} (${e.purpose}): ${e.files.join(', ')}`)].join('\n'));
      return 0;
    }
    if (['release', 'register'].includes(command) && !options.agent?.trim()) throw new TypeError('free-scope: give --agent=<name>');
    if (command === 'release') {
      let released;
      updateRegistry(registry, (entries) => { const result = releaseScope(entries, options.agent, options.owner); released = result.released; return result.entries; });
      print(`released ${released}`); return 0;
    }
    const { repo: excludeRepo, number: excludePr } = parseExcludePr(options['exclude-pr']);
    const ttlHours = Number(options['ttl-hours'] ?? DEFAULT_TTL_HOURS);
    if (command === 'register' && (!Number.isFinite(ttlHours) || ttlHours <= 0)) throw new TypeError('free-scope: --ttl-hours must be positive');
    const snapshot = collect({ files: options.files ?? '', card: options.card ?? '', env, now });
    const assess = (agents) => assessFreeScope({ ...snapshot, agents,
      excludeAgent: command === 'register' ? options.agent : options['exclude-agent'] ?? '',
      // register ignores only its OWN entry; a check names its owner via --exclude-owner, else excludes every entry of that name
      excludeOwner: command === 'register' ? options.owner ?? null : options['exclude-owner'], excludePr, excludeRepo });
    let check, registered;
    if (command === 'register') {
      updateRegistry(registry, (entries) => {
        check = assess(entries);
        // registerScope refuses a live entry held by a different owner BEFORE anything is printed or written
        const updated = registerScope(entries, { agent: options.agent, purpose: options.purpose ?? '', files: snapshot.files, ttlHours, owner: options.owner }, new Date(snapshot.nowMs).toISOString());
        if (!options.json) print(formatFreeScope(check));
        registered = updated.at(-1);
        return updated;
      });
    } else check = assess(snapshot.agents);
    if (options.json) print(JSON.stringify(command === 'register' ? { registered, check } : check, null, 2));
    else if (command !== 'register') print(formatFreeScope(check));
    return check.status === 'free' ? 0 : check.status === 'occupied' ? 1 : 2;
  } catch (error) { stderr.write(`${error.message}\n`); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
