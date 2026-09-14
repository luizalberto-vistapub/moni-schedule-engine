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

## Handoff

- **Feature**: Bubble bulk persistence / schedule recalculation contract.
- **Phase / Task**: FK0002 `work_start_delayed` bug investigated, fixed, and locally verified.
- **Completed**: normalized recalc dates to business days, accepted v2 structural recalculation with explicit contract checks, parallelized Atividade x Obra PATCHes, added 429 cooldown/retry, retried transport failures, retried terminal webhooks, made intermediate progress webhooks non-blocking, added `pauseCount`/`pausedMs` pool metrics, documented the Bubble webhook contract for 13/09/2026, emitted visible stage boundary webhooks for stages 1-4, preserved non-blocking `processing` semantics, validated the initial progress feature in `.specs/features/recalculation-visible-progress/validation.md`, applied the decision that stages 1/3/4 are UI milestones, serialized stage-boundary webhooks, deduped repeated stage 2 heartbeat percentages, rejected snapshot-only `work_start_delayed` without explicit `obra_json[0].dataInicio`, discarded stale activity-level `events_old` when a new work-start event resets the timeline, updated README contract notes, and passed TypeScript plus the full Vitest suite.
- **In-progress** (file:line): none.
- **Next step**: Commit the FK0002 work-start recalculation fix, push `codex/bubble-bulk-persistence`, then ask Bubble to send `obra_json[0].dataInicio` for snapshot-only `work_start_delayed` and optionally normalize old event dates to `YYYY-MM-DD`.
- **Blockers**: Bubble must include the current real work start in `obra_json[0].dataInicio` for snapshot-only work-start recalculations; date normalization for legacy `events_old` remains a small Bubble-side cleanup for activity recalc events.
- **Uncommitted files**: `README.md`, `.specs/STATE.md`, `.specs/LESSONS.md`, `src/controllers/schedules.controller.ts`, `src/services/bubble-bulk.service.ts`, and `tests/schedules.controller.test.ts`.
- **Branch**: `codex/bubble-bulk-persistence`; do not push these changes to `main` without explicit user instruction.

