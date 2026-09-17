# Paralysis Calendar Days Validation

Date: 2026-09-17
Verdict: PASS for the five explicit acceptance criteria.
Verifier: independent verification pass; implementation and real tests read-only.
Diff: HEAD^..702ec3ff0050988ea1510f46b0b3a473e04a4473 (three files).
Spec: `.specs/features/paralysis-calendar-days/spec.md`.

## Task Completion

No tasks.md exists for this feature. The spec defines one atomic task: controller ordering/calendar arithmetic plus integration tests. Commit 702ec3f implements it. No implementation or test edits were made by this verifier. The concurrent author update to `.specs/STATE.md` (AD-034) was preserved.

## Spec-Anchored Coverage

All citations below refer to `tests/schedules.controller.test.ts` at the verified commit.

| Criterion | Independently derived outcome | Exact assertion evidence | Result |
| --- | --- | --- | --- |
| AC-1: current snapshot includes historical adjustments | Oct 23 + 10 calendar days = Nov 2; Oct 19 + 10 = Oct 29. Historical cascade/only events do not reset these rows. | :516 `expect(patches.ao_1).toEqual({ dataInicioPrevista: "2026-11-02T12:00:00.000Z", dataFimPrevista: "2026-11-02T12:00:00.000Z" })`; :517 identical exact-object assertion for Oct 29. Historical events supplied at :502-506. | PASS |
| AC-2: five/six-day calendars | Oct 21 + 10 = Saturday Oct 31: Monday Nov 2 for five days, Oct 31 for six. Oct 22 + 10 = Sunday Nov 1: Nov 2 for both. | :480 `it.each([5, 6] as const)`; :518 exact `saturdayResult` conditional; :519 `expect(patches.ao_3).toEqual({ dataInicioPrevista: saturdayResult, dataFimPrevista: saturdayResult })`; :520 exact Nov 2 object for ao_4. | PASS |
| AC-3: before-cutoff working/completed rows | Thursday Oct 15 remains unchanged; completed Oct 23 remains unchanged. | :481 input dates; :490 completed status for index 5; :521 `expect(patches.ao_0).toBeUndefined()`; :522 `expect(patches.ao_5).toBeUndefined()`. No persisted date patch is the observable unchanged outcome. | PASS |
| AC-4: sequential chronology | Both rows progress through [Oct 23, Oct 20], [Nov 2, Oct 30], [Nov 4, Oct 30], [Nov 16, Nov 9]. | :542-547 literal `expected` arrays; :559 `events_old: singleRequest ? [] : events.slice(0, index)`; :570 `expect(snapshot.map((row) => row.dataInicioPrevista)).toEqual(expected[singleRequest ? 3 : index])`; :571 same assertion for end dates. `false` parameter executes all four checkpoints. | PASS |
| AC-5: batch matches separate requests | One request yields [Nov 16, Nov 9], identical to the sequential final checkpoint. | :525 `it.each([false, true])`; :548 batching; :570-571 above assert both variants against the same literal final dates. | PASS |

5/5 criteria have precise outcomes and matching assertions; no spec-precision gaps within these criteria.

## Reverse Mapping

Scope is newly added tests in the feature diff, not every repository test.

| New test executions | Claimed requirements |
| --- | --- |
| :480 calendar/history test, weekDays=5 | AC-1, AC-2, AC-3 |
| :480 calendar/history test, weekDays=6 | AC-1, AC-2, AC-3 |
| :525 chronology test, singleRequest=false | AC-4, sequential reference for AC-5 |
| :525 chronology test, singleRequest=true | AC-5 |

The :512/:562 HTTP 202 assertions and :513/:563 done-webhook waits support the integration task's successful route execution. All four new executions are claimed; no existing assertions were changed, removed, or weakened in the commit.

## Independent Gates

- Spec commands: `npm run build`; `npm test -- --maxWorkers=1 --minWorkers=1`; `git diff --check`.
- PowerShell blocked npm.ps1 by execution policy. `npm.cmd run build` could not find tsc because node_modules/.bin contains no executable shims, even with escalation. Equivalent `node node_modules/typescript/bin/tsc` passed (exit 0).
- Equivalent test entry point: `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1`. Restricted execution failed loading config because esbuild could not read ancestor directories. Authorized escalated retry passed: 7 files, 191 tests, 0 failed, 0 skipped.
- File counts: controller 63; engine 58; Bubble bulk 58; docs 5; mocked controller 1; webhook 2; observability 4.
- `git diff --check` passed; warning about STATE.md LF/CRLF was not a failure.
- Before-feature count: inferred 187, not independently rerun at parent. Latest diff only adds two two-case parameterized tests (4 executions), with no deletions; independently observed after count 191, delta +4.

## Discrimination Sensor

Scratch: `.verification-scratch-calendar`, independent copied src/tests/config/package files; dependencies resolved from parent node_modules. Real source/tests were never mutated. Unchanged scratch baseline: 4 passed, 59 deselected by name filter. Each fault ran independently after restoring the previous mutation. Same command for baseline and mutants:

`node ../node_modules/vitest/vitest.mjs run tests/schedules.controller.test.ts --maxWorkers=1 --minWorkers=1 -t 'applies ten calendar days|preserves delay/paralysis'`

| Mutation (scratch controller line) | Fault | Observed discrimination | Result |
| --- | --- | --- | --- |
| :460 | Snapshot active events include events_old again | Sequential false case fails :570 at third checkpoint: received [Nov 16, Nov 9], expected [Nov 4, Oct 30]. 1 failed, 3 passed. | KILLED |
| :775 | Add days + 1 instead of days | Both calendar cases fail :516: Nov 3 instead of Nov 2; both chronology cases fail :570. 4 failed. | KILLED |
| :1282 | Reverse received new-event order | Batch true case fails :570: [Oct 23, Nov 9] instead of [Nov 16, Nov 9]. 1 failed, 3 passed. | KILLED |

Lightweight depth: 3 injected, 3 killed, 0 survived. Failures are behavioral assertion failures, not import/config errors. The 59 skips in these targeted runs are deliberate name-filter deselections; no tests were disabled. Scratch was discarded after sensor execution.

## Code Quality and Edge Cases

- Snapshot history exclusion (:458-460), calendar arithmetic (:774-776), and sequential snapshot rebuilding (:1278-1300) directly implement the specified behavior. Date-only UTC arithmetic avoids local daylight-saving effects.
- Existing helpers and controller patterns are reused; no new dependencies, speculative abstraction, unrelated refactoring, or altered test expectations. Scope is controller, its integration tests, and spec.
- Explicit edges exercised: cutoff-before working day, completed row, Saturday under both calendars, Sunday under both calendars, historical cascade/only adjustments, repeated paralysis, and separate versus batch requests.
- Domain behavior is exercised through the real Express/controller/persistence-patch path. The full suite includes existing invalid-event and payload-error tests; this commit introduces no route. No claim is made that every newly reachable branch has separate error-path coverage.
- Coding principles checked against `C:/Users/luizl/.codex/skills/tlc-spec-driven/references/coding-principles.md`. No repository AGENTS.md or feature tasks.md was found in the file inventory.
- Interactive UAT not performed: backend calculation feature with exact date outcomes and automated route integration coverage.

## Caveats and Concrete Remaining Gaps

No blocking acceptance-criterion gaps or surviving mutants found. This is a bounded verification, not exhaustive mutation or branch coverage.

- Batch tests assert final dates, not each internal checkpoint; sequential requests assert every checkpoint. Their shared precise final oracle and order-reversal sensor support AC-5.
- Chronology parameterization uses the base helper calendar; only calendar/history fixtures explicitly exercise both five- and six-day weeks.
- No new exact-cutoff-date or zero-day fixture, nor new mixed work-start/purchase/cascade batch fixture. These are additional coverage opportunities beyond the five explicit scenarios. The new work-start obra_json propagation branch (:1293-1295) is inspected but has no dedicated new batch assertion.
- Bubble fetch and webhooks are mocked; no real external persistence or deployment was exercised. Before-cutoff/completed assertions prove no date PATCH for those IDs, not a live remote readback.
- Gate executables were invoked directly due missing npm shims. The author-reported gate was not substituted for independent execution.

## Traceability and Closing

AC-1 through AC-5: verified in this report; spec left unchanged as requested. No fix task required for the explicit criteria. No failure, surviving mutant, spec-precision gap, or SPEC_DEVIATION signal requiring a lesson was found; no lesson files changed. Only this validation report was authored in the real tree. No push/deploy.
