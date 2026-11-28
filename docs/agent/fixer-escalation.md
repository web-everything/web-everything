# Fixer escalation

## Routed escalation count

The routed escalation count on a head is the number of model rows since the last push. Once 3 or more rows of any cause sit on that head, it is the larger of that number and the row total minus one, so explicit launcher, input or infra rows delay escalation by at most one run and never stop it. A row without an explicit non-model cause counts as model.
