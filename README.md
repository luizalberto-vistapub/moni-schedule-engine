# moni-schedule-engine

Servidor Node.js + TypeScript para processar o motor de cronograma de obra do sistema Moni.

## Arquitetura

O Bubble segue responsável por orquestração, montagem do payload, persistência e interface. Este servidor calcula o cronograma a partir do payload recebido no Step 12 do Workflow 1.

## Requisitos

- Node.js 20+
- npm

## Rodando localmente

```bash
npm install
npm run dev
```

O servidor escuta em `process.env.PORT || 3000` e faz bind em `0.0.0.0`.

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
    "events_json": []
  }'
```

Payloads completos de exemplo ficam em `examples/generate.payload.json` e `examples/recalculate.payload.json`.

## Recalcular cronograma

`POST /api/v1/schedules/recalculate` usa a mesma lógica de geração nesta primeira versão. Quando `mode` for `recalculate`, cada item de `events_json` deve ter `type` como string não vazia.

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
