# Atividade x Obra valorRaiz Validation

**Date**: 2026-08-05  
**Spec**: `.specs/features/atividade-obra-valor-raiz/spec.md`  
**Feature commit audited**: `8635fbe` (`feat(schedule): calculate atividade obra valor raiz`)  
**Verifier**: independent sub-agent attempted; final validation executed by primary fallback after verifier timeout  
**Verdict**: **PASS**

## Scope and Integrity

- Reviewed feature scope: `src/services/bubble-bulk.service.ts`, `tests/bubble-bulk.service.test.ts`, and `.specs/features/atividade-obra-valor-raiz/spec.md`.
- No permanent mutation was left in the repository.
- Final `git status --short --branch`: `## main...origin/main [ahead 1]` before writing this validation report.

## Spec-Anchored Acceptance Criteria

| Criterion | Spec-defined outcome | Evidence (`file:line` + assertion) | Result |
| --- | --- | --- | --- |
| AC1 | Purchase daughter `valorRaiz` equals simple-product `valor * percentual` for the purchase activity. | `tests/bubble-bulk.service.test.ts:541` — `expect(purchaseValorRaiz).toEqual([150, 150, 150, 150]);` with product value `600` and purchase percentual `0.25`. | **PASS** |
| AC2 | The same purchase calculation is applied to every generated purchase daughter for the product. | `tests/bubble-bulk.service.test.ts:541` — `expect(purchaseValorRaiz).toEqual([150, 150, 150, 150]);` asserts all four purchase daughters receive the same calculated value. | **PASS** |
| AC3 | Service/manpower `valorRaiz` equals simple-product `valor * (percentual / generated copy count)` in the same product/context. | `tests/bubble-bulk.service.test.ts:540` — `expect(serviceValorRaiz).toEqual([100, 100, 100]);` with product value `1000`, percentual `0.3`, and three service copies. | **PASS** |
| AC4 | Missing/unusable `valor` or `percentual` fills `valorRaiz` with `0` without blocking record building. | `tests/bubble-bulk.service.test.ts:427` — `valorRaiz: 0` in the optional-fields Atividade x Obra record assertion. | **PASS** |

**Spec-anchored status**: **4/4 criteria covered. No uncovered criteria or spec-precision gaps.**

## Functional Gates

| Gate | Command | Result |
| --- | --- | --- |
| Focused bulk tests | `npm.cmd test -- --run tests/bubble-bulk.service.test.ts` | **PASS** — 30 passed, 0 failed. |
| Full suite | `npm.cmd test` | **PASS** — 6 files, 132 tests passed, 0 failed. |
| TypeScript/build | `npm.cmd run build` | **PASS** — exit 0, no diagnostics. |

## Discrimination Sensor

Mutation applied temporarily and reverted with `apply_patch`.

| Mutation | Target | Evidence of kill | Result |
| --- | --- | --- | --- |
| Remove service-copy divisor from `valorRaizForLine`, changing service calculation to `valorProduto * percentual`. | `src/services/bubble-bulk.service.ts` service branch | Focused run failed in `tests/bubble-bulk.service.test.ts:540`: received `[300, 300, 300]`, expected `[100, 100, 100]`. | **KILLED** |

**Sensor result**: **1/1 killed — PASS**.

## Payload Smoke Validation

The attached payload `C:/Users/luizl/.codex/attachments/7660f0bb-5b02-4396-bbc4-e5989f7015b3/pasted-text.txt` was parsed with default empty arrays for absent optional root arrays, then passed through `normalizePayload`, `runScheduleEngine`, and `buildAtividadeObraRecords`.

- Lines/records generated: `51`.
- Engine warnings: none.
- Atividade x Obra with non-zero `valorRaiz`: purchases `8/12`, services `24/36`.
- Repeating decimal service case was rounded to `100` instead of leaking `99.99999999999999`.

## Code Quality

| Principle | Status | Notes |
| --- | --- | --- |
| Focused change | PASS | Calculation is isolated to Atividade x Obra bulk record construction. |
| Deterministic context | PASS | Product value lookup uses the contextual product record id first, then product id fallback. |
| Monetary float hygiene | PASS | `valorRaiz` is rounded to two decimal places before persistence. |
| Test integrity | PASS | Assertions check emitted record values, not only method calls. |

No actionable gaps remain.
