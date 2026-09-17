# Remove Local Atuacao Validation

- Date: 2026-09-17
- Verdict: PASS (bounded independent verification)
- Verifier: independent TLC verifier; author != verifier.
- Branch: codex/bubble-bulk-persistence
- Diff: ccf5504eb14c7d5aa492fa06808f2b51f7236403..e731f943d2634591d075aec1f063e3b0663163d9
- Spec: .specs/features/remove-local-atuacao/spec.md

## Spec-Anchored Coverage

| AC | Required outcome | Exact assertion evidence | Result |
| --- | --- | --- | --- |
| AC-1 | Missing field accepted; service, purchase and project records generated; controller fixtures accepted | tests/bubble-bulk.service.test.ts:1196 `expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ atividade: "serv_1" }), expect.objectContaining({ atividade: "compra_1" }), expect.objectContaining({ atividade: "projeto_1" })]))`; :1201 `expect(records.every((record) => !Object.prototype.hasOwnProperty.call(record, "localAtuacao"))).toBe(true)`; tests/schedules.controller.test.ts:174 `expect(response.status).toBe(202)`; :175 `expect(response.body.ok).toBe(true)`; :202 `expect(webhookBody.metrics).toMatchObject({ linesCount: 3, createdCount: 3, bulkBatchCount: 1, bulkRetryCount: 0, dedupDroppedCount: 0 })` | PASS |
| AC-2 | Legacy catalog/historical values absent from ScheduleLine and Atividade x Obra fields | tests/bubble-bulk.service.test.ts:1172 `expect(line).not.toHaveProperty("localAtuacao")`; :1173 `expect(record).toMatchObject({ atividade: "serv_1" })`; :1174 and :1218 `expect(record).not.toHaveProperty("localAtuacao")`; :1217 activity identity assertion | PASS |
| AC-3 | No field-specific bulk/PATCH fallback; successful legacy request posts activity batch once without field | tests/bubble-bulk.service.test.ts:642 `expect(atividadeObraPostCalls).toHaveLength(1)`; :643 `expect(String(atividadeObraPostCalls[0]?.[1]?.body)).not.toContain("\"localAtuacao\"")`; latest src/services/bubble-bulk.service.ts diff removes both field-specific fallback branches and their helpers | PASS |

All 3 ACs match the specified outcomes; no spec-precision gaps. The single implicit task is complete by reviewed diff and targeted evidence; no tasks.md exists for this small feature.

## Static Review And Edge Cases

- `rg -n -i 'local.?atua' src` returned no matches (exit 1 means no matches). No field-specific missing-field rejection remains. Parser schema uses arbitrary record arrays and passthrough (src/services/normalize-payload.service.ts:12-48), so absence is accepted.
- Normalization, linked/direct project merge, engine line construction, controller snapshot line construction and both public types lose the field in the latest diff.
- Historical fields use an explicit allowlist: src/services/bubble-bulk.service.ts:27 and :274-286. The retired field is absent from that list; spreading previousFields at :1121 cannot forward it.
- Legacy raw metadata may remain in raw containers as expressly allowed. It is not promoted into ScheduleLine or activity Bubble fields. ScheduleLine construction is explicit, including snapshot construction; no broad raw spread adds the retired field.
- Missing field across all three activity types, catalog legacy value, conflicting historical legacy value and successful mocked legacy persistence are covered by the selected tests.
- Test changes retire obsolete expectations under explicit user authorization. They assert the new contract rather than weakening expectations to accommodate an implementation bug. Bubble test declarations remain 58 before and after; no tests deleted or disabled in the diff.
- Changes are scoped to field removal and its tests/spec/state. No new abstraction, flexibility or unrelated refactor. Existing patterns retained. Domain and controller evidence cover this diff surface; no new route was introduced. No AGENTS.md found by repository file search; TLC coding-principles.md reviewed.

## Baseline And Gate Provenance

The implementation agent ran the TypeScript build and sequential 194-test suite successfully before committing. Those gate results were supplied to this independent verifier by the implementation agent, not the user; they were NOT rerun by this verifier. Independent execution was limited to targeted synthetic tests. The only changed test file retains 58 declarations.

Independent baseline ran in `.verifier-remove-local-scratch`, with copied src/tests/package.json/tsconfig.json/vitest.config.ts and parent node_modules resolution; no dependencies copied:

```text
node ../node_modules/vitest/vitest.mjs run tests/bubble-bulk.service.test.ts tests/schedules.controller.test.ts -t 'localAtuacao|legacy local atuacao|accepts a schedule job immediately' --maxWorkers=1 --minWorkers=1
```

Baseline: exit 0, 5 passed, 0 failed, 119 filtered/skipped out of 124 collected. Filtering is intentional bounded scope, not disabled tests. All selected persistence/webhook calls use vi.stubGlobal fetch mocks and test-generated fixtures; controller HTTP uses local supertest. No real payloads or external writes were used.

Initial launch from repository root used the wrong relative runner path and did not load tests. Correct scratch launch was blocked by sandbox esbuild directory traversal, before tests loaded. The same bounded command with approved escalation ran successfully; neither startup failure is counted as a test baseline or mutation kill.

`git diff --check` passed independently.

## Discrimination Sensor

Exactly ONE behavior mutation was applied only to copied source: scratch src/services/bubble-bulk.service.ts:1091, inside buildAtividadeObraRecords, added `localAtuacao: 'indoor',` after copyDuracao (real source insertion point :1090).

The identical targeted command returned exit 1: 4 failed, 1 passed, 119 filtered/skipped. The mutant was killed by actual behavioral assertions at tests/bubble-bulk.service.test.ts:643, :1174, :1201 and :1218. Failures explicitly showed emitted field `localAtuacao` with value `indoor`; no import/build/setup failure caused the kill. Controller acceptance still passed.

Sensor depth: requested lightweight one-mutation check. Result: 1 injected, 1 killed, 0 survived.

Scratch directory was removed after the sensor. Real source/tests were never edited. No commit, push or deployment performed. Only this validation report is written in the real tree.

## Outcome

PASS for AC-1 through AC-3 and the requested sensor. No ranked gaps or fix tasks. Backend-only change: interactive UAT not applicable. All three requirements are verified in this report; spec.md remains unchanged per bounded verifier scope. Clean PASS supplies no grounded failure signal for a TLC lesson.
