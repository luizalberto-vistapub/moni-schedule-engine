# Delta V4 Guardian Contract - Handoff

Date: 2026-09-17

Repository state when this handoff was written:

- branch: `main`
- local/remote HEAD: `ef8debf fix(errors): summarize upstream html failures`
- earlier bulk-persistence merge: `c8f8b39 Merge bubble bulk persistence updates`
- the repository was clean before these documentation changes

## Session Context

This handoff closes a longer incident/debugging cycle. The important completed motor changes are:

- persistence progress emits 1%, 3%, 5%, and then 5% increments so Bubble shows early liveness;
- Bubble Data API lookup retries cover 429/Cloudflare 1015 and transport/server failures;
- retry cooldowns emit `processing` heartbeats with the current percentage;
- detached progress webhooks are drained before terminal `done` or `error`;
- public error messages summarize Bubble/Cloudflare HTML while full bodies remain in logs;
- missing numeric environment variables now retain intended defaults instead of collapsing through `Number(null) === 0`;
- production tuning reported by the user used concurrency 6 and batch settings 6, while bulk-create concurrency remains opt-in in code.

The original Live generation incident showed 4,676 records written before the motor stopped signalling and the Render instance later appeared recently restarted. The Bubble sentinel correctly failed the dead job; closing the user's PC was unrelated.

One separate persistence defect remains unresolved. Job `schedule_job_mu2rz12w_pft6xlf5` reported:

```json
{
  "linesCount": 4676,
  "createdCount": 4676,
  "dependencyPatchCount": 4676,
  "bulkRetryCount": 10,
  "dedupDroppedCount": 0
}
```

Bubble nevertheless contained 4,802 rows: 126 duplicate persistence records with the same external IDs, order, and dates. This is evidence of ambiguous partial-write retry behavior, not duplicate schedule generation. Cleanup must group by `id_atividade_obra_externo` within the same version and preserve one real record per key; deleting the newest N rows is unsafe. The motor still needs post-write uniqueness/cardinality verification or stricter retry reconciliation before sending `done`.

## Executive Summary

The payload v3 delta shortcut is disabled in Bubble Test. Complete payload v2 recalculation remains the authoritative path and is currently the only path approved for testing.

The v3 goal was valid: remove Bubble graph traversal, reduce request size, and patch only affected rows. The implementation did not meet that goal. A real failure still sent about 8.7 MB because it embedded the complete prior request in `base.payload`, then reconstructed current dates from that request plus `events_old`. Repeated drift caused the flow to run v3, show an error, and then succeed through v2.

Payload v4 keeps the fast-path goal but changes the state model:

- Bubble preserves one immutable structural guardian per obra.
- The motor uses the guardian only for identities and dependencies.
- The motor reads current dates for affected rows from Bubble.
- The request contains only the new event, never `events_old`.
- Bubble remains the durable source; motor cache is optional.

## Evidence And Root Cause

### Unstable base selection

Bubble historically kept only the request payload of the active version because old version payloads and assembly lists made large-version queries expensive. The v3 shortcut therefore used the active version because it was the only remaining payload.

That payload can belong to a retry, retomada, fallback, or delta. It describes a request, not a durable post-execution snapshot. It can be reproducible, but it is not a safe perpetual base and a v3 request can become nested inside a later v3 request.

The observed 4,505 versus 4,676 count was not itself the proven failure: the structural request can generate the additional rows, and the motor reached `STATE_DRIFT` rather than the line-count `BASE_STATE_INVALID` guard. The proven failure was date reconstruction.

### Event history without a cutoff

The old contract sent the entire obra history in `events_old`, without a watermark tied to the selected base. An event already represented in the base request could be replayed again.

### Calendar-day instability

One historical EventoCronograma stored at midnight UTC was serialized as both `2026-09-07` and `2026-09-06` in different Bubble contexts. Weekend and holiday normalization then produced different cascades. New motor event writes use noon UTC, but historical midnight values still require controlled handling.

### Missing sequential proof

The v3 tests covered isolated happy and error paths. They did not prove the stateful sequence:

```text
generation -> first delta -> second delta
```

That sequence is mandatory for v4 acceptance.

## Current Containment

Bubble reports the following changes applied only in Test:

- v3 routing disabled for all obras;
- payload v4 builder created behind the same disabled feature flag;
- `VersaoCronograma.guardia_estrutura` and `VersaoCronograma.base_hash` added;
- `Obra.versao_guardia` added;
- structural completion promotes a guardian;
- cleanup workflows skip the guardian payload;
- delta completion cannot replace or clear the guardian;
- `BASE_UNKNOWN` joined recoverable refusal codes handled through silent full fallback;
- Bubble date formatting was stabilized.

These Bubble changes have not been inspected from this repository. Do not promote them to Live until the full-path regression and guardian lifecycle are verified in Bubble Test.

## Verified Full-Path Payload

The first new-flow work-start test payload was inspected locally:

| Field | Value |
| --- | --- |
| Payload | v2 complete snapshot |
| Mode | `recalculate` |
| Structure | unchanged |
| Current obra start | `2026-10-01` |
| Requested obra start | `2026-10-16` |
| Snapshot rows | 4,676 |
| Unique external IDs | 4,676 |
| Duplicate external IDs | 0 |
| Status | all `Nao iniciada` |
| Scope role | all `editable` |
| Event | one `work_start_delayed` |
| Old events | zero |
| Payload size | 2,947,582 bytes |

Expected webhook metrics are `linesCount=4676`, `patchedCount=4676`, `eventCount=1`, and `createdCount=0`. Dates move 15 calendar days and then normalize to the next configured business day where needed.

## Payload V4 Request

Bubble has prepared this target shape behind the disabled flag:

```json
{
  "payload_version": 4,
  "bubble_api_version": "version-test",
  "cronograma_unique_id": "...",
  "versao_cronograma_unique_id": "...",
  "previous_version_id": "...",
  "mode": "recalculate",
  "estrutura_inalterada": true,
  "linhas_esperadas": 4676,
  "base": {
    "base_id": "<guardian VersaoCronograma id>",
    "base_hash": "<canonical hash returned by motor>"
  },
  "obra_json": [{ "unique id": "...", "dataInicio": "2026-07-01" }],
  "dias_trabalho_semana": 5,
  "timezone": "America/Sao_Paulo",
  "event_date": "2026-09-17",
  "scope": {
    "tipo": "delta_motor",
    "atividade_alvo_id": "...",
    "id_atividade_obra_externo": "...",
    "nova_data": "2026-09-18"
  },
  "events_json": [{
    "type": "activity_date_changed_cascade",
    "id_atividade_obra_externo": "...",
    "atividade_id": "...",
    "new_start_date": "2026-09-18"
  }]
}
```

`events_old` is intentionally absent.

## Motor Responsibilities

### Structural completion

For generation and every successful structural materialization (Cronograma Inicial, Aditivo, Inserida nova atividade, or Retomada apos erro):

1. Build a canonical representation of the structural input used to reproduce identities and dependencies.
2. Calculate a deterministic hash.
3. Return `base_hash` in the terminal `done` webhook.
4. Optionally cache the normalized structure by `base_id + base_hash`.

The exact canonicalization algorithm must be specified before implementation so Bubble and motor do not calculate incompatible values. The current decision is that the motor calculates the hash and Bubble stores it.

### V4 base resolution

On payload v4:

1. Validate `base.base_id` and `base.base_hash`.
2. Check the optional in-memory cache.
3. On cache miss, fetch `VersaoCronograma/<base_id>` from the matching Bubble API version.
4. Read `payload_requisicao_json` and `base_hash`.
5. Verify the stored hash and reconstruct the structure inside the same job.
6. Return `BASE_UNKNOWN` only when Data API resolution or validation cannot recover the base.

No user click or manual full-payload resend is required for an ordinary cold cache.

### Current-state hydration

The guardian is not the source of current dates. The motor must:

1. Determine the structurally affected external IDs from the guardian graph and the new event.
2. Fetch the corresponding active Atividade x Obra rows from Bubble.
3. Hydrate the calculation with their current persisted dates and relevant status.
4. Apply only `events_json`.
5. Patch only rows whose dates change.
6. Persist only the new event.

Any drift guard after hydration should detect a true concurrent update, not disagreement with historical replay.

## Cache And Durability

Render instances may restart. Therefore:

- Bubble owns the durable guardian payload.
- Motor memory cache is disposable.
- Cache miss is normal and must self-heal through Data API.
- The large payload may cross the network again after a cold start; without a new durable motor store it cannot be promised as once-per-structure for the lifetime of the obra.

## Error Semantics

| Code | Meaning | Bubble behavior |
| --- | --- | --- |
| `BASE_UNKNOWN` | Guardian could not be fetched or validated | Silent complete fallback |
| `BASE_STATE_INVALID` | Guardian structure is unusable | Silent complete fallback |
| `SCOPE_INSUFFICIENT` | Fast path cannot safely cover the request | Silent complete fallback |
| `STATE_DRIFT` | Reserved for a real concurrent state change | Silent complete fallback plus audit |
| Other errors | Calculation, persistence, or infrastructure failure | User-visible only if no successful fallback follows |

## Test Gates

### Gate A - Current full path

With the v4 flag disabled in Bubble Test:

1. Generate a disposable obra.
2. Delay the obra start.
3. Delay an activity without dependents twice.
4. Delay an activity with dependents twice.
5. Confirm every request is v2, every terminal result is `done`, and no drift popup appears.
6. Confirm the guardian payload survives all non-structural recalculations.

### Gate B - Guardian lifecycle

1. Complete a structural generation and mark it guardian.
2. Start a new structural version and keep the old guardian protected while it runs.
3. On success, promote the new guardian before releasing the old payload.
4. On failure, retain the old guardian unchanged.
5. Confirm a delta version never becomes guardian.

### Gate C - Motor v4

For each supported event type, prove:

```text
generation -> first v4 delta -> second v4 delta
```

Run first on a small obra, then on a large real obra. Test warm cache, cold cache, stale hash, missing guardian, Bubble 429/1015 during guardian/current-row lookup, and concurrent row changes.

Do not enable v4 against the current motor. Because `estrutura_inalterada=true` is already a v2 snapshot signal, an unsupported v4 request could be interpreted as an empty snapshot recalculation.

## Repository And Deployment

- Repository: `https://github.com/luizalberto-vistapub/moni-schedule-engine`
- Development Render service: `moni-schedule-engine-1`
- Development branch: `codex/bubble-bulk-persistence`
- Live Render service: `moni-schedule-engine`
- Live branch: `main`

Required release order:

1. Implement and push motor v4 to the development branch.
2. Validate Bubble Test with the v4 flag limited to test obras.
3. Merge/push motor changes to `main` and confirm Live Render deployment.
4. Promote Bubble changes to Live.
5. Enable v4 gradually.

## Open Implementation Questions

- Exact Bubble Data API type name and field keys for `VersaoCronograma`, `payload_requisicao_json`, and `base_hash`.
- Canonical JSON normalization and hash algorithm.
- Maximum guardian payload size returned by Bubble object GET.
- Candidate affected-row calculation for each event type before date hydration.
- Whether current status is required alongside dates to preserve started/non-movable rows.
- Historical midnight-event cleanup policy.
