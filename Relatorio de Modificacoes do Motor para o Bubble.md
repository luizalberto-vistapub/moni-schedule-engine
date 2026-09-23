# Relatorio de modificacoes do motor para o Bubble

**Data:** 23/09/2026
**Objetivo:** permitir que a equipe responsavel pelo Bubble valide as correcoes do motor, adapte o webhook e trate inconsistencias que exigem intervencao humana.

## 1. Resumo executivo

O motor passou a tratar cada instancia de atividade como um grupo de clones identificado por `atividade|contexto`. O contexto inclui ambiente/produto e, quando aplicavel, o servico ancora. Portanto, atividades iguais em ambientes diferentes nao compartilham a mesma sequencia nem interferem entre si.

As correcoes foram divididas em tres frentes:

1. garantir dias uteis distintos, ordem crescente e capacidade maxima de equipe;
2. recalcular a sequencia completa de clones, em vez de corrigir somente a linha que caiu em dia nao util;
3. congelar a atividade inteira quando qualquer clone tiver evidencia de execucao, preservando datas e auditoria e sinalizando inconsistencias historicas para correcao deliberada.

O contrato do webhook terminal `done` recebeu o objeto opcional `validations`. Nao houve troca de endpoint, metodo ou criacao de uma chamada adicional.

## 2. Problemas corrigidos

### 2.1 Clones concentrados no mesmo dia util

Antes, clones que caiam em sabado/domingo podiam ser normalizados isoladamente para a segunda-feira. Isso permitia que varios clones da mesma atividade terminassem na mesma data.

Agora, para cada atividade/contexto:

- os clones sao processados pela ordem de `clone_index`;
- cada clone movel ocupa um dia util estritamente posterior ao clone anterior;
- uma colisao empurra o clone atual e a sequencia subsequente;
- a quantidade de clones continua correspondendo a duracao prevista;
- somente linhas cuja data mudou sao persistidas.

### 2.2 Capacidade diaria da equipe

Ao escolher a data de cada servico, o motor verifica:

```text
peso ja reservado para equipe/data + peso do clone <= 10
```

Se a soma ultrapassar `10`, o clone e deslocado para o proximo dia util com capacidade. Antes de reconstruir uma sequencia, o motor retira temporariamente as reservas dos proprios clones moveis; reservas de outras atividades e de atividades congeladas continuam contando.

Assim, a conformidade final da sequencia nao ignora a regra de peso.

### 2.3 Calendario de cinco ou seis dias

Todos os avancos e recuos de dia util usam `dias_trabalho_semana` da obra:

- `5`: segunda a sexta;
- `6`: segunda a sabado.

Domingo permanece nao util nos dois calendarios. A regra e aplicada na geracao, nos adiamentos, na correcao de colisao, na capacidade e na manutencao da sequencia.

### 2.4 Isolamento entre ambientes

A chave de agrupamento nao usa apenas a atividade. Ela considera a identidade externa do grupo ou, como fallback:

```text
atividade + ambiente + produto/contexto + servico ancora
```

Com isso, a mesma atividade do mesmo produto em ambientes diferentes e avaliada separadamente. Os testes cobrem um grupo iniciado em `Gadgets` permanecendo congelado enquanto a mesma atividade em `Suites` e recalculada.

### 2.5 Adiamento da obra para a mesma data

O motor aceita o recálculo de manutencao quando o inicio da obra e informado com a mesma data atual. O deslocamento e zero, mas a etapa de conformidade ainda e executada para grupos que podem ser alterados.

Esse recálculo:

- corrige sequencias moveis;
- corrige o caso legado `sabado + segunda` para `sexta + segunda` quando aplicavel;
- respeita o calendario de cinco/seis dias;
- nao altera grupos que tenham evidencia de execucao.

### 2.6 Adiamento por data de corte

No evento `from_date_delayed`, se qualquer clone movel de um grupo estiver dentro do trecho afetado, todos os clones moveis dessa atividade avancam juntos. Isso evita alterar apenas parte da atividade e preserva ordem e intervalo.

### 2.7 Mudanca direta da data de uma atividade

Eventos de alteracao de data agora identificam o grupo exato, inclusive pelo `id_atividade_obra_externo` quando fornecido. A sequencia inteira e reconstruida a partir da nova data, em dias uteis consecutivos, e os dependentes continuam seguindo as regras do evento (`only` ou `cascade`).

## 3. Regras para atividades executadas

### 3.1 Bloqueio da atividade inteira

Durante `mode = recalculate`, o motor examina o snapshot antes de mover linhas. Se qualquer clone possuir evidencia de execucao, todo o grupo `atividade|contexto` fica congelado.

Sao evidencias de execucao:

- status diferente de vazio, `Nao iniciada`, `Recalculada` ou `Pausada`;
- `dataInicioExecucao` ou `data_inicio_execucao` preenchida;
- `dataExecucao` ou `dataExecução` preenchida;
- `iniciadaPor` ou `Iniciada por` preenchido.

O bloqueio por grupo garante que:

- nenhum clone iniciado, concluido ou executado tenha a data alterada automaticamente;
- clones ainda nao executados da mesma atividade tambem nao sejam deslocados isoladamente;
- nenhum clone seja antecipado para antes de um clone executado;
- uma recriacao estrutural descarte datas novas para o grupo protegido e restaure as datas do snapshot.

### 3.2 Preservacao de auditoria na recriacao

Quando registros de `Atividade x Obra` precisam ser recriados, o motor copia os campos anteriores de estado e auditoria, incluindo:

- `status`, `statusCompra`, `statusProjeto` e `statusOcorrencia`;
- `dataInicioExecucao`, `dataExecucao` e `dataExecução`;
- `iniciadaPor` e o alias `Iniciada por`;
- responsaveis, aprovacoes, reprovacoes e observacao ja preservados pelo fluxo.

O Bubble deve continuar enviando esses campos no snapshot. Campo ausente no snapshot nao pode ser recuperado pelo motor.

### 3.3 Inconsistencia historica

Uma sequencia protegida que ja esteja invertida ou repetida nao e autocorrigida. O motor mantem as datas e emite um aviso `activity_group_inconsistent`.

Esse comportamento e intencional: alterar datas automaticamente poderia falsificar o historico de uma atividade ja iniciada. A correcao exige decidir no Bubble qual informacao e verdadeira, por exemplo:

- o status/carimbo foi cadastrado indevidamente e deve ser removido antes de um novo recálculo; ou
- a execucao e real e as datas devem ser corrigidas manualmente com trilha de auditoria.

## 4. Mudanca no webhook

### 4.1 O que mudou

O endpoint permanece:

```text
POST /api/1.1/wf/api_cronograma__webhook_v1
```

O webhook terminal com `status = "done"` passa a incluir dois campos de diagnostico:

```json
{
  "status": "done",
  "validations": {
    "warnings": [],
    "errors": []
  },
  "normalizedDates": []
}
```

`validations` e uma extensao aditiva. Os campos, endpoint, autenticacao e processamento existentes permanecem iguais. Os webhooks intermediarios com `status = "processing"` nao precisam carregar esse objeto.

### 4.2 Significado de `validations`

- `validations.warnings`: ocorrencias que nao interromperam o job, mas exigem registro, exibicao ou intervencao;
- `validations.errors`: erros de validacao associados ao resultado. Em um `done` normal, a lista tende a estar vazia;
- a presenca de warnings nao transforma `done` em erro e nao autoriza o Bubble a repetir automaticamente o job.

Os avisos novos seguem os formatos:

```text
activity_group_locked:<chave-do-grupo>: recalculation skipped because execution has started
activity_group_locked:<chave-do-grupo>: generated dates were discarded because execution has started
activity_group_inconsistent:<chave-do-grupo>: clone dates are not strictly increasing; manual correction required
```

O primeiro informa que um evento tentou atingir uma atividade protegida. O segundo informa que uma recriacao gerou novas datas, mas o motor restaurou as datas anteriores. O terceiro identifica uma sequencia historica protegida que exige correcao manual.

### 4.3 Tratamento recomendado no Bubble

Ao receber `status = "done"`, o workflow deve:

1. manter o job como concluido e processar normalmente `metrics` e `normalizedDates`;
2. armazenar `validations.warnings` e `validations.errors` vinculados ao job/cronograma/versao;
3. marcar a versao como "concluida com alertas" quando `warnings:count > 0`;
4. exibir uma pendencia operacional para cada `activity_group_inconsistent`;
5. nao disparar novo recálculo automatico para `activity_group_locked`;
6. permitir que um usuario autorizado corrija os dados e solicite um novo recálculo deliberadamente;
7. aceitar a ausencia de `validations` enquanto existirem versoes antigas do motor em transicao.

O Bubble nao deve interpretar warning como falha de persistencia. Para falhas do job, continuam valendo `status = "error"`, `error_code`, `error_message`, `error_details` e `failed_step`.

### 4.4 Exemplo completo para deteccao do endpoint

```json
{
  "job_id": "job_exemplo_001",
  "status": "done",
  "progress": 4,
  "progress_percent": 100,
  "cronograma_unique_id": "cronograma_exemplo",
  "versao_cronograma_unique_id": "versao_exemplo",
  "previous_version_id": "versao_anterior",
  "metrics": {
    "linesCount": 120,
    "patchedCount": 0,
    "patchRequestCount": 0,
    "patchBatchCount": 0,
    "eventCount": 1,
    "dependencyPatchCount": 0,
    "createdCount": 0,
    "bulkBatchCount": 0,
    "bulkRetryCount": 0,
    "dedupDroppedCount": 0,
    "durationMs": 850
  },
  "validations": {
    "warnings": [
      "activity_group_locked:1783538847158x942940568752226300|1787748724286x234216719803543880: recalculation skipped because execution has started",
      "activity_group_inconsistent:1783538847158x942940568752226300|1787748724286x234216719803543880: clone dates are not strictly increasing; manual correction required"
    ],
    "errors": []
  },
  "normalizedDates": []
}
```

O exemplo serve apenas para o Bubble detectar a estrutura. IDs, metricas e textos devem vir do job real.

## 5. `normalizedDates`

`normalizedDates` continua sendo uma lista de alteracoes automaticas efetivamente aplicadas. Cada item contem:

```json
{
  "id_atividade_obra_externo": "atividade|contexto|3",
  "requested": "2026-09-21",
  "applied": "2026-09-22",
  "reason": "clone_sequence_collision"
}
```

Valores possiveis de `reason`:

- `non_working_day`: data em dia nao util;
- `clone_sequence_collision`: repeticao ou quebra de ordem entre clones;
- `team_capacity`: peso da equipe excederia `10`.

Diferenca importante:

- `normalizedDates` descreve o que o motor alterou;
- `validations.warnings` descreve o que o motor deliberadamente nao alterou ou encontrou inconsistente.

## 6. Tratamento do cronograma atual

O grupo de *Passagem de infra p/ ar condicionado dutado (living integrado)* possui um clone posterior marcado como iniciado e uma sequencia de datas invertida. Com as regras novas, ele sera preservado e sinalizado, nao reorganizado silenciosamente.

Para resolver o dado atual, o Bubble deve abrir uma correcao deliberada:

1. conferir o registro de execucao, especialmente `status`, `dataInicioExecucao`, `dataExecucao` e `iniciadaPor`;
2. confirmar se a execucao foi real ou se houve erro de cadastro;
3. se o inicio foi indevido, corrigir/remover a evidencia incorreta e entao solicitar novo recálculo;
4. se o inicio foi real, manter a auditoria e ajustar manualmente as datas planejadas conforme a decisao operacional;
5. registrar usuario, data e justificativa da correcao;
6. executar novo recálculo e confirmar que nao resta `activity_group_inconsistent` para o grupo.

O motor nao escolhe entre essas duas hipoteses, pois ambas sao tecnicamente possiveis e produzem historicos diferentes.

## 7. Criterios de aceite para o Bubble

1. O endpoint aceita o objeto opcional `validations` sem rejeitar a requisicao.
2. Um job `done` com warning continua concluido, mas fica visivelmente sinalizado.
3. O Bubble preserva o texto completo e a chave do grupo de cada warning.
4. `activity_group_inconsistent` cria uma pendencia de correcao deliberada.
5. O snapshot enviado ao motor inclui status, datas de execucao e `iniciadaPor` de todos os clones.
6. O Bubble nao dispara loop de recálculo ao receber `activity_group_locked`.
7. Os tres motivos de `normalizedDates` sao aceitos.
8. Obras de cinco e seis dias sao testadas separadamente.
9. A mesma atividade em ambientes diferentes e validada como grupos independentes.
10. Depois da correcao manual do cronograma atual, o warning da inversao deixa de ser emitido.

## 8. Cobertura e rastreabilidade

Foram adicionados testes para:

- sequencia estritamente crescente e dias uteis distintos;
- colisao de clones deslocados de fim de semana;
- capacidade por equipe/data com limite `10`;
- calendario de cinco e seis dias;
- isolamento da mesma atividade entre contextos diferentes;
- reconstrucao completa em alteracao direta de data;
- adiamento por data de corte movendo o grupo inteiro;
- congelamento integral quando qualquer clone tem evidencia de execucao;
- preservacao das datas antigas em recriacao estrutural;
- emissao dos warnings de bloqueio e inconsistencia;
- preservacao de `iniciadaPor` na recriacao.

Validacao local da implementacao: **203 testes aprovados em 7 arquivos**, build TypeScript aprovado e **75 testes** do controlador aprovados.

Commits relacionados:

- `a1f1eed` - preservacao da sequencia de clones e capacidade da equipe;
- `b95f90d` - reconstrucao completa das sequencias de clones;
- `911e920` - congelamento dos grupos executados e diagnosticos no webhook;
- `ac51330` - preservacao de `iniciadaPor`;
- `2f1883e` - documentacao das protecoes de atividades executadas.

Os tres ultimos commits estao, neste momento, locais na branch `test` e ainda nao foram publicados. Portanto, o Bubble deve adaptar o webhook antes, ou em coordenacao com, a promocao dessa versao.

## 9. Arquivos alterados

- `src/controllers/schedules.controller.ts`: agrupamento, sequenciamento, capacidade, congelamento, preservacao e warnings;
- `src/services/schedule-webhook.service.ts`: tipo do novo objeto `validations`;
- `src/services/bubble-bulk.service.ts`: preservacao de `iniciadaPor`/`Iniciada por`;
- `src/types/schedule.types.ts`: novos motivos de `normalizedDates`;
- `tests/schedules.controller.test.ts`: cobertura das regras do motor;
- `tests/bubble-bulk.service.test.ts`: cobertura da auditoria na recriacao;
- `Regras do Cronograma.md`: especificacao consolidada das regras de negocio.
