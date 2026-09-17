# Paralysis Calendar Days

The v2 snapshot is the current state and already includes history. Apply only new events, in received order. The from_date_delayed rule adds calendar days and advances a non-working result to the next working day for the obra's five- or six-day week.

- AC-1: Historical cascade and only adjustments already represented in a v2 snapshot must not undo the new paralysis. With cutoff 2026-10-16 and 10 days, 2026-10-23 becomes 2026-11-02 and 2026-10-19 becomes 2026-10-29.
- AC-2: With 10 calendar days, 2026-10-21 becomes 2026-11-02 for a five-day week and 2026-10-31 for a six-day week. 2026-10-22 becomes 2026-11-02 in both calendars (Sunday advances).
- AC-3: A working date before the cutoff remains unchanged; completed rows remain unchanged.
- AC-4: Sequential operations must preserve intermediate state: activity 2026-10-19 -> delay to 2026-10-23 -> paralysis 10 days to 2026-11-02 -> delay to 2026-11-04 -> paralysis 10 days to 2026-11-16. A separate activity progresses 2026-10-20 -> 2026-10-30 -> 2026-11-09. Historical events must not reposition these rows.
- AC-5: The same sequence sent as multiple new events in one snapshot request must yield the same final dates as separate requests.

One atomic task: adjust controller ordering/calendar arithmetic and add controller integration tests. Gate: npm run build; npm test -- --maxWorkers=1 --minWorkers=1; git diff --check.
