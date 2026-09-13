# Recalculation Visible Progress Validation

**Date**: 2026-09-13
**Spec**: `.specs/features/recalculation-visible-progress/spec.md`
**Diff range**: `ce5b2d2^..HEAD`
**Verifier**: independent Verifier role
**Verdict**: PASS

---

## Task Completion

No `tasks.md` exists for this small feature. Validation scoped to commit `ce5b2d2` and the requested files:

- `src/controllers/schedules.controller.ts`
- `src/services/schedule-webhook.service.ts`
- `tests/schedules.controller.test.ts`
- `tests/schedules.controller.mocked.test.ts`

---

## Spec-Anchored Acceptance Criteria

### P1: Visible Stage Boundaries MVP

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| WHEN a schedule job starts THEN emit `processing` progress `1 / 0%` with message `Calculando cronograma` before calculation work begins. | First expected webhook boundary is `{ status: "processing", progress: 1, progress_percent: 0, message: "Calculando cronograma" }`. | `tests/schedules.controller.test.ts:96-112` asserts ordered subsequence by exact `status`, `progress`, `progress_percent`, and `message`; generate path expects this value at `tests/schedules.controller.test.ts:198-199`; snapshot path expects this value at `tests/schedules.controller.test.ts:506-507`. | PASS |
| WHEN calculation finishes successfully THEN emit `processing` progress `1 / 100%` before opening stage 2. | Ordered webhook contains `{ status: "processing", progress: 1, progress_percent: 100, message: "Calculando cronograma" }` before stage 2 `0%`. | Ordered matcher at `tests/schedules.controller.test.ts:96-112`; generate path sequence has `1 / 100%` at `tests/schedules.controller.test.ts:200` before `2 / 0%` at `tests/schedules.controller.test.ts:201`; snapshot path has `1 / 100%` at `tests/schedules.controller.test.ts:508` before `2 / 0%` at `tests/schedules.controller.test.ts:509`. | PASS |
| WHEN persistence starts THEN emit `processing` progress `2 / 0%` using the path-specific stage 2 message. | Generate/full persistence uses `Criando registros em bulk`; snapshot recalculation uses `Atualizando datas recalculadas`. | Generate path expects `{ progress: 2, progress_percent: 0, message: "Criando registros em bulk" }` at `tests/schedules.controller.test.ts:201`; snapshot path expects `{ progress: 2, progress_percent: 0, message: "Atualizando datas recalculadas" }` at `tests/schedules.controller.test.ts:509`; ordered matcher at `tests/schedules.controller.test.ts:96-112`. | PASS |
| WHEN stage 2 persistence completes THEN emit or have emitted `processing` progress `2 / 100%` before opening the next stage. | Ordered webhook contains stage 2 `100%` with the same path-specific message before the next stage boundary. | Generate path expects `{ progress: 2, progress_percent: 100, message: "Criando registros em bulk" }` at `tests/schedules.controller.test.ts:202` before stage 3 at `tests/schedules.controller.test.ts:203`; snapshot path expects `{ progress: 2, progress_percent: 100, message: "Atualizando datas recalculadas" }` at `tests/schedules.controller.test.ts:510` before stage 3 at `tests/schedules.controller.test.ts:511`; ordered matcher at `tests/schedules.controller.test.ts:96-112`. | PASS |
| WHEN the job reaches finalization THEN emit `processing` progress `4 / 0%` with message `Finalizando cronograma` before terminal `done`. | Ordered webhook contains `{ status: "processing", progress: 4, progress_percent: 0, message: "Finalizando cronograma" }` before terminal done. | Generate path expects stage 4 `0%` at `tests/schedules.controller.test.ts:204` before done at `tests/schedules.controller.test.ts:205`; snapshot path expects stage 4 `0%` at `tests/schedules.controller.test.ts:512` before done at `tests/schedules.controller.test.ts:513`; ordered matcher at `tests/schedules.controller.test.ts:96-112`. | PASS |
| WHEN terminal completion is sent THEN continue sending `done` with `progress: 4` and `progress_percent: 100`. | Terminal payload has `status: "done"`, `progress: 4`, `progress_percent: 100`. | Generate terminal payload is asserted directly at `tests/schedules.controller.test.ts:185-194`; the ordered sequence also expects `{ status: "done", progress: 4, progress_percent: 100, message: undefined }` at `tests/schedules.controller.test.ts:205`; snapshot sequence expects the same terminal values at `tests/schedules.controller.test.ts:513`. | PASS |

### P1: Non-Blocking Progress

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| WHEN a non-initial `processing` webhook hangs or fails during PATCH persistence THEN persistence continues and terminal `done` is still sent. | Hanging positive progress webhooks do not block PATCH persistence; two PATCH calls complete; terminal done metrics report patched work. | The stub hangs for `status === "processing"` and `progress_percent > 0` at `tests/schedules.controller.test.ts:517-523`; request is accepted at `tests/schedules.controller.test.ts:596-600`; terminal `done` is awaited at `tests/schedules.controller.test.ts:602`; PATCH persistence count is asserted as `2` at `tests/schedules.controller.test.ts:604`; done metrics assert `patchedCount: 2` and `patchRequestCount: 2` at `tests/schedules.controller.test.ts:605-608`. | PASS |
| WHEN terminal `done` or `error` is required THEN continue awaiting the terminal webhook sender. | Terminal webhooks remain awaited/retried, unlike processing progress. | Service test awaits an error webhook send at `tests/schedule-webhook.service.test.ts:31` and asserts retry behavior with `expect(fetchMock).toHaveBeenCalledTimes(2)` at `tests/schedule-webhook.service.test.ts:33`; processing contrast asserts no retry at `tests/schedule-webhook.service.test.ts:42-44`; controller awaits terminal `done` at `src/controllers/schedules.controller.ts:1327-1342` and terminal `error` at `src/controllers/schedules.controller.ts:1361-1370`. | PASS |

**Status**: All acceptance criteria have file:line evidence with asserted spec values.

---

## Success Criteria

| Success criterion | Evidence | Result |
| --- | --- | --- |
| Generate jobs emit ordered stage boundary webhooks before terminal `done`. | `tests/schedules.controller.test.ts:198-205` via ordered matcher `tests/schedules.controller.test.ts:96-112`. | PASS |
| Snapshot recalculation jobs emit stage 1, 2, 3, and 4 visibility despite only patching dates. | `tests/schedules.controller.test.ts:506-513`, including stage 3 zero-work closure at `tests/schedules.controller.test.ts:511`. | PASS |
| Existing non-blocking progress behavior remains intact. | `tests/schedules.controller.test.ts:517-608` and `tests/schedule-webhook.service.test.ts:31-44`. | PASS |

---

## Edge Cases

| Edge case | Evidence | Result |
| --- | --- | --- |
| WHEN a stage has no units of persistence work THEN still emit that stage's `100%` closure before moving on. | Snapshot sequence expects stage 3 `100%` at `tests/schedules.controller.test.ts:511` before stage 4 at `tests/schedules.controller.test.ts:512`; implementation also closes skipped stages at `src/controllers/schedules.controller.ts:1322-1325`. | PASS |
| WHEN calculation throws after stage 1 starts THEN the error webhook reports the last emitted stage and percent. | The mocked calculation-failure test asserts terminal error `progress: 1`, `progress_percent: 0`, `error_code: "SCHEDULE_ENGINE_ERROR"`, `error_message: "Unexpected error"`, and `failed_step: "calculate"` at `tests/schedules.controller.mocked.test.ts:42-47`. | PASS |
| WHEN Bubble rejects an intermediate progress webhook THEN failure is logged but does not fail the job. | The PATCH persistence integration test returns HTTP 429 for positive `processing` webhooks at `tests/schedules.controller.test.ts:519-523`, then asserts terminal done and completed PATCH metrics at `tests/schedules.controller.test.ts:602-607`. | PASS |

---

## Discrimination Sensor

Sensor ran in scratch state by temporarily mutating `src/controllers/schedules.controller.ts` and restoring it immediately afterward. Final `git status --short` was clean before writing this report.

| Mutation | File:line | Description | Killed? |
| --- | --- | --- | --- |
| 1 | `src/controllers/schedules.controller.ts:1325` | Changed finalization processing webhook from `sendProcessingProgress(4, 0, "Finalizando cronograma")` to `sendProcessingProgress(4, 100, "Finalizando cronograma")`. | KILLED: `npm.cmd test -- tests/schedules.controller.test.ts` failed 2 tests. Failures were `accepts a schedule job immediately` at `tests/schedules.controller.test.ts:198` and `uses snapshot-driven recalculation to patch only changed dates when estrutura is unchanged` at `tests/schedules.controller.test.ts:506`, both missing ordered webhook `{ status: "processing", progress: 4, progress_percent: 0, message: "Finalizando cronograma" }`. |

**Sensor depth**: lightweight, one high-risk behavior-level mutation.
**Result**: 1/1 killed.

---

## Gate Check

| Command | Result |
| --- | --- |
| `npm.cmd test -- tests/schedules.controller.test.ts tests/schedules.controller.mocked.test.ts` | PASS: 2 files, 50 tests passed. |
| `npm.cmd test` | PASS: 7 files, 166 tests passed. |
| `npm.cmd run build` | PASS: TypeScript build completed. |
| Post-sensor restore: `npm.cmd test -- tests/schedules.controller.test.ts` | PASS: 1 file, 49 tests passed. |

Initial targeted Vitest run inside the sandbox failed before executing tests because esbuild could not read `../..` / resolve `vitest.config.ts`; rerun outside the sandbox passed.

**Test count after feature**: 166 passed, 0 failed, 0 skipped.
**Test count before feature**: not rerun from `ce5b2d2^`; diff inspection shows targeted assertions were strengthened rather than deleted, with the previous single processing assertion replaced by ordered progress-sequence coverage.

---

## Code Quality

| Principle | Status |
| --- | --- |
| No features beyond what was asked | PASS |
| Surgical changes | PASS |
| No unnecessary flexibility | PASS |
| Only touched files required for task | PASS |
| Matches existing patterns/style | PASS |
| Processing webhooks non-blocking, terminal webhooks awaited | PASS |
| Tests map to acceptance criteria and assert payload values, not just calls | PASS |
| Per-layer coverage expectation met for acceptance criteria | PASS |
| Documented project quality/testing guidelines followed | none found for this feature; strong defaults applied |

Notes:

- `sendProcessingProgress` centralizes last-progress tracking and non-blocking processing delivery without changing terminal completion authority.
- `closeProgressStage` is small and directly tied to the zero-work closure requirement.
- The ordered test helper asserts the payload conjunction: `status`, `progress`, `progress_percent`, and `message` must all match.

---

## Ranked Gaps

None remaining after the follow-up test hardening.

---

## Requirement Traceability Update

| Requirement | Previous Status | Validation Status |
| --- | --- | --- |
| RVP-01 | Pending | Verified |
| RVP-02 | Pending | Verified |
| RVP-03 | Pending | Verified |
| RVP-04 | Pending | Verified |

---

## Summary

**Overall**: Ready.

**Spec-anchored check**: 8/8 acceptance criteria matched spec outcomes.
**Sensor**: 1/1 mutations killed.
**Gate**: 166 tests passed; build passed.

What works:

- Generate and snapshot recalculation paths emit ordered visible progress boundaries.
- Stage 2 messages are path-specific.
- Stage 4 opens at `0%` before terminal `done`.
- Intermediate processing progress remains non-blocking while terminal webhooks remain awaited.

Issues found:

- No implementation defect found.
- Verifier-reported edge-case coverage gaps were closed by asserting calculation-error progress and explicit rejected processing webhook behavior.

## Follow-up Validation Addendum

After the independent Verifier reported edge-case coverage gaps, the author hardened tests only:

- `tests/schedules.controller.mocked.test.ts:42-47` now asserts calculation failures report `progress: 1` and `progress_percent: 0`.
- `tests/schedules.controller.test.ts:519-523` now simulates explicit HTTP 429 rejection for positive `processing` webhooks while `tests/schedules.controller.test.ts:602-607` proves PATCH persistence and terminal `done` still complete.

Gate after hardening:

| Command | Result |
| --- | --- |
| `npm.cmd test -- tests/schedules.controller.test.ts tests/schedules.controller.mocked.test.ts` | PASS: 2 files, 50 tests passed. |
| `npm.cmd test` | PASS: 7 files, 166 tests passed. |
| `npm.cmd run build` | PASS: TypeScript build completed. |

---

## Follow-up Validation Addendum - Commit `5643503`

**Date**: 2026-09-13  
**Commit**: `5643503` (`fix(progress): serialize milestones and dedupe repeats`)  
**Verifier**: independent Verifier role  
**Verdict**: PASS

### Scope Checked

- `src/controllers/schedules.controller.ts`
- `src/services/bubble-bulk.service.ts`
- `tests/schedules.controller.test.ts`
- `tests/bubble-bulk.service.test.ts`
- Contract cross-check: `docs/recalculation-webhook-contract-2026-09-13.md`

### Focus Requirement Evidence

| Requirement | Spec / contract outcome | `file:line` + assertion evidence | Result |
| --- | --- | --- | --- |
| Stage boundary webhooks arrive serially in Bubble-observed order, even with uneven webhook response times. | Boundary order must be `1/0 -> 1/100 -> 2/0 -> 2/100 -> 3/100 -> 4/0 -> done`; terminal and boundary webhooks preserve ordering. | Implementation awaits boundary sends at `src/controllers/schedules.controller.ts:1299`, `src/controllers/schedules.controller.ts:1301`, `src/controllers/schedules.controller.ts:1316`, `src/controllers/schedules.controller.ts:1326`, and `src/controllers/schedules.controller.ts:1332-1334`; non-100 persistence progress remains detached at `src/controllers/schedules.controller.ts:1327`. Test injects delayed Bubble responses for selected boundaries at `tests/schedules.controller.test.ts:217-224` and asserts delivered order exactly at `tests/schedules.controller.test.ts:261-277`. Generate and snapshot ordered payload assertions also cover the full sequence at `tests/schedules.controller.test.ts:202-210` and `tests/schedules.controller.test.ts:577-584`. | PASS |
| Stage 2 remains 10% increments, not 5% or 2%. | Contract says stage 2 stays 10% by 10%; expected processing cadence includes `2 0%`, then `2 10% ... 2 100%`. | Implementation rounds with `Math.floor(percent / 10) * 10` at `src/services/bubble-bulk.service.ts:610-611`. Test asserts phase 2 emitted percents equal `[10, 20, 30, 40, 50, 60, 70, 80, 90, 100]` at `tests/bubble-bulk.service.test.ts:131`; phase 3 uses the same cadence at `tests/bubble-bulk.service.test.ts:132`. | PASS |
| Short heartbeat intervals do not resend unchanged percentages repeatedly; only rare guardrail renewal is allowed. | Short heartbeat should not emit the same `progress_percent` repeatedly; duplicate resend is limited to rare guardrail renewal. | Implementation allows a forced repeat only when `roundedPercent === lastPercent`, `lastReportedAt > 0`, and elapsed time is at least `PROGRESS_REPEAT_GUARDRAIL_RENEWAL_MS` at `src/services/bubble-bulk.service.ts:614-618`; otherwise unchanged percentages return without `onProgress`. Heartbeat still calls forced reports at `src/services/bubble-bulk.service.ts:636-640`. Test sets a 1000 ms heartbeat, holds a PATCH for 2200 ms, then asserts emitted percents equal `[100]` only at `tests/bubble-bulk.service.test.ts:137-191`. | PASS |
| Internal non-100 progress can remain non-blocking; terminal and boundary webhooks preserve ordering. | Non-initial processing failures should not abort persistence; terminal `done` / `error` remain awaited completion authority. | Implementation detaches non-100 progress at `src/controllers/schedules.controller.ts:1327`, but awaits stage boundaries and terminal `done` at `src/controllers/schedules.controller.ts:1332-1340`. Rejection test returns HTTP 429 for positive `processing` webhooks at `tests/schedules.controller.test.ts:588-596` and still proves terminal completion/persistence in the remainder of that test. | PASS |

### Gate Evidence

| Command | Result |
| --- | --- |
| `npm.cmd test` | PASS: 7 files, 168 tests passed, 0 failed, 0 skipped. |
| `npm.cmd run build` | PASS: TypeScript build completed. |

The author-reported gate for commit `5643503` matched the independent rerun: `npm.cmd test` reported 168 passed, and `npm.cmd run build` completed successfully.

### Discrimination Sensor

Sensor ran in a temporary detached worktree at commit `5643503`; the main checkout was not mutated. The temp worktree was removed after the sensor.

| Mutation | File:line | Description | Killed? |
| --- | --- | --- | --- |
| 1 | `src/controllers/schedules.controller.ts:1326-1327` | Changed `progress_percent === 100` persistence callbacks back to detached sends, making `2/100` and `3/100` race with later boundaries. | KILLED. `vitest.cmd run tests\schedules.controller.test.ts --root <temp-worktree>` failed `delivers stage boundary webhooks in order even when Bubble responds unevenly` at `tests/schedules.controller.test.ts:269`. Received order moved `processing:2:100` and `processing:3:100` after `processing:4:0` and `done:4:100`; expected order kept them before stage 4 and done. |

**Sensor depth**: lightweight, one high-risk behavior-level mutation.  
**Result**: 1/1 killed.

### Gaps

None found for the requested increment. The verified behavior matches the spec and Bubble contract: stage boundaries are serialized, stage 2 stays at 10% increments, short heartbeat duplicate suppression is covered, and terminal/boundary ordering is preserved while non-100 internal progress stays non-blocking.
