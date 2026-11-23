## Forge prewarm claim boundary

`forge-prewarm.test.mjs` exercises real private trees and marker files. Model a foreign UID
through injected `lstat` results so ownership refusals run without root. Cover each pool/base/tree
owner and writable-directory check, private tree permissions, marker ownership/mode/link count/type,
and exact SHA/digest marker bytes. Rejection before claim must leave the source intact; verification
failure after rename must remove the destination without following links or exposing its permissions.
The success case observes mode 0700 during verification, inode preservation and single consumption.

Keep the runner reconstruction cases in `forge-offload.test.mjs`: they compare the complete input
digest and overlay/deletion results before worker commands run, including file-to-directory,
directory-to-file and nested deletion, while preserving unchanged prewarm inodes. When changing
these guards, check representative mutations for ownership, marker evidence, private verification,
failure cleanup and parent-directory removal through the heavy-admission queue. Temporary Vite
transform configs can substitute mutations without editing the working implementation.
