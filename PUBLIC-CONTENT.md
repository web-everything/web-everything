# Public content (R972)

This repository is public. Choose the appropriate home before writing content.

| Tier | Content and home |
| --- | --- |
| Public | Product code, standards, generic tooling and tests, product design notes, and neutral backlog cards belong here. |
| Private ops | Handoffs, rulings, build queues, capacity data, operator preferences, and personal workflow belong in a private repository or `.operations`. |
| Never in git | Secrets, personal identity, machine names and hardware specs, home paths, private service URLs, network names and IPs, account IDs, and personal or business documents. |

Use placeholder templates such as `$HOME`, `/Users/<name>/`, `/home/example/`,
`<private-service-url>`, `<network-name>`, and `<account-id>`. Inject operational
values locally rather than committing them.

The standards privacy check scans the git-derived changed set against the merge base
with `origin/main`, including working-tree changes, in CI and no-flag runs. Explicit
`--files` paths are added to that set; flags never exclude a git-derived change.
Unchanged files are not scanned unless explicitly named. R971 blocks machine names
and paired host specs; R972 blocks newly introduced identity, path, service,
network, and account-ID patterns against the branch base. Existing R972 hits
remain visible to whole-tree audits and are not exempted. The explicit
`scripts/settings/privacy-terms-allowlist.json` records an approved test/fixture or policy path, pattern, literal matched text,
exact match and source-line hashes, and reason
for necessary synthetic test fixtures and detector definitions. Entries for ordinary
docs or backlog cards are invalid; exemptions must never hide
real operational data. Operator usernames are stored only as lowercase SHA-256 digests;
identifier and home-path tokens are checked against them on every host, including CI.
Every file is scanned in UTF-8, latin1 with NULs as separators, and UTF-16LE/BE
at both byte alignments. No encoding heuristic, density or format signature suppresses
any view; findings retain occurrence counts while duplicate decoding views are deduplicated.
Only exact tokens from a fixed placeholder list are exempt; placeholder prefixes receive no exemption.
Each line is scanned raw and with HTML entities decoded, tags replaced by spaces,
zero-width characters removed and Unicode NFKC normalisation applied.
Exemptions for normalised findings use the raw committed source line. Gzip/zlib
payloads (including raw deflate) are inspected recursively through eight layers with a cumulative
32 MiB inflated-size cap; malformed nested wrappers or depth/size limits block with
`uninspectable-compressed`. Repair the payload or request an exact-context policy exemption.
Every file is scanned regardless of magic
headers, format or extension; only matching patterns produce findings. Synthetic false
positives require an approved exact-context allowlist entry. Host specs include nearby CPU and RAM figures in either order.
Identity hashes are checked against whole tokens, dot/dash/underscore joins and individual sub-tokens.
Policy, baseline, and identity validation always run, including with an empty file selection.
Privacy failures remain blocking under every combination of `--scope`, `--local`, and `--files`, including failures to read policy or baseline evidence.
Pattern checks support human review; they cannot classify
every secret, identity, or personal document.

Do not rewrite history unless a secret leaks. If one does, rotate or revoke it
and arrange the necessary history cleanup.

## Threat model (R984)

The check guards against accidental leaks: plain text and common encodings (URL, base64, JSON-escaped). Deliberate obfuscation is out of scope, such as compressed or concatenated streams, split or concatenated strings, and other encoder tricks. It runs on changed files only; existing hits are cleaned up in follow-up batches.
