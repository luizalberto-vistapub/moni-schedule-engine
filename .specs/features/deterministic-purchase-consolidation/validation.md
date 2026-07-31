# Deterministic Purchase Consolidation Validation

**Date**: 2026-07-31
**Spec**: `.specs/features/deterministic-purchase-consolidation/spec.md`
**Diff range**: `fe19242^..7957304`
**Fix commit**: `7957304` (`Strengthen purchase consolidation guarantees`)
**Verifier**: independent sub-agent (author != verifier)
**Verdict**: **PASS**

## Scope and Integrity

- Reviewed the complete feature diff and the focused fix diff `fe19242..7957304`.
- The real repository remained read-only and `git status --short` was empty after verification.
- Gates and mutations ran in an exact archive of commit `7957304`.
- Both mutations were reverted. Restored scratch versus real service: `LINE_DIFF_COUNT=0`.
- No `tasks.md` exists for this feature; task-completion bookkeeping is not applicable.

## Spec-Anchored Acceptance Criteria

| Criterion | Spec-defined outcome | Evidence (`file:line` + assertion) | Result |
| --- | --- | --- | --- |
| DPC-01 | One purchase per product/stage; earliest valid `createdAt`; invalid/missing values last; timestamp tie by lexicographically smallest activity ID. | `tests/schedule-engine.service.test.ts:1145-1170` supplies an older timestamp expressed with an offset, a newer UTC timestamp, and two equal oldest timestamps with IDs `z_...`/`a_...`; `:1163` asserts one line, `:1164-1169` asserts exact ID/stage/anchor/context, and `:1170` asserts no warnings. Timestamp parsing and ID fallback are implemented at `src/services/schedule-engine.service.ts:246-253`; product+stage dedup at `:329-337`. | **PASS** |
| DPC-02 | Consider services from every composite containing the simple product and choose the lowest `ordem`. | `tests/schedule-engine.service.test.ts:980-1076` supplies two composites and asserts every canonical stage anchors to `servico_ordem_1` with `compra_ordem_1`. `:1133-1143` independently proves order precedes an opposed date. | **PASS** |
| DPC-03 | Equal `ordem` chooses earliest calculated start date. | `tests/schedule-engine.service.test.ts:1079-1103` asserts the two exact service dates and anchor/context of the earlier one. | **PASS** |
| DPC-04 | Equal `ordem` and start date chooses lexicographically smallest service ID. | `tests/schedule-engine.service.test.ts:1106-1129` asserts equal dates and exact anchor `a_servico` / context `compra_a`. | **PASS** |
| DPC-05 | Input order and received anchor do not alter purchase IDs, stages, dates, service anchors, or contextual products. | `tests/schedule-engine.service.test.ts:1043-1076` generates reversed arrays with a different received anchor, asserts the exact five-field baseline, then asserts full equality. | **PASS** |
| DPC-06 | Project and unresolved-anchor behavior remain unchanged. | Pre-existing regression tests still pass: `tests/schedule-engine.service.test.ts:593-617` asserts resolved warning silence and exact unresolved warning; `:1173-1184` asserts unresolved purchase/project lines remain absent; `:1408-1440` asserts direct Project anchor/product fields. Full-suite success confirms these unchanged tests. | **PASS** |

**Spec-anchored status**: **6/6 criteria match exact spec outcomes. No uncovered criteria or spec-precision gaps.**

## Functional Gates

| Gate | Command | Result |
| --- | --- | --- |
| Feature focal | `vitest run tests/schedule-engine.service.test.ts -t "consolida compras repetidas|desempata a ancora|prioriza a menor ordem|escolhe a compra mais antiga"` | **PASS** — 5 passed, 0 failed; 48 intentionally filtered. |
| Full suite | `vitest run` | **PASS** — 6 files, 130 tests passed, 0 failed, 0 skipped. |
| TypeScript/build | `tsc -p tsconfig.json` | **PASS** — exit 0, no diagnostics. |

Test integrity:

- Feature base (`fe19242^`): 125 tests.
- Final feature (`7957304`): 130 tests.
- Delta: **+5 tests**; no deleted or weakened tests found.

Global coverage remains informational and was not rerun because its repository-wide 100% threshold is a known pre-existing baseline condition. It is separate from the passing functional gates.

## Discrimination Sensor

Both mutations were applied only to scratch and discarded.

| Mutation | Target | Evidence of kill | Result |
| --- | --- | --- | --- |
| M1 — swap anchor priority from `ordem -> date` to `date -> ordem` in `compareAnchorPriority`. | `src/services/schedule-engine.service.ts:255-261` | Focused run failed at `tests/schedule-engine.service.test.ts:1142`: received positive `2678400000`, expected `< 0`. | **KILLED** |
| M2 — remove product+stage dedup by adding activity ID to the canonical map key. | `src/services/schedule-engine.service.ts:329-337` | Focused run failed twice: consolidation produced 8 lines instead of 4 at `:1070`; timestamp/ID scenario produced 3 lines instead of 1 at `:1163`. | **KILLED** |

**Sensor result**: **2/2 killed — PASS**.

## Code Quality

| Principle | Status | Notes |
| --- | --- | --- |
| Minimum, focused code | PASS | The fix extracts only the comparator seam needed to state and test precedence. |
| Surgical changes / no scope creep | PASS | Only spec, engine, and engine tests changed. |
| Timestamp correctness | PASS | `Date.parse` provides chronological comparison across equivalent ISO offsets; invalid/missing policy is specified. |
| Exact AC mapping | PASS | Every DPC criterion has a precise assertion target. |
| Test integrity and discrimination | PASS | Five net-new tests over the feature; both high-risk mutants die. |
| Existing patterns/style | PASS | Small pure comparator, existing functional style, Vitest assertions. |
| Project guidelines | PASS | No project-level `AGENTS.md`, `CONTRIBUTING.md`, or `TESTING.md`; `vitest.config.ts`, `tsconfig.json`, and strong defaults applied. |

No actionable code-quality gaps were found in `fe19242^..7957304`.

## Requirement Traceability

| Requirement | Final status |
| --- | --- |
| DPC-01 | Verified |
| DPC-02 | Verified |
| DPC-03 | Verified |
| DPC-04 | Verified |
| DPC-05 | Verified |
| DPC-06 | Verified |

## Summary

**Overall: READY — PASS.**

- Spec-anchored check: 6/6.
- Functional gates: focal 5/5, full suite 130/130, TypeScript build clean.
- Sensor: 2/2 mutants killed.
- Previous gaps are closed: timestamp semantics, ID tie-break, warning silence, and order-before-date priority all have direct evidence.
- Clean PASS produces no new lesson entry.
