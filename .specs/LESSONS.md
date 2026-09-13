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
- **Lesson**: Long Bubble write loops must treat HTTP 429 and transport exceptions as retryable persistence noise before failing the whole job.
- **Grounding**: FK0002 heavy recalculations hit Cloudflare 1015 and later `fetch failed` during `patch_dates`; retries and cooldowns allowed subsequent large runs to finish.
- **Scope**: Bubble PATCH persistence and schedule job error handling.

### L-007
- **Lesson**: Progress webhooks that only move the UI must not be awaited inside the critical persistence loop.
- **Grounding**: Intermediate `processing` webhook failures produced many 429 logs during FK0002 recalculation and could mask PATCH timing until progress sends were made non-blocking.
- **Scope**: Schedule controller progress reporting and Bubble webhook integration.

### L-008
- **Lesson**: Heavy Bubble API tuning needs separate metrics for attempted requests, explicit rate-limit pauses, and elapsed persistence time.
- **Grounding**: `patchRequestCount` alone mixed transport retries with rate-limit behavior until `pauseCount` and `pausedMs` were added to the patch pool log.
- **Scope**: Observability for schedule recalculation persistence.

### L-009
- **Lesson**: Treat Bubble branch `test` as the validation target until production promotion is explicitly requested.
- **Grounding**: The recalc optimization cycle required repeated commits and pushes only to `codex/bubble-bulk-persistence` while Render/Bubble branch `test` was being measured.
- **Scope**: Git workflow and deployment validation.

