# STATE

## Decisions

### AD-001
- **Decision**: `main` and `codex/bubble-bulk-persistence` must remain identical for the Bubble bulk persistence work.
- **Reason**: The user expects both branches to carry the same production-ready schedule engine state and questioned direct edits on `main` when the copy branch was already valid.
- **Trade-off**: Branch operations must include an explicit equality check before declaring the work done.
- **Scope**: Git workflow for Bubble bulk persistence and schedule recalculation fixes.
- **Date**: 2026-08-21
- **Status**: active

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

## Handoff

- **Feature**: Async Bubble schedule job contract and webhook progress flow.
- **Phase / Task**: Pause after merging test branch into `main`; current `main` head is merge commit `8cd1f8c`.
- **Completed**: increased JSON body limit, added malformed JSON responses, implemented HTTP 202 accepted responses with `job_id`, moved schedule processing behind `setImmediate`, added progress/final webhooks, derived webhook URL from `bubble_api_version`, retried Atividade x Obra writes without rejected optional `localatuacao_option_os_localatua__o`, merged `codex/bubble-bulk-persistence` into `main`, verified `npm.cmd test` and `npm.cmd run build`.
- **In-progress** (file:line): none.
- **Next step**: Start the next chat by deciding whether to push `main` to `origin/main` for production deploy, or first optimize Etapa 3 by reducing/parallelizing the 4,676 Atividade x Obra dependency/master patches seen in the large generate payload.
- **Blockers**: none in code; `main` is intentionally ahead of `origin/main` and not pushed yet.
- **Uncommitted files**: none.
- **Branch**: `main` at `8cd1f8c`, ahead of `origin/main` by 4 commits; `codex/bubble-bulk-persistence` remains at `88ef609` and has already been merged.

