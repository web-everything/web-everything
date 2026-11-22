## Executable path identity through symlink parents

When checking which executable an absolute path names, preserve literal path
components through both lookup and identity comparison. Node's JavaScript
`realpathSync()` normalizes `..` before resolving symlinks; `realpathSync.native()`
uses the OS lookup, where `link/..` follows the link before visiting its parent.
For process identity checks, resolve both operands with the native implementation.
Keep the original executable spelling when spawning name-sensitive dispatchers.

The symlink-parent cases in `scripts/__tests__/agent-launch.test.mjs` probe the
actual PATH execution and cover both a traversing PATH entry and a traversing
fixed binary path, asserting refusal before spawn and acceptance of matching files.
