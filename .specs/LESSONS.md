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

