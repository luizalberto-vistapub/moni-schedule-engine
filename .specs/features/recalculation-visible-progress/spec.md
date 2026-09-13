# Recalculation Visible Progress Specification

## Problem Statement

Bubble currently shows schedule recalculation progress as four stages, but the engine only emits visible progress after calculation finishes. Heavy recalculations can leave stage 1 frozen at 0% for minutes, reducing operator confidence and consuming the 600 s Bubble guardrail without renewal.

## Goals

- [ ] Emit visible `processing` webhooks for every stage boundary in the schedule job.
- [ ] Keep intermediate progress webhooks non-blocking for critical persistence work.
- [ ] Preserve terminal `done` / `error` behavior as the completion authority.

## Out of Scope

| Feature | Reason |
| ------- | ------ |
| Bubble workflow changes | Bubble must separately adjust `api_cronograma__gerar_v1` and confirm final labels. |
| Global process percentage | Current Bubble contract displays `progress` as "Etapa N de 4". |
| New webhook fields | The documented Bubble contract already accepts the needed fields. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Stage 1 semantic label | `Calculando cronograma` | Matches the engine work before persistence starts. | No |
| Stage 2 semantic label for snapshot recalculation | `Atualizando datas recalculadas` | Existing production message. | Yes |
| Stage 2 semantic label for full persistence | `Criando registros em bulk` | Existing production message. | Yes |
| Stage 3 semantic label | `Atualizando vínculos/dependências` | Existing bulk dependency-patch message. | No |
| Stage 4 semantic label | `Finalizando cronograma` | Covers metrics/normalized date handoff before terminal `done`. | No |
| Send `message` on every processing webhook | Yes | Bubble currently records `message` on `processing`; repeated sends make the UI resilient to cleared text. | No |
| Snapshot recalculation stage 3 | Emit a zero-work close/open boundary instead of dependency patch progress | Snapshot recalculate only patches dates today, but Bubble still presents four stages. | No |
| Stage 1 intra-calculation percentage | Boundary progress only in this step | The current calculation path is synchronous; true elapsed-time percentages during calculation require deeper engine instrumentation or worker isolation. | No |
| Stage ordering | Stage boundary webhooks are serial; intra-stage percentages remain non-blocking | Bubble applies progress by webhook arrival order, so boundary markers must not race each other. | Yes |
| Repeated stage 2 percentages | Do not resend unchanged percentages on short heartbeats | Bubble logs showed each duplicate costs actions and guardrail rescheduling; one send per 10% is enough unless a rare guardrail renewal is due. | Yes |
| Stage 2 percentage cadence | Keep 10% increments | Real Bubble logs showed roughly 10 s between visible updates during the heavy phase; 5% or 2% would increase Bubble action cost without enough UX benefit. | Yes |

**Open questions:** none blocking implementation; unconfirmed Bubble-facing decisions are logged as assumptions above.

---

## User Stories

### P1: Visible Stage Boundaries MVP

**User Story**: As a Bubble operator, I want each recalculation stage to visibly start and close so that long jobs do not appear frozen.

**Why P1**: This directly addresses the observed FK0002 screen freeze and renews Bubble's 600 s guardrail before persistence begins.

**Acceptance Criteria**:

1. WHEN a schedule job starts THEN the engine SHALL emit `processing` progress `1 / 0%` with message `Calculando cronograma` before calculation work begins.
2. WHEN calculation finishes successfully THEN the engine SHALL emit `processing` progress `1 / 100%` before opening stage 2.
3. WHEN persistence starts THEN the engine SHALL emit `processing` progress `2 / 0%` using the path-specific stage 2 message.
4. WHEN stage 2 persistence completes THEN the engine SHALL emit or have emitted `processing` progress `2 / 100%` before opening the next stage.
5. WHEN the job reaches finalization THEN the engine SHALL emit `processing` progress `4 / 0%` with message `Finalizando cronograma` before terminal `done`.
6. WHEN terminal completion is sent THEN the engine SHALL continue sending `done` with `progress: 4` and `progress_percent: 100`.
7. WHEN Bubble webhook responses complete out of order unless awaited THEN the engine SHALL serialize stage boundary webhooks so Bubble applies `1/0 -> 1/100 -> 2/0 -> 2/100 -> 3/100 -> 4/0 -> done` in order.

**Independent Test**: Submit a mocked generate or snapshot recalculate request and assert the ordered webhook payloads.

---

### P1: Non-Blocking Progress

**User Story**: As the schedule engine, I want non-terminal progress failures to stay non-critical so that Bubble UI noise does not abort successful persistence.

**Why P1**: AD-009 and L-007 require intermediate `processing` webhooks to be UI-only.

**Acceptance Criteria**:

1. WHEN a non-initial `processing` webhook hangs or fails during PATCH persistence THEN the engine SHALL continue persistence and still send terminal `done`.
2. WHEN terminal `done` or `error` is required THEN the engine SHALL continue awaiting the terminal webhook sender.
3. WHEN persistence heartbeat runs before percent advancement THEN the engine SHALL not resend the same `progress_percent` on each short heartbeat.

**Independent Test**: Existing mocked persistence test keeps hanging positive progress webhooks and expects patches plus `done`.

---

## Edge Cases

- WHEN a stage has no units of persistence work THEN the engine SHALL still emit that stage's `100%` closure before moving on.
- WHEN calculation throws after stage 1 starts THEN the error webhook SHALL report the last emitted stage and percent.
- WHEN Bubble rejects an intermediate progress webhook THEN the failure SHALL be logged but not fail the job.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| -------------- | ----- | ----- | ------ |
| RVP-01 | P1: Visible Stage Boundaries | Execute | Verified |
| RVP-02 | P1: Visible Stage Boundaries | Execute | Verified |
| RVP-03 | P1: Visible Stage Boundaries | Execute | Verified |
| RVP-04 | P1: Non-Blocking Progress | Execute | Verified |
| RVP-05 | P1: Visible Stage Boundaries | Execute | Verified |
| RVP-06 | P1: Non-Blocking Progress | Execute | Verified |

**Coverage:** 6 total, 6 verified by tests and validation artifacts.

## Success Criteria

- [x] Generate jobs emit ordered stage boundary webhooks before terminal `done`.
- [x] Snapshot recalculation jobs emit stage 1, 2, 3, and 4 visibility despite only patching dates.
- [x] Existing non-blocking progress behavior remains intact.
- [x] Bubble applies stage boundary webhooks in the same order the engine defines, even when webhook response times vary.
- [x] Short heartbeat intervals do not create repeated stage 2 webhooks for unchanged percentages.
