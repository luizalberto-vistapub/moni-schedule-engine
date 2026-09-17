# Cascade Clone Boundary Validation

Date: 2026-09-17
Verdict: PASS (bounded synthetic verification)
Verifier: independent reviewer; did not author implementation.
Commit: dc71b0e1059ebb55ad8e2fb93c1a4f67cea3a495
Diff range: HEAD^..HEAD at the commit above.

## Scope And Gate

Read the complete TLC references/validate.md and coding-principles.md. Reviewed the latest controller/test diff and surrounding dependency, mobility and business-day helpers. The feature has one implicit atomic task and no tasks.md; implementation, regressions and spec are present in the latest commit.

TypeScript build and all 194 tests passed according to the author gate supplied by the requester. This is accepted author evidence, not an independently repeated full gate. The latest diff adds three executable cases (it.each(false,true) plus one test), deletes no tests and weakens no existing assertions; implied preceding total is 191, not independently executed here. Independent git diff --check HEAD^ HEAD passed.

No Live access, real Bubble payload replay, external writes, commits, pushes or deployment occurred. Controller beforeEach at tests/schedules.controller.test.ts:10-37 replaces global fetch with vi.fn for GET, PATCH, bulk and webhook calls. Supertest exercises the local Express app with synthetic basePayload fixtures.

## Exact Acceptance Evidence

All line references below are in tests/schedules.controller.test.ts at the reviewed commit.

| AC | Spec outcome and fixture | Exact assertion evidence | Result |
| --- | --- | --- | --- |
| AC-1 | Structural sparse history: five mount dates 2026-09-15,16,17,18,21; historical release 16; root event equals original 14 (zero delta). Fixture :668-692 uses only one historical mount when snapshotMode=false. | :703 `expect(records.filter((row) => row.id_atividade_obra_externo.startsWith("mount\u007c")).map((row) => row.dataInicioPrevista.slice(0, 10))).toEqual(dates)`; :704 `expect(records.find((row) => row.id_atividade_obra_externo === "release\u007camb_1\u007c1")).toMatchObject({ dataInicioPrevista: "2026-09-22T12:00:00.000Z" })`. | PASS, executed |
| AC-2 | Snapshot has all five mount occurrences; input lists next, release, mount, root in reverse dependency order (:683-687). Release must start 22 and downstream next 23. | :699 `expect(patches.axo_release).toMatchObject({ dataInicioPrevista: "2026-09-22T12:00:00.000Z" })`; :700 `expect(patches.axo_next).toMatchObject({ dataInicioPrevista: "2026-09-23T12:00:00.000Z" })`. Structural downstream counterpart :705 asserts the same next date. | PASS, executed |
| AC-3 | Snapshot late dependent 2026-09-29 remains valid; completed row 2026-09-16 does not move (:717-718). Only-date fixture changes serv_2 while serv_1 and downstream serv_3 retain their dates (:773-786). | :753 `expect(patches.late_1).toBeUndefined()`; :754 `expect(patches.done_1).toBeUndefined()`. Existing only-date test :794 `expect(records.find((record) => record.atividade === "serv_1")).toMatchObject({ dataInicioPrevista: "2026-05-04T12:00:00.000Z" })`; :795 serv_2 asserts `2026-05-11T12:00:00.000Z`; :796 serv_3 asserts `2026-05-06T12:00:00.000Z`. | PASS; late/completed executed, only-date reviewed statically and included in supplied author gate |
| AC-4 | Two release occurrences originally 16,17 move together to working days 22,23; successor follows final occurrence on 24. Mount spans Friday 18 to Monday 21 (:712-716). | :750 `expect(patches.release_1).toEqual({ dataInicioPrevista: "2026-09-22T12:00:00.000Z", dataFimPrevista: "2026-09-22T12:00:00.000Z" })`; :751 release_2 asserts both fields `2026-09-23T12:00:00.000Z`; :752 next_1 asserts both fields `2026-09-24T12:00:00.000Z`. | PASS, executed |

The escaped pipe characters in AC-1 identify literal pipes in the source strings. AC-3 intentionally specifies invariance rather than a new date; absence of a PATCH for the known row IDs is the persistence-boundary assertion. All four ACs have concrete expected outcomes and matching assertions. No uncovered AC or spec-precision gap identified.

## Independent Synthetic Execution

Scratch: .verifier-cascade-scratch inside the repository, containing only copied src/, tests/, package.json, tsconfig.json and vitest.config.ts; dependencies resolved from parent node_modules. No dependency tree, environment file or real payload fixture was copied.

Command from scratch directory:

```powershell
node ../node_modules/vitest/vitest.mjs run tests/schedules.controller.test.ts -t 'cascade release after|working-day clone spacing' --no-file-parallelism
```

Baseline: exit 0, 3 passed, 63 skipped by the explicitly requested name filter (66 controller cases discovered). These are filter exclusions, not disabled tests. Initial sandbox invocation could not resolve the config due to parent-directory access restrictions and collected no tests; retry with approved elevated execution succeeded. No automatic approval rejection occurred in this verification.

## Single Discrimination Sensor

Only scratch src/controllers/schedules.controller.ts:992 was changed:

```diff
- const endDate = predecessorDates.sort().at(-1)!;
+ const endDate = predecessorDates.sort().at(0)!;
```

The identical targeted command returned exit 1: 3 failed, 63 filtered out. Mutation killed, 1/1; zero survived.

| New case | Failing assertion | Observed fault |
| --- | --- | --- |
| cascade release after all predecessor clones, snapshot=false | :704 | Expected release start 2026-09-22T12:00:00.000Z; received 2026-09-16T12:00:00.000Z. |
| cascade release after all predecessor clones, snapshot=true | :699 | Expected release start field 2026-09-22T12:00:00.000Z; actual patch lacked that field and contained dataFimPrevista 2026-09-16T12:00:00.000Z. |
| working-day clone spacing | :750 | Expected release_1 start/end 2026-09-22T12:00:00.000Z; received both 2026-09-21T12:00:00.000Z. |

Each case stops at its first failing assertion. This proves discrimination for the final-predecessor boundary; it does not independently prove mutation sensitivity of later assertions, completed-row invariance or only-date behavior. Scratch was discarded after recording results; real source/tests were never mutated.

## Implementation Review And Limits

No actionable bug found in the latest diff for AC1-4. Added helper :975-1013 indexes only normalized service lines (:979), visits affected predecessors first (:985-989), takes the maximum occurrence across service predecessors (:992), requires the next working day (:994), and shifts movable clones by a common business-day offset (:1002-1004). Existing lineCanMove (:622-626) preserves completed snapshot rows and delta anchors. The helper is called only after cascade replay (:1067-1069); only-date behavior bypasses it. Unaffected IDs are excluded from visits and non-service rows pass through unchanged. The pre-existing replay shift can still move other activity types; only the newly added boundary repair is service-specific.

Change is scoped to the controller helper/import/call, three meaningful regression cases, and feature spec. Existing project TypeScript/Vitest patterns and TLC coding-principles.md are followed; no unrelated refactor or assertion weakening found. New cases map to AC1/2 and AC3/4 respectively.

Limits: only the requested three cases were independently executed. No new dedicated non-service/unaffected-ID assertion, six-day calendar, multi-predecessor combination, cycle, non-working historical date, or nonzero-delta sensor was run; service-only scoping is supported by implementation inspection. These are residual breadth limits, not demonstrated AC failures. No frontend UAT is applicable. No lessons were recorded because there is no failed/uncovered AC, surviving mutant or spec deviation. Requirement verification is recorded here; spec.md was left unchanged per bounded review scope.

Ranked gaps: none requiring a fix for AC1-4. PASS relies on the supplied author build/full-suite gate and the independent targeted synthetic baseline plus killed mutation described above.
