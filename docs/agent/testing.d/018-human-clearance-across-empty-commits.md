## Human clearance across empty commits

An empty recovery commit can carry a fingerprinted human clearance when `rev-parse --verify
<sha>^{tree}` proves the cleared and live heads have exactly the same root tree. This includes
paths, modes, blobs and the lane manifest; changed trees receive no tree-based carry.
Use `applyHumanClearanceCarry`, with a pinned scored diff and a fresh complete comment thread
from `readCompletePrComments` plus formal reviews before the durable record. Missing fingerprints,
unknown evidence and head mismatches refuse general carry before Git or the writer. SHA-only
clearances remain confined to the explicitly requested numbering-only proof. Test real empty
commits and changed trees through the writer, alongside refusal cases with zero writer calls.

