# LESSONS

This repository does not currently include `scripts/lessons.py`, so this file is maintained by the documented no-script fallback. Entries below are grounded in the Bubble payload debugging and verification cycle from 2026-08-21.

## Confirmed

### L-001
- **Lesson**: Persist Bubble relations from their explicit relation IDs, not from nearby catalog or display IDs.
- **Grounding**: `ambiente x obra` was initially mapped from `line.ambienteId`, but the correct value was `obra_ambiente_json[]."id ambiente x obra"`.
- **Scope**: `src/services/normalize-payload.service.ts`, `src/services/schedule-engine.service.ts`, `src/services/bubble-bulk.service.ts`.

### L-002
- **Lesson**: During recalculation, previous-version records are hydration input only; create-or-patch identity must be resolved inside the target version.
- **Grounding**: Reusing prior `atividade_obra_json` Bubble IDs prevented the new version from receiving updated Atividade x Obra records.
- **Scope**: Bubble bulk persistence.

### L-003
- **Lesson**: When Bubble receives invalid payloads, surface a string message at the top level and inside `error.message`.
- **Grounding**: Bubble displayed `[object Object]` until validation details were copied into `message` and `error_message`.
- **Scope**: API error handling.

### L-004
- **Lesson**: Shared project lines must dedupe by project identity and choose the earliest planned service anchor.
- **Grounding**: User confirmed duplicated project rows should collapse to one row anchored to the Atividade x Obra with the smallest planned execution date.
- **Scope**: Schedule engine project generation.

### L-005
- **Lesson**: ZIP artifacts uploaded as Codex skills must use forward-slash internal paths.
- **Grounding**: Skill upload rejected a ZIP whose entries used backslash paths such as `agents\openai.yaml`.
- **Scope**: Skill packaging and release artifacts.

### L-006
- **Lesson**: Route Bubble webhooks with the same Bubble version used by the Data API request.
- **Grounding**: The schedule engine sent bulk writes to `version-63jmi` but webhooks to fixed `version-test`, causing Bubble to return `404 Workflow not found`.
- **Scope**: Schedule webhooks and Bubble environment routing.

### L-007
- **Lesson**: Emit a progress webhook before a long persistence phase starts, not only after a successful batch finishes.
- **Grounding**: A first Atividade x Obra bulk failure prevented any progress webhook from reaching Bubble before the error path.
- **Scope**: Schedule job progress reporting.

### L-008
- **Lesson**: Treat rejected optional Bubble metadata fields as retryable omissions when the core record remains valid.
- **Grounding**: Bubble rejected `localatuacao_option_os_localatua__o` as an unrecognized Atividade x Obra field; retrying without it preserves schedule creation.
- **Scope**: Bubble bulk and idempotent patch persistence.

### L-009
- **Lesson**: New schedule creation can still require post-create relation patches when Bubble IDs are needed for self-references.
- **Grounding**: A `generate` payload for a new obra produced 4,676 Atividade x Obra records and still needed Etapa 3 to patch master/dependency fields after IDs were returned by bulk create.
- **Scope**: Schedule persistence flow and progress UI expectations.

### L-010
- **Lesson**: Long Bubble write loops must treat HTTP 429 and transport exceptions as retryable persistence noise before failing the whole job.
- **Grounding**: FK0002 heavy recalculations hit Cloudflare 1015 and later `fetch failed` during `patch_dates`; retries and cooldowns allowed subsequent large runs to finish.
- **Scope**: Bubble PATCH persistence and schedule job error handling.

### L-011
- **Lesson**: Progress webhooks that only move the UI must not be awaited inside the critical persistence loop.
- **Grounding**: Intermediate `processing` webhook failures produced many 429 logs during FK0002 recalculation and could mask PATCH timing until progress sends were made non-blocking.
- **Scope**: Schedule controller progress reporting and Bubble webhook integration.

### L-012
- **Lesson**: Heavy Bubble API tuning needs separate metrics for attempted requests, explicit rate-limit pauses, and elapsed persistence time.
- **Grounding**: `patchRequestCount` alone mixed transport retries with rate-limit behavior until `pauseCount` and `pausedMs` were added to the patch pool log.
- **Scope**: Observability for schedule recalculation persistence.

### L-013
- **Lesson**: Treat Bubble branch `test` as the validation target until production promotion is explicitly requested.
- **Grounding**: The recalc optimization cycle required repeated commits and pushes only to `codex/bubble-bulk-persistence` while Render/Bubble branch `test` was being measured.
- **Scope**: Git workflow and deployment validation.

### L-014
- **Lesson**: Snapshot-only recalculations must require explicit contract anchors instead of deriving business anchors from incidental snapshot extrema.
- **Grounding**: FK0002 `work_start_delayed` used the minimum snapshot date `2026-04-06` as the work-start anchor, producing a false +301 day shift; regression coverage now rejects missing `obra_json[0].dataInicio`.
- **Scope**: Schedule recalculation contracts, snapshot payload normalization, and event precedence.

### L-015
- **Lesson**: A dedup safety net needs its own dropped-row metric, otherwise it can hide the regression it is containing.
- **Grounding**: Initial schedule Teste 3 persisted the correct 4,676 rows after duplicate defenses, but Bubble correctly noted that ordinary created/persisted counts would not reveal future duplicate generation once dedup runs before persistence.
- **Scope**: Bulk Atividade x Obra metrics and Bubble audit checklist.

### L-016
- **Lesson**: Bubble Data API field names must be verified against Swagger, and bulk endpoints may still need operational fallbacks for fields that object endpoints accept.
- **Grounding**: Swagger exposed `localAtuacao`, while earlier payloads used the internal key `localatuacao_option_os_localatua__o`; later bulk runs still needed a guarded fallback that removes `localAtuacao` when the bulk rejects a lote.
- **Scope**: Bubble bulk payload mapping, option-set fields, and field-specific retry logic.

### L-017
- **Lesson**: Metrics for partial bulk recovery must count rows confirmed by lookup as created rows.
- **Grounding**: Teste 4 showed `createdCount: 1484` despite 4,676 rows in Bubble because rows created before a 400 bulk response were recovered by idempotency lookup but not counted.
- **Scope**: Bulk retry/reconciliation metrics.

### L-018
- **Lesson**: Recalculate payload mode controls whether the engine uses a snapshot or regenerates structure; Bubble must not mix structural mode with snapshot-only inputs.
- **Grounding**: A recovery payload with `estrutura_inalterada=true` and only 360 snapshot rows returned 360 rows by design, while an aditivo with `estrutura_inalterada=false` and empty `atividades_json`/structure blocks failed because `runScheduleEngine` had no structure to generate.
- **Scope**: Bubble recalculate/aditivo contract and support triage.

### L-019
- **Lesson**: Event-sourced recalculation paths must separate replay input from persistence output: replay `events_old`, but persist only the new `events_json` event.
- **Grounding**: The delta motor v3 work found duplicated `EventoCronograma` history and timezone date drift when old events were re-persisted; regression coverage now asserts one new event and calendar-stable event dates.
- **Scope**: Schedule recalculation contracts, `EventoCronograma` persistence, and Bubble fallback triage.

### L-020
- **Lesson**: Numeric environment defaults must distinguish missing values from zero, and every Bubble Data API persistence lookup needs retry handling for HTTP 429/Cloudflare 1015.
- **Grounding**: A Live initial-generation failure returned `Bubble atividade obra lookup failed with 429` during `bulk_create`; investigation found lookup did not retry and `boundedInteger(undefined, ...)` collapsed defaults to minimum values because `Number(null) === 0`.
- **Scope**: Bubble Data API lookup retry, environment parsing, and schedule persistence defaults.

### L-021
- **Lesson**: Any retry/backoff path that blocks writes must still renew Bubble liveness with a `processing` webhook.
- **Grounding**: Bubble's sentinel marks jobs dead only when both recent `processing` webhooks and new Atividade x Obra writes are absent; a healthy 429/1015 lookup cooldown satisfies both failure proofs unless the engine emits a heartbeat.
- **Scope**: Bubble watchdog compatibility, retry loops, and schedule progress webhooks.
