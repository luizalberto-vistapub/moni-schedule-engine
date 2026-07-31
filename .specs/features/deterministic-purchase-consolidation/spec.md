# Deterministic Purchase Consolidation

## Problem

The same simple product can appear in several composition contexts while Bubble emits equivalent purchase chains anchored to different composites or in different array orders. The schedule must produce one stable purchase chain for the whole work instead of preserving those random anchors and duplicates.

## Acceptance Criteria

- **DPC-01** — WHEN equivalent purchases for the same simple product and purchase stage are repeated, THEN the engine SHALL generate only the activity with the earliest `createdAt`, breaking a remaining tie by activity ID.
- **DPC-02** — WHEN the purchase simple product appears in several composites, THEN all services from those composites SHALL be candidates and the engine SHALL anchor the canonical purchases to the service with the lowest `ordem`.
- **DPC-03** — WHEN candidate services have the same `ordem`, THEN the engine SHALL choose the service with the earliest calculated start date.
- **DPC-04** — WHEN candidate services also have the same calculated start date, THEN the engine SHALL choose the service with the lexicographically smallest ID.
- **DPC-05** — WHEN equivalent payloads differ only in input array order or received purchase anchor, THEN the generated purchase IDs, stages, dates, service anchors, and contextual products SHALL be equal.
- **DPC-06** — WHEN an anchored Project is processed or no purchase service can be resolved, THEN the existing Project and unresolved-anchor behavior SHALL remain unchanged.

## Assumptions

- Consolidation scope is one schedule generation payload (one work/version).
- The identity of a purchase chain is the simple product ID; each recognized purchase stage may occur at most once in the generated schedule.
- A received `atividadeServicoAncoraId` is only a fallback when no service can be derived from the purchase simple product.
- Deliberately discarded duplicate purchases do not produce unresolved-anchor warnings.

## Out of Scope

- Changing Project consolidation.
- Creating missing purchase stages.
- Promoting the development branch to `main`.
