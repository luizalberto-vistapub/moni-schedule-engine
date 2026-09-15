# STATE

## Decisions

### AD-001
- **Decision**: `main` and `codex/bubble-bulk-persistence` must remain identical for the Bubble bulk persistence work.
- **Reason**: The user expects both branches to carry the same production-ready schedule engine state and questioned direct edits on `main` when the copy branch was already valid.
- **Trade-off**: Branch operations must include an explicit equality check before declaring the work done.
- **Scope**: Git workflow for Bubble bulk persistence and schedule recalculation fixes.
- **Date**: 2026-08-21
- **Status**: superseded by AD-008

### AD-002
- **Decision**: The Bubble field `ambiente x obra` must be populated from `obra_ambiente_json[]."id ambiente x obra"` only.
- **Reason**: The previous source `line.ambienteId` was confirmed wrong; the correct Atividade x Obra relation is the new `id ambiente x obra` value in the payload.
- **Trade-off**: No fallback to the old field is allowed, so missing composition links must remain visible instead of being silently masked.
- **Scope**: Payload normalization, schedule line context, and Bubble Atividade x Obra bulk records.
- **Date**: 2026-08-21
- **Status**: active

### AD-003
- **Decision**: Keep `sem_ambiente` when the composition-to-environment link is empty.
- **Reason**: The user confirmed this is the intended diagnostic signal for missing environment linkage.
- **Trade-off**: Generated external IDs can expose missing environment data instead of forcing an environment relation.
- **Scope**: Schedule external IDs and environment resolution.
- **Date**: 2026-08-21
- **Status**: active

### AD-004
- **Decision**: Recalculation must create Atividade x Obra records for the new schedule version unless an existing record is found in that same version.
- **Reason**: Patching previous-version Bubble unique IDs left new versions without updated Atividade x Obra records and caused invalid/empty bulk behavior.
- **Trade-off**: Previous snapshots are used only for hydration/carry-over, not as persistence identities for the new version.
- **Scope**: Bubble bulk persistence and schedule recalculation.
- **Date**: 2026-08-21
- **Status**: active

### AD-005
- **Decision**: Shared project activities must be deduplicated and anchored to the service activity with the smallest planned execution date.
- **Reason**: The user confirmed that a project referenced by several activities should appear once, anchored to the earliest planned service activity.
- **Trade-off**: Recalculation line counts may legitimately shrink when duplicates collapse into one project line.
- **Scope**: Schedule engine project-line generation.
- **Date**: 2026-08-21
- **Status**: active

### AD-006
- **Decision**: Project lines returned to Bubble must carry project contract metadata and the service anchor.
- **Reason**: Bubble now sends project anchors and expects the engine bulk return to map `projeto`, `tipoProjeto`, `diasAntecedencia`, responsible/status fields, and master/service anchor identity.
- **Trade-off**: If Bubble omits project metadata, the engine can only echo/preserve what exists in the payload or previous snapshot.
- **Scope**: Normalization, schedule lines, and Bubble Atividade x Obra bulk mapping for type `Projeto`.
- **Date**: 2026-08-21
- **Status**: active

### AD-007
- **Decision**: Atividade x Obra bulk records must send both `familia` and `nomeFamilia`.
- **Reason**: Bubble exposes both fields and the user asked for the family received in `atividades_json` to be echoed in creation bulk.
- **Trade-off**: When `nomeFamilia` is absent, `familia` is used as the best available label.
- **Scope**: Payload types, schedule lines, and Bubble bulk record creation.
- **Date**: 2026-08-21
- **Status**: active

### AD-008
- **Decision**: Schedule recalculation changes must be committed and pushed only to `codex/bubble-bulk-persistence` until the user explicitly promotes them.
- **Reason**: The current validation cycle is happening against Bubble branch `test`, and the user repeatedly requested that `main` remain untouched.
- **Trade-off**: Branch equality with `main` is no longer the completion criterion for this workstream.
- **Scope**: Git workflow for schedule recalculation, Bubble persistence, and webhook contract changes.
- **Date**: 2026-09-13
- **Status**: active

### AD-009
- **Decision**: Recalculation completion depends on terminal webhooks (`done`/`error`), while intermediate `processing` webhooks must not block PATCH persistence.
- **Reason**: Bubble uses `processing` only to move the screen and renew the 600 s guardrail; a failed/intermittent progress webhook should not stop thousands of successful PATCHes.
- **Trade-off**: The UI can miss an intermediate progress update and still rely on the terminal webhook to close or fail the loading state.
- **Scope**: `src/controllers/schedules.controller.ts` and `src/services/schedule-webhook.service.ts`.
- **Date**: 2026-09-13
- **Status**: active

### AD-010
- **Decision**: Bubble PATCH persistence must retry both HTTP 429 and transport failures, logging `patchRequestCount`, `pauseCount`, and `pausedMs` for heavy recalculations.
- **Reason**: Real FK0002 tests showed Cloudflare 1015 rate limits, transient `fetch failed` transport errors, and the need to distinguish retry overhead from pause overhead.
- **Trade-off**: Final job duration may include deliberate waits, but the process avoids aborting large recalculations because of recoverable network noise.
- **Scope**: Bubble Atividade x Obra date/dependency PATCH persistence.
- **Date**: 2026-09-13
- **Status**: active

### AD-011
- **Decision**: The current Bubble webhook contract for branch `test` is documented in `docs/recalculation-webhook-contract-2026-09-13.md`.
- **Reason**: Bubble currently accepts a specific field set and treats `processing`, `done`, and other statuses differently; the engine needs this explicit contract to design visible progress correctly.
- **Trade-off**: Future Bubble workflow changes must update the document or supersede this decision.
- **Scope**: Schedule job webhook payloads and Bubble Cronograma loading UI.
- **Date**: 2026-09-13
- **Status**: active

### AD-012
- **Decision**: Schedule progress stages 1, 3, and 4 are UI milestones, while stage 2 carries the real long-running persistence progress.
- **Reason**: Bubble logs from 13/09 showed stages 1, 3, and 4 completing in milliseconds and almost all elapsed work happening in stage 2; inventing artificial duration in the engine would make the UI less truthful.
- **Trade-off**: Bubble should render stages 1, 3, and 4 as fast transitions, or separately choose a single global progress bar if it wants proportional elapsed-time UX.
- **Scope**: Schedule recalculation webhook ordering, progress semantics, and Bubble Cronograma loading UI.
- **Date**: 2026-09-13
- **Status**: active

### AD-013
- **Decision**: Snapshot-only `work_start_delayed` recalculations must require an explicit `obra_json[0].dataInicio`, and a new work-start event resets prior activity-level events.
- **Reason**: FK0002 showed that deriving the work start from the minimum snapshot date can anchor on an old isolated line and apply a huge false delta; stale activity events can then pull part of the schedule back to the old timeline.
- **Trade-off**: Bubble must include the current real work start when sending `work_start_delayed`; snapshot-only payloads missing that field now fail fast instead of guessing.
- **Scope**: Recalculate contract, event precedence, Bubble `events_old` handling, and Atividade x Obra date patching.
- **Date**: 2026-09-14
- **Status**: active

### AD-014
- **Decision**: Initial schedule duplicate protection uses pre-persistence deduplication plus a separate `dedupDroppedCount` metric.
- **Reason**: Real Bubble branch `test` runs showed duplicate Atividade x Obra rows in purchase/project lines derived from service anchors. Deduplication prevents bad writes, but without a separate metric the safety net would hide a generator regression.
- **Trade-off**: A healthy run should report `dedupDroppedCount: 0`; any value above zero means the defect was contained but still needs investigation.
- **Scope**: `src/services/bubble-bulk.service.ts`, schedule webhook metrics, OpenAPI docs, Bubble audit checklist.
- **Date**: 2026-09-14
- **Status**: active

### AD-015
- **Decision**: `createdCount` must include Atividade x Obra rows recovered by idempotency lookup after a failed/partial bulk response.
- **Reason**: Teste 4 persisted 4,676 rows, but `createdCount` reported only 1,484 because rows created by the first POST and later recovered by lookup were not counted.
- **Trade-off**: `createdCount` now represents successful row creation from both direct success responses and confirmed partial-create recovery.
- **Scope**: Bubble bulk retry/reconciliation metrics.
- **Date**: 2026-09-14
- **Status**: active

### AD-016
- **Decision**: Send Bubble Data API field `localAtuacao` for Atividade x Obra, not the internal option-set key `localatuacao_option_os_localatua__o`; if a bulk containing `localAtuacao` is rejected, retry without the field through the guarded idempotency path.
- **Reason**: Bubble Swagger exposes `localAtuacao`, while production logs showed bulk rejections around the old/internal key and later around the field in bulk context. The fallback keeps schedule generation available while Bubble can backfill Local de Atuação afterward.
- **Trade-off**: Some rows may persist without Local de Atuação when Bubble bulk rejects the field; Bubble must run "Preencher Local de Atuação da obra" afterward. `bulkRetryCount` can be high for this operational fallback and should not be confused with duplicate generation.
- **Scope**: Bubble Atividade x Obra bulk payload mapping and fallback behavior.
- **Date**: 2026-09-14
- **Status**: active

### AD-017
- **Decision**: For `payload_version=2`, `mode="recalculate"`, `estrutura_inalterada=true`, the snapshot is the complete universe of the recalculation; for `estrutura_inalterada=false`, Bubble must send the full structural inputs needed by `runScheduleEngine`.
- **Reason**: A "recalculate after error" payload with only 360 snapshot rows returned 360 rows by design, and an aditivo payload with `estrutura_inalterada=false` but empty `atividades_json`/environment/composition inputs failed at stage 2.
- **Trade-off**: Bubble cannot use a partial failed-version snapshot to recover a failed initial build, and structural aditivos require payloads closer to initial generation.
- **Scope**: Bubble recalculate/aditivo contract and schedule controller interpretation.
- **Date**: 2026-09-14
- **Status**: active

### AD-018
- **Decision**: `payload_version=3` with `scope.tipo="delta_motor"` is the supported fast path for pencil activity-date recalculations with dependents, using `base.payload + events_old` replay and in-place PATCH of only changed Atividade x Obra rows.
- **Reason**: Bubble graph traversal for dependent activities times out on large works; the engine can rebuild the active structure deterministically, replay the event history, compute the delta, and validate drift before writing.
- **Trade-off**: The v3 path depends on complete preserved active-version payloads and trustworthy event history; when `BASE_STATE_INVALID` or `STATE_DRIFT` occurs, Bubble must fall back to the v2 full payload path.
- **Scope**: Schedule recalculation contracts, event persistence, Bubble fallback behavior, and Atividade x Obra date patching.
- **Date**: 2026-09-15
- **Status**: active

## Handoff

### Current Snapshot - 2026-09-15

- **Feature**: Delta motor recalculation v3 / Bubble bulk persistence.
- **Phase / Task**: Implementation complete and pushed to Bubble test branch `codex/bubble-bulk-persistence`; Bubble can validate pencil "Alterar data da atividade com dependentes" without Bubble-side graph traversal.
- **Completed**: Implemented `payload_version=3` + `scope.tipo="delta_motor"` on `POST /api/v1/schedules/recalculate`; v3 accepts `base.payload`, `linhas_esperadas`, target/date scope, `events_old`, and `events_json`; reconstructs base lines deterministically; replays `events_old` ordered by `requisicao_data`, `criado_em`, then `evento_id`; validates target current date via `scope.data_atual_inicio`; applies the new event; diffs current vs next state; looks up changed Bubble rows by `obra`, `desatualizado (deletar)=false`, and `id_atividade_obra_externo in [...]`; rejects drift with `STATE_DRIFT`; rejects invalid base/targets/missing rows with `BASE_STATE_INVALID`; PATCHes only changed rows; persists only new `events_json`; fixes event date persistence to preserve the received calendar day; added spec and validation artifacts in `.specs/features/delta-motor-recalculation/`.
- **Latest pushed commit**: `fc2d2b9 feat(recalculate): add delta motor v3 flow` pushed to `origin/codex/bubble-bulk-persistence`.
- **Latest verification**: `node node_modules\typescript\bin\tsc` passed; `node node_modules\vitest\vitest.mjs run` passed with 7 files and 179 tests; `git diff --check` passed before commit.
- **Bubble v3 test payload requirements**: send `payload_version: 3`, `estrutura_inalterada: true`, `scope.tipo: "delta_motor"`, `scope.id_atividade_obra_externo`, `scope.nova_data`, `scope.data_atual_inicio`, `linhas_esperadas`, `base.versao_id`, `base.mode`, complete `base.payload` from the active schedule version, `events_old` with `requisicao_data`/`criado_em`/`evento_id`, and `events_json` containing only the new pencil event.
- **Bubble expected behavior**: A valid dependent activity-date change should receive `202`, then normal processing webhooks, then `done` with `metrics.patchedCount` equal to changed rows and `metrics.eventCount: 1`; Bubble should not send `atividade_obra_snapshot`, `master_dependencies`, or `master_anchors` for this v3 path.
- **Fallback behavior**: On webhook `error_code: "BASE_STATE_INVALID"` or `"STATE_DRIFT"`, Bubble should automatically retry the same recalculation with the existing v2 full payload fallback. These errors mean base count/target/lookup mismatch or current Bubble dates no longer match reconstructed state.
- **Known previous findings still relevant**: Initial schedule target remains 4,676 rows; healthy initial runs should keep `dedupDroppedCount: 0`; structural aditivo/recovery payloads must not mix `estrutura_inalterada=false` with snapshot-only inputs.
- **In-progress** (file:line): none.
- **Next step**: Bubble should retest on branch `test` using a real active-version payload for an activity with dependents. If v3 errors, capture the final webhook body (`error_code`, `error_message`, `failed_step`) and the exact v3 request payload sent.
- **Blockers**: none on the engine side for the v3 dependent-activity test; Bubble must ensure active versions preserve `payload_requisicao_json` and event history is cleaned of known duplicate Teste Recalculo events before using v3 as source of truth.
- **Recommended future engine improvement**: add clearer early validation for structural recalculations where `estrutura_inalterada=false` but structural inputs are empty.
- **Uncommitted files**: `.specs/STATE.md` and `.specs/LESSONS.md` documentation updates only.
- **Branch**: `codex/bubble-bulk-persistence`; do not push these changes to `main` without explicit user instruction.

### Previous Snapshot

- **Feature**: Bubble bulk persistence / schedule recalculation contract.
- **Phase / Task**: Branch `codex/bubble-bulk-persistence` is validating Bubble branch `test` for initial schedule, localAtuacao bulk fallback, metrics, and aditivo/recalculate contract.
- **Completed**: fixed duplicated purchase/project Atividade x Obra creation with pre-persistence deduplication; added `dedupDroppedCount`; added bulk metrics `createdCount`, `bulkBatchCount`, and `bulkRetryCount`; corrected `createdCount` for rows recovered by idempotency lookup; switched Local de Atuação payload field to `localAtuacao`; broadened the guarded fallback to retry bulk without `localAtuacao`; kept progress at 10% increments for stages 2 and 3; clarified that `patchBatchCount` is legacy/non-applicable while Etapa 3 PATCHes are individual pool requests; confirmed TypeScript and the full Vitest suite pass after each commit; pushed all related commits to `codex/bubble-bulk-persistence`.
- **Latest pushed commits**: `3f49256 Broaden localAtuacao bulk fallback`; `64acbac Count recovered bulk creates`; `612242e Use Data API localAtuacao field`; `0fa577e Add dedup dropped metric`; `1672c44 Deduplicate Bubble bulk records before persistence`; `1e98f99 Add Bubble bulk create metrics`; `6111f29 Reconcile failed Bubble bulk batches before retry`.
- **Latest verification**: `node node_modules\typescript\bin\tsc` passed; `node node_modules\vitest\vitest.mjs run` passed with 7 files and 174 tests.
- **Bubble test findings**: Initial schedule target remains 4,676 rows. Healthy runs should show persisted rows 4,676, distinct identities 4,676, `dedupDroppedCount: 0`, and `dependencyPatchCount === patchRequestCount === 4676`. `patchBatchCount` remains 0 because Etapa 3 uses individual PATCH requests in a concurrency pool, not PATCH batches.
- **LocalAtuacao finding**: Obra 6 initial payload had `localAtuacao` in all 1,725 `atividades_json` rows: 1,345 Compra blank, 348 Serviço with 228 `Indoor` and 120 `Outdoor`, and 32 Projeto blank. The engine should emit `localAtuacao` only when it normalizes to `indoor` or `outdoor`; blank Compra/Projeto values should not be sent in Atividade x Obra bulk records. If Bubble bulk rejects a lote containing `localAtuacao`, the engine now retries without that field through the guarded idempotency path.
- **Partial recovery finding**: The "recalculate after failed initial schedule" payload attached as `a8238b9a-5552-42a3-8dbd-785173ac8fa0` had `estrutura_inalterada=true`, `atividade_obra_snapshot: 360`, `atividades_json: 0`, `events_json: 0`, and `scope: null`; returning 360 rows is expected because snapshot recalculation treats the provided snapshot as the full universe. Bubble should not use partial failed-version snapshots to recover failed initial schedule creation.
- **Aditivo finding**: The Obra 6 aditivo payload attached as `2156c940-5e15-48d2-8428-e92cc8de3841` had `estrutura_inalterada=false`, `atividade_obra_snapshot: 4676`, but `atividades_json: 0`, `atividade_obra_json: 0`, and `events_json: 0`. With `estrutura_inalterada=false`, the engine calls `runScheduleEngine` and needs full structural inputs; a snapshot alone is not enough.
- **In-progress** (file:line): none.
- **Next step**: Bubble should retest initial schedule/aditivo on branch `test` after commit `3f49256`; if aditivo still fails, collect the preceding `schedule job failed` log line and the exact raw Bubble response/body from the failed bulk. Bubble must also fix the aditivo payload contract: structural aditivo (`estrutura_inalterada=false`) needs full structural inputs, while snapshot recalculation (`estrutura_inalterada=true`) needs a complete snapshot and events.
- **Blockers**: Bubble-side payloads currently show two invalid recovery/aditivo patterns: a partial snapshot of 360 rows after a failed initial build, and an aditivo with `estrutura_inalterada=false` but empty `atividades_json`/environment/composition inputs. The engine cannot infer the full structure from those payloads.
- **Recommended future engine improvement**: add a fast validation error when `mode="recalculate"` and `estrutura_inalterada=false` but structural inputs are empty, so Bubble receives a clearer contract error instead of a stage 2 persistence failure.
- **Uncommitted files**: none before this documentation update.
- **Branch**: `codex/bubble-bulk-persistence`; do not push these changes to `main` without explicit user instruction.

