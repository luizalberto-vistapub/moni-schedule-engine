# STATE

## Decisions

### AD-001
- **Decision**: `main` and `codex/bubble-bulk-persistence` must remain identical for the Bubble bulk persistence work.
- **Reason**: The user expects both branches to carry the same production-ready schedule engine state and questioned direct edits on `main` when the copy branch was already valid.
- **Trade-off**: Branch operations must include an explicit equality check before declaring the work done.
- **Scope**: Git workflow for Bubble bulk persistence and schedule recalculation fixes.
- **Date**: 2026-08-21
- **Status**: superseded by AD-012 and the 2026-09-15 merge to `main`

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
- **Decision**: Schedule generation and recalculation endpoints must return HTTP 202 with `job_id` after synchronous payload validation, then continue processing asynchronously and report completion by webhook.
- **Reason**: Bubble API Connector calls can time out on long schedule jobs; the app needs a quick accepted response while the screen remains locked by the recorded job state.
- **Trade-off**: The Bubble app must track job state and handle delayed or repeated webhooks instead of relying on the original POST response for final success/failure.
- **Scope**: `POST /api/v1/schedules/generate`, `POST /api/v1/schedules/recalculate`, response contract, Bubble workflow integration.
- **Date**: 2026-09-10
- **Status**: active

### AD-009
- **Decision**: Schedule job progress is reported by intermediate webhooks using `status: "processing"`, with final webhooks restricted to `status: "done"` or `status: "error"`.
- **Reason**: Bubble uses processing webhooks only to update the locked-screen progress UI, while final webhooks close the job lifecycle.
- **Trade-off**: Consumers must distinguish lifecycle status from progress stage and ignore non-final `processing` updates for completion logic.
- **Scope**: Schedule webhook payloads and Bubble progress UI.
- **Date**: 2026-09-10
- **Status**: active

### AD-010
- **Decision**: Webhook URLs must be derived from the same Bubble API version sent in the payload unless `BUBBLE_SCHEDULE_WEBHOOK_URL` explicitly overrides it.
- **Reason**: A fixed `version-test` webhook URL returned 404 when the real test branch payload used `version-63jmi`, even though Data API bulk calls targeted the correct version.
- **Trade-off**: Payloads must keep carrying the correct `bubble_api_version`; manual URL override should be reserved for exceptional deployments.
- **Scope**: `src/services/schedule-webhook.service.ts` and Bubble environment routing.
- **Date**: 2026-09-10
- **Status**: active

### AD-011
- **Decision**: Optional Bubble fields rejected as unrecognized by the Data API may be retried without that field when the omission preserves the core schedule record.
- **Reason**: `localatuacao_option_os_localatua__o` was rejected by Bubble in Atividade x Obra bulk writes; failing the full job for that optional field blocked schedule creation.
- **Trade-off**: Optional metadata may be omitted in that environment until the Bubble field exists, but schedule persistence continues.
- **Scope**: Bubble Atividade x Obra create/patch persistence and retry handling.
- **Date**: 2026-09-10
- **Status**: active

### AD-012
- **Decision**: Schedule recalculation changes must be committed and pushed only to `codex/bubble-bulk-persistence` until the user explicitly promotes them.
- **Reason**: The validation cycle happened against Bubble branch `test`, and the user kept `main` untouched until explicitly requesting promotion.
- **Trade-off**: Branch equality with `main` was not the completion criterion until production promotion was requested.
- **Scope**: Git workflow for schedule recalculation, Bubble persistence, and webhook contract changes.
- **Date**: 2026-09-13
- **Status**: superseded by the 2026-09-15 merge to `main`

### AD-013
- **Decision**: Recalculation completion depends on terminal webhooks (`done`/`error`), while intermediate `processing` webhooks must not block PATCH persistence.
- **Reason**: Bubble uses `processing` only to move the screen and renew the 600 s guardrail; a failed/intermittent progress webhook should not stop thousands of successful PATCHes.
- **Trade-off**: The UI can miss an intermediate progress update and still rely on the terminal webhook to close or fail the loading state.
- **Scope**: `src/controllers/schedules.controller.ts` and `src/services/schedule-webhook.service.ts`.
- **Date**: 2026-09-13
- **Status**: active

### AD-014
- **Decision**: Bubble PATCH persistence must retry both HTTP 429 and transport failures, logging `patchRequestCount`, `pauseCount`, and `pausedMs` for heavy recalculations.
- **Reason**: Real FK0002 tests showed Cloudflare 1015 rate limits, transient `fetch failed` transport errors, and the need to distinguish retry overhead from pause overhead.
- **Trade-off**: Final job duration may include deliberate waits, but the process avoids aborting large recalculations because of recoverable network noise.
- **Scope**: Bubble Atividade x Obra date/dependency PATCH persistence.
- **Date**: 2026-09-13
- **Status**: active

### AD-015
- **Decision**: The current Bubble webhook contract for branch `test` is documented in `docs/recalculation-webhook-contract-2026-09-13.md`.
- **Reason**: Bubble currently accepts a specific field set and treats `processing`, `done`, and other statuses differently; the engine needs this explicit contract to design visible progress correctly.
- **Trade-off**: Future Bubble workflow changes must update the document or supersede this decision.
- **Scope**: Schedule job webhook payloads and Bubble Cronograma loading UI.
- **Date**: 2026-09-13
- **Status**: active

### AD-016
- **Decision**: Schedule progress stages 1, 3, and 4 are UI milestones, while stage 2 carries the real long-running persistence progress.
- **Reason**: Bubble logs from 13/09 showed stages 1, 3, and 4 completing in milliseconds and almost all elapsed work happening in stage 2; inventing artificial duration in the engine would make the UI less truthful.
- **Trade-off**: Bubble should render stages 1, 3, and 4 as fast transitions, or separately choose a single global progress bar if it wants proportional elapsed-time UX.
- **Scope**: Schedule recalculation webhook ordering, progress semantics, and Bubble Cronograma loading UI.
- **Date**: 2026-09-13
- **Status**: active

### AD-017
- **Decision**: Snapshot-only `work_start_delayed` recalculations must require an explicit `obra_json[0].dataInicio`, and a new work-start event resets prior activity-level events.
- **Reason**: FK0002 showed that deriving the work start from the minimum snapshot date can anchor on an old isolated line and apply a huge false delta; stale activity events can then pull part of the schedule back to the old timeline.
- **Trade-off**: Bubble must include the current real work start when sending `work_start_delayed`; snapshot-only payloads missing that field now fail fast instead of guessing.
- **Scope**: Recalculate contract, event precedence, Bubble `events_old` handling, and Atividade x Obra date patching.
- **Date**: 2026-09-14
- **Status**: active

### AD-018
- **Decision**: Initial schedule duplicate protection uses pre-persistence deduplication plus a separate `dedupDroppedCount` metric.
- **Reason**: Real Bubble branch `test` runs showed duplicate Atividade x Obra rows in purchase/project lines derived from service anchors. Deduplication prevents bad writes, but without a separate metric the safety net would hide a generator regression.
- **Trade-off**: A healthy run should report `dedupDroppedCount: 0`; any value above zero means the defect was contained but still needs investigation.
- **Scope**: `src/services/bubble-bulk.service.ts`, schedule webhook metrics, OpenAPI docs, Bubble audit checklist.
- **Date**: 2026-09-14
- **Status**: active

### AD-019
- **Decision**: `createdCount` must include Atividade x Obra rows recovered by idempotency lookup after a failed/partial bulk response.
- **Reason**: Teste 4 persisted 4,676 rows, but `createdCount` reported only 1,484 because rows created by the first POST and later recovered by lookup were not counted.
- **Trade-off**: `createdCount` now represents successful row creation from both direct success responses and confirmed partial-create recovery.
- **Scope**: Bubble bulk retry/reconciliation metrics.
- **Date**: 2026-09-14
- **Status**: active

### AD-020
- **Decision**: Send Bubble Data API field `localAtuacao` for Atividade x Obra, not the internal option-set key `localatuacao_option_os_localatua__o`; if a bulk containing `localAtuacao` is rejected, retry without the field through the guarded idempotency path.
- **Reason**: Bubble Swagger exposes `localAtuacao`, while production logs showed bulk rejections around the old/internal key and later around the field in bulk context. The fallback keeps schedule generation available while Bubble can backfill Local de Atuacao afterward.
- **Trade-off**: Some rows may persist without Local de Atuacao when Bubble bulk rejects the field; Bubble must run "Preencher Local de Atuacao da obra" afterward. `bulkRetryCount` can be high for this operational fallback and should not be confused with duplicate generation.
- **Scope**: Bubble Atividade x Obra bulk payload mapping and fallback behavior.
- **Date**: 2026-09-14
- **Status**: active

### AD-021
- **Decision**: For `payload_version=2`, `mode="recalculate"`, `estrutura_inalterada=true`, the snapshot is the complete universe of the recalculation; for `estrutura_inalterada=false`, Bubble must send the full structural inputs needed by `runScheduleEngine`.
- **Reason**: A "recalculate after error" payload with only 360 snapshot rows returned 360 rows by design, and an aditivo payload with `estrutura_inalterada=false` but empty `atividades_json`/environment/composition inputs failed at stage 2.
- **Trade-off**: Bubble cannot use a partial failed-version snapshot to recover a failed initial build, and structural aditivos require payloads closer to initial generation.
- **Scope**: Bubble recalculate/aditivo contract and schedule controller interpretation.
- **Date**: 2026-09-14
- **Status**: active

### AD-022
- **Decision**: `payload_version=3` with `scope.tipo="delta_motor"` is the supported fast path for pencil activity-date recalculations with dependents, using `base.payload + events_old` replay and in-place PATCH of only changed Atividade x Obra rows.
- **Reason**: Bubble graph traversal for dependent activities times out on large works; the engine can rebuild the active structure deterministically, replay the event history, compute the delta, and validate drift before writing.
- **Trade-off**: The v3 path depends on complete preserved active-version payloads and trustworthy event history; when `BASE_STATE_INVALID` or `STATE_DRIFT` occurs, Bubble must fall back to the v2 full payload path.
- **Scope**: Schedule recalculation contracts, event persistence, Bubble fallback behavior, and Atividade x Obra date patching.
- **Date**: 2026-09-15
- **Status**: active

### AD-023
- **Decision**: Atividade x Obra bulk create concurrency is opt-in through `BUBBLE_BULK_CREATE_CONCURRENCY`, with default `1`.
- **Reason**: Bubble bulk create is slow on large initial schedules, but increasing parallelism can hit Bubble/Cloudflare limits; production behavior must remain unchanged unless the environment explicitly opts in.
- **Trade-off**: Test environments can tune throughput with low concurrency values while retaining guarded bulk retry/reconciliation.
- **Scope**: Bubble Atividade x Obra bulk create persistence and schedule creation performance.
- **Date**: 2026-09-15
- **Status**: active

### AD-024
- **Decision**: Atividade x Obra Data API lookups must retry retryable Bubble/Cloudflare failures before failing the schedule job.
- **Reason**: Live showed `BUBBLE_BULK_REQUEST_ERROR` during `bulk_create` because the idempotency lookup received Cloudflare 1015/HTTP 429 and failed immediately, even though PATCH paths already treated 429 as transient persistence noise.
- **Trade-off**: A rate-limited lookup can add retry/cooldown time, but avoids failing long initial schedule generation on a temporary Cloudflare ban.
- **Scope**: Atividade x Obra idempotency lookup, delta lookup, Bubble bulk persistence retry behavior, and env default parsing.
- **Date**: 2026-09-15
- **Status**: active

## Handoff

### Current Snapshot - 2026-09-15

- **Feature**: Promote Bubble bulk persistence, visible progress, and delta motor recalculation work from `codex/bubble-bulk-persistence` to `main`.
- **Phase / Task**: Merge in progress on `main`; conflicts in `.specs/STATE.md` and `.specs/LESSONS.md` resolved by preserving both histories.
- **Completed**: async schedule jobs with progress webhooks; Bubble version-aware webhook routing; retry/cooldown for PATCH loops; initial schedule bulk metrics and dedup protection; localAtuacao guarded fallback; delta motor v3 for dependent activity-date recalculation; optional Atividade x Obra bulk create concurrency via `BUBBLE_BULK_CREATE_CONCURRENCY`.
- **Latest pushed test branch commit**: `8c77287 Add optional bulk create concurrency` on `origin/codex/bubble-bulk-persistence`.
- **Latest verification before merge**: `node node_modules\typescript\bin\tsc` passed; `node node_modules\vitest\vitest.mjs run` passed with 7 files and 181 tests; `git diff --check` passed.
- **Bubble v3 test payload requirements**: send `payload_version: 3`, `estrutura_inalterada: true`, `scope.tipo: "delta_motor"`, target/date scope fields, `linhas_esperadas`, `base.versao_id`, `base.mode`, complete active-version `base.payload`, ordered `events_old`, and `events_json` containing only the new pencil event.
- **Bulk create tuning**: default behavior remains serial; test can set `BUBBLE_BULK_CREATE_CONCURRENCY=2` or `3`. Etapa 3 remains controlled by `BUBBLE_PATCH_CONCURRENCY`; user stated `6` is the verified ideal value.
- **Next step**: finish merge commit on `main`, run focused/full validation, then push `main` to `origin/main`.
- **Blockers**: none after conflict resolution.
- **Branch**: `main`.
