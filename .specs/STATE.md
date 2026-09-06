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

## Handoff

- **Feature**: Bubble bulk persistence / schedule recalculation contract.
- **Phase / Task**: Pause after branch sync and contract fixes; next chat should continue from commit `4fae4ec`.
- **Completed**: fixed `ambiente x obra` source, preserved `sem_ambiente`, surfaced validation messages, created Atividade x Obra records on recalculation, deduped shared project lines by earliest service date, sent `familia`/`nomeFamilia`, returned project metadata and service anchors in bulk.
- **In-progress** (file:line): none.
- **Next step**: Validate the next real Bubble payload after Bubble starts sending direct project identity fields (`projetoId`, `tipoProjeto`, responsible/status) and confirm the created Atividade x Obra records receive those values.
- **Blockers**: none in the engine; Bubble payload `bb9a4c20...` still had some direct project metadata absent, so empty fields there are payload-driven.
- **Uncommitted files**: `.specs/STATE.md`, `.specs/LESSONS.md`.
- **Branch**: `codex/bubble-bulk-persistence` at `4fae4ec`, equal to `main`, `origin/main`, and `origin/codex/bubble-bulk-persistence` at the last check.

