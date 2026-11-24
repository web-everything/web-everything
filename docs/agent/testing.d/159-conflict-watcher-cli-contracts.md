## Conflict watcher CLI contracts

The conflict watcher's `runConflictWatchCli` is shared by its executable guard and PR snapshot
contract. Set `cliMain` in `prFileContract` for callable entries so repeated argv checks reuse
the loaded graph. Resetting the entire daemon graph twice inside the CLI test exceeded its
60-second deadline on a coverage shard. Keep the file/standalone output comparison and zero-GitHub
assertions intact; consumers without callable entries retain the fresh-import path.

