# Remove Local Atuacao

The engine no longer processes or persists localAtuacao. Payloads do not need to send it. Legacy values may be accepted as unprocessed metadata but must not affect schedule lines or Bubble writes.

- AC-1: Services, purchases and projects without localAtuacao are accepted and generate their normal schedule records. Existing controller fixtures without this field remain accepted.
- AC-2: Legacy catalog and historical localAtuacao values must not appear as schedule-line fields or Bubble Atividade x Obra fields.
- AC-3: Remove localAtuacao-specific bulk/PATCH fallback logic. A successful synthetic persistence request with legacy metadata creates its Atividade x Obra batch once and does not send the field.

One atomic task: remove field handling from normalization, engine, snapshot controller, types and Bubble persistence; update obsolete field tests to this new contract. No new absence-rejection removal is necessary: the prior parser already made the field optional and has no required-field validation for it.

Gate: TypeScript build; 194 tests sequential; git diff --check; no localAtuacao-specific references in src.
