# Delta Motor Recalculation Specification

> **Operational status (2026-09-17): superseded and disabled.** The payload v3 fast path remains implemented for historical compatibility but must not be enabled. Real Bubble runs showed recurring `STATE_DRIFT` because the latest active request was not a stable structural base, event history had no cutoff, date-only events could shift calendar day, and delta requests could become nested bases. The replacement is the guardian-based payload v4 contract recorded in `docs/delta-v4-guardian-contract-2026-09-17.md` and decisions AD-028 through AD-033.

## Problem Statement

Bubble currently computes dependent schedule deltas before calling the engine. Large works can time out while Bubble traverses the dependency graph. The engine must accept a self-contained v3 recalculation request, rebuild the active schedule from the stored base payload and event history, apply the new pencil event, and patch only rows whose dates changed.

## Goals

- [ ] Stop re-persisting old schedule events during in-place recalculations.
- [ ] Preserve event calendar dates exactly as `yyyy-mm-dd` without timezone drift.
- [ ] Accept `payload_version: 3` with `scope.tipo: "delta_motor"` on `POST /api/v1/schedules/recalculate`.
- [ ] Rebuild current state from `base.payload + events_old`, apply `events_json`, validate guards, and patch only changed Bubble rows.

## Out of Scope

| Feature | Reason |
| --- | --- |
| New endpoint | Revision 4 keeps the existing `/api/v1/schedules/recalculate` endpoint. |
| Bubble-side workflow changes | Bubble will send v3 only after the engine contract is available. |
| Structural `estrutura_id` validation | Revision 4 says it is log/correlation only because the newest-row creation date exists only in Bubble. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| `base.payload` shape | Accept object or JSON string | Bubble stores the original request as JSON text, but tests and callers may pass an object. | y |
| Event order tie-break | `requisicao_data`, then `criado_em`, then `evento_id` | Contract revision 4 defines this order. | y |
| v3 line lookup type name | Use configured Atividade x Obra Data API type | Existing service already centralizes this setting. | y |
| v3 patch date guard | Compare Bubble `dataInicioPrevista` to reconstructed current start date for each changed row | Contract requires drift detection before writes. | y |

**Open questions:** none.

---

## User Stories

### P1: Clean Event History

**User Story**: As the schedule engine, I want to persist only new recalculation events and calendar-safe event dates so that future event replay is trustworthy.

**Acceptance Criteria**:

1. WHEN an in-place recalculation includes `events_old` and `events_json` THEN the engine SHALL persist only records derived from `events_json`.
2. WHEN an event date or request date is received as `yyyy-mm-dd` or a Bubble timestamp THEN the persisted `EventoCronograma` date SHALL keep the same calendar day at `T12:00:00.000Z`.

**Independent Test**: Build/persist event records and assert old events are absent and date fields keep the expected calendar day.

---

### P1: Delta Motor Recalculation

**User Story**: As Bubble, I want to send `payload_version: 3` with the active base payload and event history so that the engine computes and persists the delta without Bubble graph traversal.

**Acceptance Criteria**:

1. WHEN a valid v3 delta request is accepted THEN the endpoint SHALL return `202` and process it through the existing webhook job flow.
2. WHEN `base.payload` rebuilds a line count different from `linhas_esperadas` THEN the final webhook SHALL return `error_code: "BASE_STATE_INVALID"` and no Atividade x Obra PATCH SHALL be sent.
3. WHEN the target line is absent from the rebuilt base THEN the final webhook SHALL return `error_code: "BASE_STATE_INVALID"` and include the target id in `error_message`.
4. WHEN replayed current state disagrees with `scope.data_atual_inicio` THEN the final webhook SHALL return `error_code: "STATE_DRIFT"` before Bubble writes.
5. WHEN Bubble lookup returns a changed row whose `dataInicioPrevista` differs from reconstructed current state THEN the final webhook SHALL return `error_code: "STATE_DRIFT"` before PATCH.
6. WHEN a valid v3 cascade moves dependent rows THEN the engine SHALL lookup changed rows by external id, PATCH only changed rows, persist only the new event, and report `patchedCount` for those rows.
7. WHEN `activity_date_changed_only` appears in `events_old` THEN replay SHALL move only the target line and not dependents.

**Independent Test**: Controller tests covering happy path and the documented failure codes.

---

## Edge Cases

- WHEN `base.payload` is missing or invalid JSON THEN system SHALL fail the job with `BASE_STATE_INVALID`.
- WHEN a changed external id is missing from Bubble lookup THEN system SHALL fail the job with `BASE_STATE_INVALID`.
- WHEN `scope.data_atual_inicio` is omitted THEN system SHALL skip the target-date anchor check and still run per-row Bubble drift checks.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| DMR-01 | P1: Clean Event History | Execute | Verified |
| DMR-02 | P1: Delta Motor Recalculation | Execute | Verified |
| DMR-03 | Edge cases | Execute | Verified |

**Coverage:** 3 total, 3 mapped to tests, 0 unmapped.

---

## Success Criteria

- [ ] Full Vitest suite passes.
- [ ] TypeScript build passes.
- [ ] v2/v1 recalculate compatibility remains covered by existing tests.
