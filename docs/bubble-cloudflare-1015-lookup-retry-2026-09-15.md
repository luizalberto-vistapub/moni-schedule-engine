# Aviso Para Bubble - Cloudflare 1015 No Lookup De Atividade x Obra

## O Que Aconteceu

Em uma geracao inicial grande, o Servidor de Cronograma falhou na etapa `bulk_create` antes de concluir o cronograma.

O erro retornado foi:

```text
BUBBLE_BULK_REQUEST_ERROR:
Bubble atividade obra lookup failed with 429
Cloudflare Error 1015: You are being rate limited
```

Esse erro veio de uma consulta da Data API do Bubble usada pelo motor para procurar Atividade x Obra ja existente na versao do cronograma antes de criar novos registros. Essa consulta faz parte da protecao contra duplicidade/idempotencia.

## Causa

O Bubble/Cloudflare respondeu temporariamente com `429 / 1015` para o lookup de Atividade x Obra.

Antes da correcao, esse lookup falhava imediatamente no primeiro `429`, enquanto outros caminhos de persistencia, como PATCH de datas e dependencias, ja tratavam `429` como erro transitorio com retry.

Tambem foi corrigido um problema no parser de variaveis numericas: quando uma env var estava ausente, alguns defaults podiam cair para o minimo permitido em vez do fallback configurado.

## O Que Mudou No Motor

- Lookups de Atividade x Obra agora retryam falhas transitorias `429` e `5xx`.
- Cloudflare `1015` passa a ser tratado como `429` retryable nesse caminho.
- Falhas nao retryable, como `400`, continuam falhando imediatamente.
- Defaults numericos de env vars ausentes agora usam o fallback correto.

## Impacto Para O Bubble

Nenhuma mudanca obrigatoria no workflow do Bubble.

O Bubble pode continuar aguardando o webhook final `done` ou `error`. Se ocorrer um `429 / 1015` transitorio durante lookup, o motor deve tentar novamente antes de enviar erro final.

## O Que Observar Nos Logs

Durante rate limit transitorio, podem aparecer logs como:

```text
atividade obra idempotency lookup failed; retrying
```

Se todos os retries forem esgotados, o motor ainda enviara webhook final `error` com `BUBBLE_BULK_REQUEST_ERROR`.

## Variaveis Relacionadas

- `BUBBLE_PATCH_MAX_RETRIES`
- `BUBBLE_PATCH_RETRY_BASE_MS`
- `BUBBLE_PATCH_RATE_LIMIT_COOLDOWN_MS`
- `BUBBLE_PATCH_CONCURRENCY`
- `BUBBLE_BULK_CREATE_CONCURRENCY`
- `BUBBLE_BULK_BATCH_SIZE`

Recomendacao operacional para obras grandes:

```env
BUBBLE_BULK_BATCH_SIZE=500
BUBBLE_BULK_CREATE_CONCURRENCY=5
BUBBLE_PATCH_CONCURRENCY=6
```
