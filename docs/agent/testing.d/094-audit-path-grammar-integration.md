## Audit path grammar integration

Audit verdicts use `audit-path.mjs`: a report outside the strict grammar is protected, even
when no configured glob names it. Malformed configured protected patterns abort settings
loading. Keep valid-path shipping controls separate from rejected-pattern fixtures; the
legacy permissive parser's prose-wrapped shipping cases conflict with this strict grammar.

