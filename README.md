# moni-schedule-engine

Servidor Node.js + TypeScript para processar o motor de cronograma de obra do sistema Moni.

## Arquitetura

O Bubble segue responsável por orquestração, montagem do payload e interface. Este servidor calcula o cronograma a partir do payload recebido no Step 12 do Workflow 1, responde `201 Created` e persiste as linhas calculadas via Bulk Data API do Bubble.

## Requisitos

- Node.js 20+
- npm

## Rodando localmente

```bash
npm install
npm run dev
```

O servidor escuta em `process.env.PORT || 3000` e faz bind em `0.0.0.0`.

## Variáveis de ambiente

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

Sem `BUBBLE_API_TOKEN`, o servidor retorna erro de configuração e não responde `201`, porque `201 Created` só deve acontecer depois da persistência no Bubble.

## Scripts

```bash
npm run dev
npm run build
npm start
npm test
npm run coverage
```

## Health check

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

## Gerar cronograma

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

O payload precisa incluir o `unique id` da `VersaoCronograma` em `versao_cronograma_unique_id` (também são aceitos `versao_cronograma_id`, `versaoCronograma` ou `version_id`). O `cronograma_unique_id` e o `id`/`unique_id` da primeira `obra_json` são usados nas referências do bulk.

## Recalcular cronograma

`POST /api/v1/schedules/recalculate` recalcula o cronograma completo e persiste os novos registros por bulk create, usando `versao_cronograma_unique_id` como a nova `VersaoCronograma`. O payload também deve enviar `previous_version_id` com a versão anterior; os dois ids precisam ser diferentes.

O servidor só responde `ok: true` depois que os bulks de `cronogramalinha`, `atividadexobra` e, quando houver eventos ativos, `eventocronograma` terminam com sucesso. No Bubble, apague os registros antigos apenas depois desse `ok: true`.

Para recálculos sucessivos, envie:

- `events_old`: eventos ativos herdados da `previous_version_id`, normalmente consultados em `EventoCronograma`.
- `events_json`: eventos novos da chamada atual.

O servidor aplica `events_old + events_json` no recálculo e persiste o conjunto ativo de eventos em `eventocronograma` apontando para a nova `versaoCronograma`. Assim uma segunda mudança não remove uma mudança manual anterior.

No payload, os eventos novos podem usar os códigos internos abaixo. Eventos herdados de `EventoCronograma` também podem chegar com o `tipo` em português, porque o campo no Bubble é um option set. No bulk de `eventocronograma`, o servidor sempre grava o `tipo` com o valor em português aceito pelo Bubble:

- `work_start_delayed` -> `Adiar início da obra`
- `activity_start_delayed` -> `Adiar início da atividade`
- `from_date_delayed` -> `Paralisar a obra`
- `activity_inserted` -> `Inserida nova atividade`

Tipos aceitos em `events_json`:

- `work_start_delayed`: aceita `new_start_date` e aplica essa data em `obra_json[0].dataInicio` antes de gerar o novo cronograma.
- `activity_start_delayed`: registra o motivo do recálculo; envie o payload completo já ajustado.
- `from_date_delayed`: registra o motivo do recálculo; envie o payload completo já ajustado.
- `activity_inserted`: registra o motivo do recálculo; envie a nova atividade em `atividades_json` e as dependências atualizadas em `interdependenciasMasterIds`.

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

## Observações

- Não usa banco de dados nesta versão.
- Não há secrets reais no repositório.
- `.env` não deve ser commitado.
