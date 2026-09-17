# Cascade Clone Boundary

Cascade date recalculation must preserve finish-to-start service dependencies after shifting historical/current dates. The dependent starts no earlier than the next working day after the latest predecessor occurrence, including all clones.

- AC-1: In structural recalculation with sparse historical rows, five predecessor occurrences on 2026-09-15, 16, 17, 18, 21 require the dependent release on 2026-09-22, even when history contains release 2026-09-16 and the replay delta is zero.
- AC-2: The same boundary holds for snapshot cascade recalculation, and propagates through a downstream service chain regardless of input ordering.
- AC-3: Later valid dependent dates must not be pulled earlier. Completed snapshot rows must not move. Only-date changes retain their intentionally non-cascading behavior.
- AC-4: When a dependent itself spans multiple working days, moving its start preserves its working-day spacing and its successor follows its final occurrence.

One atomic task: controller dependency-boundary repair after each cascade, regression tests and spec. Gate: TypeScript build, all tests sequential, diff check. No external Bubble writes or deployment.
