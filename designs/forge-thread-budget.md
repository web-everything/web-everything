# Forge thread budget

## Reservation and sweep

Cancel-finish waits for the supervisor, then requires both proven reserved UID emptiness and an
`executing` lock past the hard max runtime (mtime age >= the bound) before clearing it.
A younger lock or unprovable cleanup keeps the reservation and marker held and raises one needs-you
alert naming the slot (throttled per slot); the age-based sweep is not proof of UID emptiness.
