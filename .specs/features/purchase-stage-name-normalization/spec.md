# Purchase Stage Name Normalization

## Problem

Bubble can send the purchase stage followed or preceded by the product/activity description. Child purchase activities must remain recognizable while the generic parent purchase activity must stay excluded.

## Acceptance Criteria

- **PSN-01** — WHEN `etapaCompra` contains `Aviso de orçamento`, with or without `de`, anywhere as complete normalized words, THEN it SHALL normalize to `AVISO_ORCAMENTO`.
- **PSN-02** — WHEN `etapaCompra` contains `Limite de orçamento`, with or without `de`, anywhere as complete normalized words, THEN it SHALL normalize to `LIMITE_ORCAMENTO`.
- **PSN-03** — WHEN `etapaCompra` contains `Limite de compra`, with or without `de`, anywhere as complete normalized words, THEN it SHALL normalize to `LIMITE_COMPRA`.
- **PSN-04** — WHEN `etapaCompra` contains `Recebimento` anywhere as a complete normalized word, THEN it SHALL normalize to `RECEBIMENTO`.
- **PSN-05** — WHEN the text is a generic parent such as `Atividade de compra 1 - produto` and contains none of the four child stages, THEN it SHALL normalize to `null`.

## Scope

- Matching is accent-insensitive and respects normalized word boundaries.
- Existing exact aliases remain supported.
- Purchase anchoring and consolidation behavior are unchanged.
