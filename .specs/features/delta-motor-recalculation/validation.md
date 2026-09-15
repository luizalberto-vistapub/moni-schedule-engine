# Delta Motor Recalculation Validation

**Date**: 2026-09-14
**Spec**: `.specs/features/delta-motor-recalculation/spec.md`
**Verifier**: standalone fallback fresh-eyes pass

---

## Spec-Anchored Acceptance Criteria

| Criterion | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| DMR-01 old events are not re-persisted | In-place persistence writes records derived from `events_json` only | `tests/schedules.controller.test.ts:1832` - `expect(eventRecords).toHaveLength(1)` after a recalculate containing `events_old` and `events_json` | PASS |
| DMR-01 calendar dates do not drift | Bubble timestamp `2026-09-07T00:00:00.000Z` persists as `2026-09-07T12:00:00.000Z` | `tests/bubble-bulk.service.test.ts:316` - `expect(buildEventoCronogramaRecords(payload)[0]).toMatchObject({ data: "2026-09-07T12:00:00.000Z", requisicao_data: "2026-09-07T12:00:00.000Z" })` | PASS |
| DMR-02 valid v3 request is accepted | Endpoint returns `202` and later sends `done` | `tests/schedules.controller.test.ts:754` - `expect(response.status).toBe(202)` and `tests/schedules.controller.test.ts:765` - `expect(doneBody.metrics).toMatchObject({ linesCount: 2, patchedCount: 2, eventCount: 1 })` | PASS |
| DMR-02 v3 patches only changed rows | No Atividade x Obra bulk create; two changed rows are patched | `tests/schedules.controller.test.ts:758` - `expect(fetchCalls("/api/1.1/obj/atividadexobra/bulk", "POST")).toHaveLength(0)` and `tests/schedules.controller.test.ts:762` - `expect(patchBodies).toEqual([...])` | PASS |
| DMR-02 persists only new event | Exactly one EventoCronograma record, for the new cascade event | `tests/schedules.controller.test.ts:769` - `expect(eventRecords).toHaveLength(1)` and `tests/schedules.controller.test.ts:770` - `expect(eventRecords[0]).toMatchObject(...)` | PASS |
| DMR-03 base count mismatch | Final webhook has `BASE_STATE_INVALID` and no PATCH | `tests/schedules.controller.test.ts:806` - `expect(errorBody.error_code).toBe("BASE_STATE_INVALID")`; `tests/schedules.controller.test.ts:808` - `expect(fetchCalls(..., "PATCH")).toHaveLength(0)` | PASS |
| DMR-03 target scope drift | Final webhook has `STATE_DRIFT` and no PATCH | `tests/schedules.controller.test.ts:842` - `expect(errorBody.error_code).toBe("STATE_DRIFT")`; `tests/schedules.controller.test.ts:844` - `expect(fetchCalls(..., "PATCH")).toHaveLength(0)` | PASS |
| DMR-03 Bubble row drift | Final webhook has `STATE_DRIFT` when Bubble `dataInicioPrevista` differs from replayed current state | `tests/schedules.controller.test.ts:901` - `expect(errorBody.error_code).toBe("STATE_DRIFT")`; `tests/schedules.controller.test.ts:902` - `expect(String(errorBody.error_message)).toContain("Bubble has 2026-05-05T12:00:00.000Z")` | PASS |

---

## Gate Check

- **TypeScript**: `node node_modules\typescript\bin\tsc` passed.
- **Tests**: `node node_modules\vitest\vitest.mjs run` passed, 7 files and 179 tests.
- **Whitespace**: `git diff --check` passed.

---

## Discrimination Sensor

Manual sensor by inspection over the implemented branches:

| Mutation | Expected failing evidence |
| --- | --- |
| Re-enable `events_old` persistence in date/bulk paths | `tests/schedules.controller.test.ts:1832` would receive two event records instead of one. |
| Remove `toBubbleCalendarDate` from event persistence | `tests/bubble-bulk.service.test.ts:316` would observe timestamp drift for `2026-09-07T00:00:00.000Z`. |
| Skip Bubble lookup date comparison | `tests/schedules.controller.test.ts:901` would no longer produce `STATE_DRIFT`. |
| Ignore `linhas_esperadas` mismatch | `tests/schedules.controller.test.ts:806` would not produce `BASE_STATE_INVALID`. |

**Result**: PASS by targeted test coverage and branch inspection.

---

## Summary

Overall: ready for Bubble branch `test` validation.
