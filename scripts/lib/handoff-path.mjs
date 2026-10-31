/** Shared handoff location, without the CLI's Git transport and publishing dependencies. */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** THE one answer to "where is the handoff". Outside `~/.claude/`. */
export function handoffHome({ home = homedir() } = {}) {
  return join(home, 'workspace', '.operations', 'handoff');
}
