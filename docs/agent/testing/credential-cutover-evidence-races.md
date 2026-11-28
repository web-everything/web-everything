## Credential-cutover evidence races

The Homebrew-pinned credential-cutover writer uses Darwin `O_NOFOLLOW_ANY`
(`0x20000000`) to reject symlinks in all path components at the actual open.
Do not combine it with `O_NOFOLLOW`: Darwin returns `EINVAL`. Other platforms
refuse persistence; rerun on a supported macOS host rather than falling back to
ancestor checks before a pathname open. The inventory suite swaps each ancestor
inside the injected open for both evidence sinks and checks that no outside
evidence file is created. Its skipped-ruleset-page case exercises live admission;
next links must advance exactly one page, even when omitted pages contain bypasses.

Residual debt (PR #7614, mkdir ancestor race): directory creation still uses
pathname `mkdir` after ancestor checks. A same-user process can swap an ancestor
between that check and mkdir, creating an empty 0700 run directory outside the
runs tree. The evidence-open guard then refuses persistence with `COHORT`; it
does not make directory creation atomic. The named test `ancestor replacement
inside run mkdir leaves only the documented empty-directory residual` injects
that swap and checks the entire outside listing, its mode, and zero evidence
opens. This is a regression pin for the residual, not proof that no directory
can escape. Eliminating it requires directory-fd-relative creation (or an
equivalent atomic native primitive); that follow-up remains owed.

The unit suite injects a `platform` function (defaulting to `node:os` in production)
and a filesystem open adapter so the supported-writer cases run on Ubuntu CI too.
Every create asserts the exact Darwin flags and mode, and every read asserts its
Darwin flags. On macOS the adapter delegates to the real kernel;
on other hosts it models symlink rejection after the injected ancestor swap.
Aggregate reads use the same `O_NOFOLLOW_ANY` contract as writes, retain the
inode/device comparison, and close the handle on mismatch before reading bytes.
The suite swaps each read ancestor and the leaf inside `open`, preserving the
original inode through a symlink, and separately replaces the file or device.
Every filesystem open in the suite asserts the exact flags. A named source-contract
test also pins both production open sites to `NOFOLLOW_ANY`.
That test-only walk is not proof of kernel atomicity and is never a production
fallback. Separate unsupported-platform cases assert `COHORT` and no evidence
open. Fixture directories use `os.tmpdir()` so an unset `TMPDIR` is supported.
The named `omitted platform uses the native persistence guard` test also omits
the option entirely. Isolated Node probes set the native OS builtin before
importing the module and check inventory and aggregate refusal with zero opens
for Linux and Windows. The `native-default-darwin` mutation bypasses only that
default, so injected-platform cases cannot mask a broken production default.

The write audit retains all filesystem arguments and asserts the exact mkdir
and exclusive-open sequence, plus the complete resulting tree, for inventory
and aggregate after both complete reads and a page-two failure. Its
`unexpected-write` control adds stray writes in both modes. A separate
`ignore-exit-code` control accepts HTTP 200 despite a nonzero child exit; its
valid bypass body must remain `UNREAD` with no findings or completion.

Normal CI selection of the inventory suite also runs every `VARIANTS` entry in a
serial child Vitest invocation. Each child applies the unsafe fixture only to its
matching bracketed tests and requires those tests to fail while the remaining
tests pass. Timeout, signal, missing report, or unrelated failures fail the gate;
children skip the matrix to prevent recursion. The matrix includes separate-stream
output caps and acceptance of extra nested keys as deterministic negative controls.
The streaming probe uses injected child streams and requires a combined cap, kill,
bounded retention and an awaited close. The nested-key table covers every closed
source-data shape, installation entries, and both org/repository bypass actors;
permission maps deliberately allow arbitrary validated permission names.

An executable reporter contract runs passing, assertion-failing and explicitly
skipped tests through the installed Vitest JSON reporter, then checks collection
and hook failures separately. Vitest 1.6.1 reports explicit skips as `skipped`
(`pending` denotes unfinished/only tests), and `numFailedTestSuites` counts suite
errors rather than suites containing failed assertions. The shared matrix
classifier accepts expected assertion failures and rejects suite errors,
pending tests, unrelated failures and missed mutation witnesses. Do not change
these expectations based on a different reporter's terminology.

Run the inventory suite on macOS before landing changes to platform guards or
open flags: that run exercises real kernel symlink rejection. Ubuntu exercises
the injected contract and unsupported-platform refusals, not kernel atomicity.
