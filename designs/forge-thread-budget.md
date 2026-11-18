# Forge thread budget

## Reservation and sweep

Cancel-finish waits for the supervisor, then proves the reserved UID empty before clearing a stale
`executing` lock. Unprovable cleanup keeps the reservation and marker held and raises one needs-you
alert naming the slot (throttled per slot); the age-based sweep is not proof of UID emptiness.
