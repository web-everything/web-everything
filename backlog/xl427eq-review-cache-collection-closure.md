---
kind: task
status: open
dateOpened: "2026-10-14"
scope: ["we:skills-src/review/"]
tags: [prevention]
---

# Require collection closure proof when reviewing read caches

Add a review-lens rule requiring a cache of a collection to prove that no later members can appear. Every currently listed row being completed does not prove that the collection is closed.

Raised by the security review of web-everything/web-everything#5290. Check both the parent lifecycle and pagination or projection: a completed prefix, a missing later workflow, and a full page must not become final CI evidence. An immutability proof must precede the payload it vouches for.

## Done when

The review instructions explicitly ask for collection closure and proof-before-payload ordering, with a staged-workflow example in which a later member appears after an all-completed first response.
