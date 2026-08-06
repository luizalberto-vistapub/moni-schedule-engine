# Atividade x Obra valorRaiz

## Context

O payload de cronograma passa a trazer `valor` no item de composição (`obra_ambiente_item_composicao_json`) e `percentual` nas atividades. O registro persistido em Atividade x Obra deve carregar o campo numérico `valorRaiz` calculado a partir desses dados.

## Acceptance criteria

- AC1 — Para atividade de compra filha, `valorRaiz` deve ser `valor do produto simples * percentual da atividade de compra`.
- AC2 — O mesmo cálculo de compra deve ser aplicado em cada filha de compra gerada para o respectivo produto simples.
- AC3 — Para atividade de mão de obra/serviço, `valorRaiz` deve ser `valor do produto simples * (percentual da atividade de serviço / número de cópias geradas daquela atividade no mesmo produto/contexto)`.
- AC4 — Quando `valor` ou `percentual` não vierem preenchidos como número utilizável, `valorRaiz` deve ser preenchido com `0`, sem impedir a persistência.
