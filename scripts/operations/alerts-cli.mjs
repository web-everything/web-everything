#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { alertsOperation } from './alerts.mjs';
import { collectAlerts, followAlerts } from './alerts-io.mjs';
import { createRegistry } from './registry.mjs';
import { createMemoryRunStore } from './run-store.mjs';
import { runOperationCli } from './cli-adapter.mjs';

export async function main(argv = process.argv.slice(2), { collect = collectAlerts, follow = followAlerts, stdout = process.stdout } = {}) {
  if (argv.includes('--help')) {
    stdout.write('Usage: alerts-cli.mjs [--since-min=N] [--exclude-pr=5716,5717] [--json] [--follow]\nUse --follow as the Monitor command (polls every 2 seconds for new alerts).\n'); return;
  }
  if (argv.includes('--follow')) {
    if (argv.some((arg) => arg !== '--follow' && !/^--exclude-pr=\d+(?:,\d+)*$/.test(arg))) throw new Error('follow accepts only --exclude-pr=N,N');
    return follow({ excludePrs: (argv.find((arg) => arg.startsWith('--exclude-pr='))?.split('=')[1] ?? '').split(',').filter(Boolean) });
  }
  const declaration = alertsOperation({ collect }), registry = createRegistry();
  registry.register(declaration);
  const result = await runOperationCli({ declaration, registry, argv: argv.map((arg) => arg.replace(/^--since-min(?==|$)/, '--sinceMin').replace(/^--exclude-pr(?==|$)/, '--excludePr')), store: createMemoryRunStore(), newRunId: () => 'alerts' });
  process.exitCode = result.code;
  stdout.write(result.code ? `${result.lines.join('\n')}\n` : argv.includes('--json')
    ? `${JSON.stringify(result.run.verdict)}\n` : result.run.verdict.map((a) => `${a.text}${a.count > 1 ? ` ×${a.count}` : ''}\n`).join(''));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
