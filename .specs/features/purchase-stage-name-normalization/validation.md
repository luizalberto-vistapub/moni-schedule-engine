# Purchase Stage Name Normalization Validation

**Date**: 2026-07-31
**Spec**: `C:\Users\luizl\Projetos\moni-schedule-engine\.specs\features\purchase-stage-name-normalization\spec.md`
**Diff range**: `041d977^..59e1230`
**Commits reviewed**: `041d977`, `59e1230`
**Verifier**: independent sub-agent (author != verifier)
**Verdict**: **PASS**

---

## Task Completion

No `tasks.md` exists for this small feature. The accumulated diff contains the spec, the localized normalization change, and its acceptance-test matrix.

| Deliverable | Status | Evidence |
| --- | --- | --- |
| Recognize embedded purchase stages | Done | `src/services/normalize-payload.service.ts:58-70` |
| Support aliases with and without `de` | Done | `tests/schedule-engine.service.test.ts:254-259,266-272` |
| Preserve generic parent exclusion | Done | `tests/schedule-engine.service.test.ts:261,266,274` |
| Enforce normalized word boundaries | Done | `tests/schedule-engine.service.test.ts:262,266,275` |

---

## Spec-Anchored Acceptance Criteria

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| PSN-01 | Embedded `Aviso [de] orçamento` -> `AVISO_ORCAMENTO` | `tests/schedule-engine.service.test.ts:254-255,266-268` — inputs with and without `de`; aggregate `toEqual` asserts `AVISO_ORCAMENTO` twice. | **PASS** |
| PSN-02 | Embedded `Limite [de] orçamento` -> `LIMITE_ORCAMENTO` | `tests/schedule-engine.service.test.ts:256-257,266,269-270` — inputs with and without `de`; exact enum asserted twice. | **PASS** |
| PSN-03 | Embedded `Limite [de] compra` -> `LIMITE_COMPRA` | `tests/schedule-engine.service.test.ts:258-259,266,271-272` — inputs with and without `de`; exact enum asserted twice. | **PASS** |
| PSN-04 | Embedded complete normalized word `Recebimento` -> `RECEBIMENTO` | `tests/schedule-engine.service.test.ts:260,266,273` — exact `RECEBIMENTO` asserted. | **PASS** |
| PSN-05 | Generic parent with none of the four child stages -> `null` | `tests/schedule-engine.service.test.ts:261,266,274` — exact `null` asserted. | **PASS** |

**Status**: **5/5 acceptance criteria match the precise spec outcomes.**

### Scope and edge cases

- Accent-insensitive matching is exercised by accented `orçamento` inputs at `tests/schedule-engine.service.test.ts:254-257`.
- Both prefix and suffix placement are represented in `tests/schedule-engine.service.test.ts:254-260`.
- Exact aliases remain present at `src/services/normalize-payload.service.ts:59-65`; all pre-existing regressions pass.
- Normalized word boundaries are implemented by padded token matching at `src/services/normalize-payload.service.ts:68-69`.
- `Pré-recebimentos` normalizes to a larger token rather than the complete `RECEBIMENTO` word and is asserted `null` at `tests/schedule-engine.service.test.ts:262,266,275`.
- Purchase anchoring and consolidation are unchanged and their regression tests pass in the full suite.

---

## Gate Check

| Gate | Command | Result |
| --- | --- | --- |
| Focal | `vitest run tests/schedule-engine.service.test.ts -t "reconhece as quatro etapas dentro do nome complementado e rejeita a compra mae"` | **PASS** — 1 passed; 53 filtered by the name selector |
| Full suite | `vitest run` | **PASS** — 6 files, 131 passed, 0 failed, 0 skipped |
| Type check | `tsc --noEmit` | **PASS** — exit 0 |
| Build | `tsc` (`npm run build` equivalent) | **PASS** — exit 0 |
| Diff hygiene | `git diff --check 041d977^ 59e1230` | **PASS** |

Test integrity:

- Feature base `041d977^`: 130 tests.
- Final feature `59e1230`: 131 tests.
- Delta: **+1 test**, expanded by the fix commit to cover four additional fixtures.
- No test deletion, weakening, skip marker, or unrelated tracked worktree change was found.

---

## Discrimination Sensor

**Scratch state**: exported snapshot of `59e1230` outside the real repository.
**Sensor depth**: lightweight, one behavior-level mutation.

| Mutation | Location | Observation | Result |
| --- | --- | --- | --- |
| Replace embedded alias search (`padded.includes`) with the old exact lookup `return aliases[normalized] || null` | scratch copy of `src/services/normalize-payload.service.ts:68-70` | Focal test failed at `tests/schedule-engine.service.test.ts:266`: all seven embedded positive cases became `null`; the generic parent and partial-word cases remained `null`. | **KILLED** |

**Sensor result**: **1/1 killed — PASS**. The mutation existed only in scratch and was discarded.

---

## Code Quality

| Principle | Status | Notes |
| --- | --- | --- |
| Minimum code / no unnecessary abstraction | PASS | Three-line localized lookup reuses the existing alias table. |
| Surgical changes / no scope creep | PASS | Accumulated diff touches only spec, normalizer, and directly related test. |
| Matches existing style | PASS | Existing normalization pipeline and Vitest conventions retained. |
| No unrelated improvements | PASS | None found in `041d977^..59e1230`. |
| Test integrity and discrimination | PASS | One additive test; exact-value assertion; required mutant killed. |
| Spec-anchored outcomes | PASS | Every PSN outcome is asserted exactly. |
| Domain 1:1 acceptance coverage | PASS | PSN-01..05 plus the word-boundary scope rule are represented. |
| Every new test is claimed | PASS | All nine fixtures map to an AC or explicit scope edge case. |
| Documented guidelines | PASS | `README.md` scripts, `vitest.config.ts`, `tsconfig.json`, and strong defaults applied; no project `AGENTS.md`, `CONTRIBUTING.md`, or `TESTING.md` was found. |

No actionable code-quality issue was found.

---

## Requirement Traceability

| Requirement | Validation status |
| --- | --- |
| PSN-01 | Verified |
| PSN-02 | Verified |
| PSN-03 | Verified |
| PSN-04 | Verified |
| PSN-05 | Verified |
| Normalized word-boundary scope | Verified |
| Existing aliases / anchoring / consolidation regressions | Verified |

No source spec status was edited because verification was explicitly read-only over the real repository. A clean PASS produces no project lesson.

---

## Summary

**Overall**: **READY**

- Spec-anchored check: **5/5 matched**
- Gate: **131 passed, 0 failed; typecheck and build passed**
- Sensor: **1/1 mutation killed**
- Word-boundary regression: **covered and passing**
- Issues found: **none**
