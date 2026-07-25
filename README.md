# moni-schedule-engine

Servidor Node.js + TypeScript para processar o motor de cronograma de obra do sistema Moni.

## Arquitetura

O Bubble segue responsavel por orquestracao, montagem do payload e interface. Este servidor calcula o cronograma a partir do payload recebido no Step 12 do Workflow 1, responde `201 Created` e persiste as linhas calculadas via Bulk Data API do Bubble.

O servidor so responde `201 Created` depois que a persistencia principal termina com sucesso. Ou seja, ele nao foi desenhado para responder antes do processamento completo do fluxo.

Fluxo de alto nivel:

1. O endpoint recebe o payload.
2. O payload passa por validacao estrutural com `zod`.
3. O payload e normalizado.
4. Em `recalculate`, eventos antigos e novos sao conciliados.
5. O motor gera as linhas do cronograma.
6. Regras adicionais de recalculo sao aplicadas sobre o resultado gerado.
7. As linhas sao persistidas no Bubble como `Atividade x Obra`.
8. Os eventos ativos sao persistidos em `EventoCronograma`, quando existirem.
9. Dependencias de `Atividade x Obra` sao patchadas depois da criacao, porque os ids Bubble ainda nao existem no momento do bulk create.

## Requisitos

- Node.js 20+
- npm

## Rodando Localmente

```bash
npm install
npm run dev
```

O servidor escuta em `process.env.PORT || 3000` e faz bind em `0.0.0.0`.

## Variaveis De Ambiente

```bash
PORT=3000
NODE_ENV=development
BUBBLE_API_TOKEN=seu_token
BUBBLE_API_BASE_URL=https://moni-29694.bubbleapps.io
BUBBLE_BULK_BATCH_SIZE=500
BUBBLE_CRONOGRAMA_LINHA_TYPE=cronogramalinha
BUBBLE_ATIVIDADE_OBRA_TYPE=atividadexobra
BUBBLE_EVENTO_CRONOGRAMA_TYPE=eventocronograma
```

Sem `BUBBLE_API_TOKEN`, o servidor retorna erro de configuracao e nao responde `201`, porque `201 Created` so deve acontecer depois da persistencia no Bubble.

## Scripts

```bash
npm run dev
npm run build
npm start
npm test
npm run coverage
```

## Health Check

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

## Rotas

- `GET /health`
- `GET /ready`
- `POST /api/v1/schedules/generate`
- `POST /api/v1/schedules/recalculate`

Arquivos centrais:

- `src/app.ts`
- `src/routes/schedules.routes.ts`
- `src/controllers/schedules.controller.ts`
- `src/services/schedule-engine.service.ts`
- `src/services/normalize-payload.service.ts`
- `src/services/bubble-bulk.service.ts`

## Gerar Cronograma

```bash
curl -X POST http://localhost:3000/api/v1/schedules/generate \
  -H "Content-Type: application/json" \
  -d '{
    "cronograma_unique_id": "cronograma_123",
    "versao_cronograma_unique_id": "versao_cronograma_123",
    "bubble_api_version": "version-739n8",
    "mode": "generate",
    "dias_trabalho_semana": 5,
    "timezone": "America/Sao_Paulo",
    "requested_by": "bubble",
    "reason": "initial build",
    "numero": 1,
    "previous_version_id": null,
    "obra_json": [{ "id": "obra_1", "dataInicio": "2026-05-04" }],
    "obra_ambiente_json": [{ "id": "amb_1", "nome": "Sala" }],
    "obra_ambiente_produto_json": [{ "id": "oap_1", "ambienteId": "amb_1", "produtoId": "prod_1", "produtoNome": "Piso", "quantidade": 12 }],
    "atividades_json": [
      { "id": "serv_1", "nome": "Instalar piso", "tipo": "Servico", "ordem": 1, "duracao": 2, "duracaoVariavel": true, "quantidadeBase": 10, "peso": 5, "equipe": "Equipe A" }
    ],
    "atividade_obra_json": [],
    "events_old": [],
    "events_json": []
  }'
```

Payloads completos de exemplo ficam em `examples/generate.payload.json` e `examples/recalculate.payload.json`.

O branch/versao da API do Bubble deve vir no body em `bubble_api_version` (tambem sao aceitos `bubble_version` ou `version`), por exemplo `version-739n8`.

O payload precisa incluir o `unique id` da `VersaoCronograma` em `versao_cronograma_unique_id` (tambem sao aceitos `versao_cronograma_id`, `versaoCronograma` ou `version_id`). O `cronograma_unique_id` e o `id` ou `unique_id` da primeira `obra_json` sao usados nas referencias do bulk.

## Recalcular Cronograma

`POST /api/v1/schedules/recalculate` recalcula o cronograma completo e persiste os novos registros por bulk create, usando `versao_cronograma_unique_id` como a nova `VersaoCronograma`. O payload tambem deve enviar `previous_version_id` com a versao anterior; os dois ids precisam ser diferentes.

O servidor so responde `ok: true` depois que os bulks de `cronogramalinha`, `atividadexobra` e, quando houver eventos ativos, `eventocronograma` terminam com sucesso. No Bubble, apague os registros antigos apenas depois desse `ok: true`.

Para recalculos sucessivos, envie:

- `events_old`: eventos ativos herdados da `previous_version_id`, normalmente consultados em `EventoCronograma`
- `events_json`: eventos novos da chamada atual

O servidor aplica `events_old + events_json` no recalculo e persiste o conjunto ativo de eventos em `eventocronograma` apontando para a nova `versaoCronograma`. Assim uma segunda mudanca nao remove uma mudanca manual anterior.

## Contrato Principal Do Payload

Campos estruturais aceitos:

- `cronograma_unique_id`: obrigatorio
- `mode`: aceito, mas a rota tambem define o modo efetivo
- `dias_trabalho_semana`: `5` ou `6`
- `timezone`: opcional
- `requested_by`, `reason`, `numero`: opcionais
- `versao_cronograma_unique_id` ou aliases equivalentes
- `previous_version_id`: obrigatorio em `recalculate`
- `event_date`, `request_date`, `requisicao_data`, `data_requisicao`: aliases aceitos para data de corte do recalculo
- `obra_json`: obrigatorio, com pelo menos um item
- `obra_ambiente_json`
- `obra_ambiente_produto_json`
- `obra_ambiente_item_composicao_json`
- `atividades_json`
- `atividade_obra_json`
- `events_old`
- `events_json`

Aliases importantes aceitos no servidor:

- Versao do Bubble: `bubble_api_version`, `bubble_version`, `version`
- Versao do cronograma: `versao_cronograma_unique_id`, `versao_cronograma_id`, `versaoCronograma`, `version_id`
- Data de inicio da obra: `dataInicio`, `data_inicio`, `startDate`

## Regras De Normalizacao

Antes do motor rodar, o payload passa por normalizacao para reduzir variacoes vindas do Bubble.

### Tipos De Atividade

Os tipos sao normalizados para:

- `Servico`
- `Compra`
- `Projeto`

Valores como `Servico` tambem sao aceitos e convertidos.

### Produtos De Composicao

Se `obra_ambiente_produto_json` vier vazio, o servidor tenta montar os produtos a partir de `obra_ambiente_item_composicao_json`.

### Projetos Ligados A Servicos

Se uma atividade de servico vier com `atividadeProjeto`, o servidor expande isso em atividades do tipo `Projeto`.

Se existir ao mesmo tempo:

- um projeto explicito em `atividades_json`
- e um projeto derivado de `atividadeProjeto`

o servidor faz merge, preservando o vinculo com o servico ancora e evitando duplicidade.

### Etapas De Compra

`etapaCompra` e normalizada para um conjunto fechado:

- `AVISO_ORCAMENTO`
- `LIMITE_ORCAMENTO`
- `LIMITE_COMPRA`
- `RECEBIMENTO`

## Regras De Geracao Do Cronograma

O motor principal esta em `src/services/schedule-engine.service.ts`.

### 1. Data Inicial Da Obra

- O cronograma parte de `obra_json[0].dataInicio`.
- A data e ajustada para o proximo dia util conforme `dias_trabalho_semana`.

### 2. Servicos Sao O Eixo Principal Do Cronograma

Atividades do tipo `Servico` sao posicionadas primeiro.

Criterios usados:

- `ordem`
- dependencias em `interdependenciasMasterIds`
- capacidade de equipe por dia
- duracao e quantidade

### 3. Capacidade Diaria Da Equipe

O servidor limita a soma de `peso` por `equipe` e por dia em `10`.

Consequencias:

- duas atividades da mesma equipe podem ser empurradas para dias posteriores mesmo sem dependencia formal
- a mesma atividade nao pode ocupar o mesmo dia duas vezes

### 4. Duracao E Clones

Cada atividade gera uma ou mais linhas.

Regra:

- se `duracaoVariavel = false`, a quantidade de linhas segue `duracao`
- se `duracaoVariavel = true`, a quantidade de clones e calculada por `ceil((duracao * quantidade do produto) / quantidadeBase)`
- o minimo e `1`

Cada clone gera um `atividade_obra_id_externo` no formato:

- `{atividadeId}_{YYYY-MM-DD}_{cloneIndex}`

### 5. Dependencias Entre Servicos

Uma atividade de servico so pode iniciar:

- no minimo no proximo dia util apos o termino da dependencia mais tardia
- respeitando tambem a ordem do grupo

Quando varias atividades compartilham a mesma `ordem`, o motor ainda tenta respeitar dependencias internas dentro desse grupo.

### 6. Compras E Projetos Sao Ancorados Em Servicos

Depois dos servicos, o motor posiciona:

- `Compra`
- `Projeto`

Essas atividades sao calculadas para tras a partir de um servico ancora.

Resolucao pratica da ancora:

1. `atividadeServicoAncoraId` apontando diretamente para um servico
2. `atividadeServicoAncoraId` apontando para produto simples ou produto composto relacionado
3. produto composto do proprio item da atividade

Quando ha produto composto, o motor tende a usar o servico mais cedo daquele composto como referencia.

Compras sao ordenadas principalmente pela etapa:

1. `AVISO_ORCAMENTO`
2. `LIMITE_ORCAMENTO`
3. `LIMITE_COMPRA`
4. `RECEBIMENTO`

A data da compra e calculada subtraindo dias da data de inicio do servico ancora.

Fonte do offset:

- `offsetDias`, se informado
- senao um offset padrao incremental por ancora

Projetos tambem sao posicionados para tras usando como referencia:

- a compra mais cedo daquela ancora, quando existir
- senao a data do servico ancora

## Dependencias Nas Linhas Geradas

Depois de gerar as linhas, o servidor popula `interdependenciasMasterIds` com os ids externos das linhas dependentes, nao apenas com ids de atividade.

Isso e importante porque uma atividade pode gerar varios clones, e o Bubble persiste dependencias entre registros de `Atividade x Obra`.

## Regras De Recalculo

O recalculo usa a mesma geracao base, mas aplica validacoes e transformacoes extras antes e depois do motor.

### Contrato Obrigatorio Em `recalculate`

Em `POST /api/v1/schedules/recalculate`:

- `versao_cronograma_unique_id` e obrigatorio e deve ser a nova versao
- `previous_version_id` e obrigatorio
- os dois ids devem ser diferentes

Se isso falhar, o servidor devolve `400 INVALID_PAYLOAD`.

### Tipos De Evento Aceitos

No payload, os eventos novos podem usar os codigos internos abaixo. Eventos herdados de `EventoCronograma` tambem podem chegar com o `tipo` em portugues, porque o campo no Bubble e um option set. No bulk de `eventocronograma`, o servidor sempre grava o `tipo` com o valor em portugues aceito pelo Bubble:

- `work_start_delayed` -> `Adiar inicio da obra`
- `activity_start_delayed` -> `Adiar inicio da atividade`
- `activity_date_changed_cascade` -> `Alterar data da atividade com dependentes`
- `activity_date_changed_only` -> `Alterar somente data da atividade`
- `from_date_delayed` -> `Paralisar a obra`
- `activity_inserted` -> `Inserida nova atividade`

Tipos aceitos em `events_json`:

- `work_start_delayed`
- `activity_start_delayed`
- `activity_date_changed_cascade`
- `activity_date_changed_only`
- `from_date_delayed`
- `activity_inserted`

### Precedencia Entre `events_old` E `events_json`

O servidor consolida eventos antigos e novos.

Regra principal:

- `events_json` sobrescreve eventos equivalentes de `events_old`

Chaves de sobrescrita:

- eventos globais de cronograma usam a chave `schedule`
- eventos por atividade usam a chave `activity:{atividadeId}`

Consequencia:

- um evento novo para a mesma atividade substitui o antigo
- eventos antigos de outras atividades continuam ativos

Essa regra vale tanto para o comportamento do motor quanto para a persistencia posterior em `eventocronograma`.

### Regras Por Tipo De Evento

#### `work_start_delayed`

- aceita `new_start_date`
- aplica essa data em `obra_json[0].dataInicio` antes de gerar o novo cronograma

#### `activity_start_delayed`

- exige `atividade_id` ou equivalente resolvivel pelo `id_atividade_obra_externo`
- exige `new_start_date`
- injeta `__recalculateStartDate` na atividade correspondente antes da geracao
- tenta respeitar essa data como data minima da atividade

#### `activity_date_changed_only`

- exige `atividade_id` ou `id_atividade_obra_externo`
- exige `new_start_date`
- altera somente a linha alvo depois da geracao
- nao move dependentes

#### `activity_date_changed_cascade`

- exige `atividade_id` ou `id_atividade_obra_externo`
- exige `new_start_date`
- calcula o delta entre a data original e a nova data
- aplica o mesmo delta na atividade alvo e nos dependentes diretos e indiretos

Regra adicional importante:

- se a atividade alvo for do tipo `Compra` e estiver ligada a um `atividadeServicoAncoraId`, o recalculo em cascata tambem inclui o servico ancora e o fecho de dependencias desse servico

#### `from_date_delayed`

- paralisa a obra a partir de uma data
- usa `atividade_obra_json` como snapshot anterior para preservar atividades com data anterior ao corte
- desloca por `days` dias uteis apenas as linhas na data do corte ou depois dela

Se `days = 0`, as datas geradas sao mantidas.

#### `activity_inserted`

- registra o motivo do recalculo
- a mudanca funcional depende de o payload ja vir completo com a nova atividade e as dependencias corretas

Ou seja, nao existe uma logica especial de insercao automatica dentro da engine. O Bubble precisa mandar o payload final desejado.

### Regra Especifica Da Cadeia De Compras

Existe uma regra adicional importante para `activity_start_delayed` quando a atividade alterada e uma `Compra`.

Comportamento:

1. O servidor identifica a linha de compra alterada.
2. Ele localiza o mesmo `produtoId` e a mesma ancora (`atividadeServicoAncoraId`).
3. Ele monta a cadeia de compras daquele item.
4. Usa `event_date` ou alias equivalente como data de corte.
5. Somente atividades da cadeia com data original maior ou igual ao corte sao deslocadas.
6. Servicos dependentes da ancora tambem podem ser deslocados a partir do mesmo delta.

Depois do deslocamento, o servidor garante que a ordem das etapas da compra continue crescente. Se uma etapa ficar na mesma data ou antes da anterior, ela e empurrada em `+1` dia corrido em relacao a etapa anterior.

## Snapshot Anterior E Preservacao De Dados

O recalculo nao usa apenas o payload novo. Ele tambem depende do snapshot anterior em `atividade_obra_json`.

Usos principais:

- recuperar datas anteriores por atividade ou clone
- preservar datas anteriores ao corte em `from_date_delayed`
- calcular delta correto em eventos de mudanca de data
- preservar campos hidratados na persistencia de `Atividade x Obra`

Campos herdados do snapshot anterior durante a persistencia:

- `responsavel`
- `responsavelFranqueado`
- `sortOcorrencia`
- `sortTipo`
- `status`
- `statusCompra`
- `statusProjeto`
- `statusOcorrencia`

## Persistencia No Bubble

O servidor persiste principalmente em:

- `atividadexobra`
- `eventocronograma`

Observacao:

- existe funcao para montar `cronogramalinha`, mas o fluxo atual de persistencia executado em `persistScheduleBulks` usa `Atividade x Obra`, eventos e patch de dependencias

### Requisitos Obrigatorios Para Persistencia

Se faltar qualquer item abaixo, a persistencia falha:

- `BUBBLE_API_TOKEN`
- `bubble_api_version` ou alias equivalente
- `versao_cronograma_unique_id` ou alias equivalente
- `obra_json[0].unique id` ou `id`

Retornos esperados:

- erro de configuracao: `500 BUBBLE_BULK_CONFIG_ERROR`
- erro de payload para bulk: `400 BUBBLE_BULK_PAYLOAD_ERROR`
- erro de chamada Bubble: `502 BUBBLE_BULK_REQUEST_ERROR`

### Regras De `Atividade x Obra`

Na criacao de `Atividade x Obra`, o servidor:

- grava `copyDuracao = true` para clones com indice maior que `1`
- usa a mesma data para `dataInicioPrevista` e `dataFimPrevista`
- grava `Produto (raiz)` com o `produtoId`
- prioriza `ambiente x item composicao`
- usa `ambiente x obra` apenas quando `ambiente x item composicao` nao existir
- preserva campos hidratados do snapshot anterior

Ha ainda uma tolerancia operacional:

- se o Bubble rejeitar `ambiente x obra` com erro de referencia ausente, o servidor tenta reenviar o bulk sem esse campo

### Persistencia De Eventos

Os eventos ativos consolidados sao persistidos em `eventocronograma` apontando para a nova `versaoCronograma`.

No momento de gravar:

- o servidor converte os tipos internos para os labels esperados pelo Bubble
- exemplo: `activity_start_delayed` vira `Adiar inicio da atividade`

Isso e essencial para recalculos sucessivos:

- a nova versao carrega os eventos ainda ativos
- uma alteracao manual anterior nao e perdida so porque houve um novo recalculo

## Validacoes Importantes

Exemplos de validacoes explicitamente cobertas no codigo e nos testes:

- payload invalido retorna `400 INVALID_PAYLOAD`
- tipo de evento vazio em `recalculate` retorna `400`
- tipo de evento nao suportado retorna `400`
- `new_start_date` obrigatorio para:
  - `work_start_delayed`
  - `from_date_delayed`
  - `activity_start_delayed`
  - `activity_date_changed_cascade`
  - `activity_date_changed_only`
- `atividade_id` obrigatorio para:
  - `activity_start_delayed`
  - `activity_date_changed_cascade`
  - `activity_date_changed_only`

## CI

O workflow `.github/workflows/ci.yml` roda em push e pull request para `main`:

```bash
npm ci
npm run build
npm run coverage
```

## Docker

```bash
npm run build
docker build -t moni-schedule-engine .
docker run -p 3000:3000 moni-schedule-engine
```

## Observacoes

- Nao usa banco de dados nesta versao.
- Nao ha secrets reais no repositorio.
- `.env` nao deve ser commitado.
- `Servico` define a espinha dorsal do cronograma.
- `Compra` e `Projeto` sao calculados para tras a partir de servicos ancora.
- Dependencias e capacidade de equipe podem empurrar datas.
- `events_json` tem prioridade sobre `events_old` para o mesmo alvo logico.
- A correcao principal do bug de ancora ocorreu no payload vindo do Bubble, nao em uma nova mudanca funcional da engine para esse caso especifico.
