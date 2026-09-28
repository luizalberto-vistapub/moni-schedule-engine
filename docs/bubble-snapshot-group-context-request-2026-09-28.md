# Pedido ao Bubble: contexto de composição no snapshot

> **Atualização:** o Bubble confirmou que o identificador correto é o `unique id` do registro de Memorial descritivo já recebido em `obra_ambiente_item_composicao_json`. A solução adotada preserva o ID externo e grava `produtoComposto`, `origemComposicao`, `diaDoBloco` e `totalDiasDoBloco`. O Bubble deverá ecoar esses campos no snapshot. A fórmula de duração variável continua pendente de confirmação e não foi alterada.

**Data:** 2026-09-28  
**Ambiente analisado:** Live  
**Obra de referência:** FK0002_Sidney Pereira Junior

## Problema

O motor precisa identificar um grupo de clones pela ocorrência real da atividade na obra:

```text
atividade + ambiente + item/produto da composição
```

O payload Live analisado contém 4.622 registros em `atividade_obra_snapshot`, mas as linhas possuem apenas `atividade` e `ambiente_id` como contexto de agrupamento. Não são enviados `obraAmbienteProdutoId`, `ambienteItemComposicaoId` nem outro identificador estável da ocorrência do produto composto.

O `id_atividade_obra_externo` atual (`atividade|ambiente|índice`) separa ambientes diferentes, mas não distingue duas ocorrências da mesma atividade dentro do mesmo ambiente quando elas pertencem a produtos compostos ou itens de composição diferentes.

Sem esse contexto, o motor não consegue separar esses grupos com segurança. Inferir pelo índice, pela data ou pela ordem seria instável e poderia associar clones e dependências ao produto errado.

## Informação solicitada

Enviar em cada linha de `atividade_obra_snapshot`, inclusive linhas `anchor` e `editable`, pelo menos um identificador estável da ocorrência contextual:

- `ambienteItemComposicaoId` / `ambiente x item composicao` (preferencial); ou
- `obraAmbienteProdutoId` / `produto (Obra x Ambiente x Produto)`.

Quando ambos existirem, enviar ambos. O campo precisa identificar a ocorrência materializada na obra, não somente o cadastro global do produto simples.

Exemplo:

```json
{
  "unique id": "1790615520248x237506560642166900",
  "id_atividade_obra_externo": "1783708049211x296908778919690240|1787748692780x661619695058485600|1",
  "atividade": "1783708049211x296908778919690240",
  "ambiente_id": "1787748692780x661619695058485600",
  "ambienteItemComposicaoId": "<id da ocorrencia na composicao>",
  "obraAmbienteProdutoId": "<id do produto materializado no ambiente>"
}
```

Não é necessário alterar o `id_atividade_obra_externo` existente neste momento; ele continua sendo a identidade usada para PATCH idempotente. Os novos campos serão usados para agrupamento, dependências e auditoria.

## Pergunta ao responsável pelo Bubble

É possível incluir `ambienteItemComposicaoId` e/ou `obraAmbienteProdutoId` em 100% das linhas de `atividade_obra_snapshot` nos payloads de geração e recálculo enviados ao motor a partir de agora, tanto no contrato v2 quanto no v3?

Se algum tipo de atividade não possuir esses relacionamentos, precisamos saber qual identificador alternativo representa de forma única sua ocorrência no ambiente.

## Comportamento até a adequação

- Ambientes diferentes continuam separados pelo `ambiente_id`.
- O motor não deve adivinhar o produto composto dentro do mesmo ambiente.
- Casos sem contexto suficiente devem permanecer inalterados e ser relatados em `validations.warnings`.
- A ausência desses campos não deve produzir `status: "error"`.

## Critério de aceite

Em uma obra que contenha a mesma atividade simples em dois produtos compostos no mesmo ambiente, as linhas dos dois grupos devem chegar ao motor com identificadores contextuais diferentes e estáveis em recálculos sucessivos.
