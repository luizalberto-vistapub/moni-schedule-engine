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
- Durante cada retry de lookup, o motor envia um webhook `processing` repetindo a etapa e o percentual atuais.

## Impacto Para O Bubble

Nenhuma mudanca obrigatoria no workflow do Bubble.

O Bubble pode continuar aguardando o webhook final `done` ou `error`. Se ocorrer um `429 / 1015` transitorio durante lookup, o motor tenta novamente antes de enviar erro final.

Enquanto o motor estiver em cooldown, ele renova o sinal de vida com o mesmo webhook de progresso ja existente:

```json
{
  "job_id": "<job_id corrente>",
  "status": "processing",
  "progress": 2,
  "progress_percent": 35,
  "message": "Aguardando liberacao do Bubble (tentativa 2 de 5)"
}
```

Esse webhook nao avanca progresso. Ele repete `progress` e `progress_percent` do ponto atual para atualizar `ultimo_sinal_em`, reagendar o guardrail e mostrar ao usuario que o motor esta aguardando o Bubble liberar novas chamadas.

Um webhook final `error` continua sendo terminal: se o motor ainda vai tentar novamente, ele permanece em `processing` e nao envia `error` antes do fim dos retries.

## Correcao De Ordem Terminal

Depois da correcao de heartbeat, revisamos tambem o ponto observado no incidente de 15/09/2026: o motor podia iniciar webhooks `processing` sem bloquear a persistencia e, se a persistencia falhasse logo depois, enviar o webhook final `error` antes desses `processing` pendentes terminarem.

Isso foi corrigido no motor. Antes de enviar qualquer terminal `done` ou `error`, o job agora espera os `processing` ja iniciados terminarem. Assim, para o Bubble, `done` e `error` voltam a ser o ultimo evento observavel daquele job.

Nao ha mudanca obrigatoria no Bubble: continuar ignorando webhooks de jobs/versoes ja encerrados segue correto como protecao defensiva. A diferenca e que o motor nao deve mais produzir progresso depois de um terminal.

## Mensagem Publica De Erro

O motor tambem passou a sanitizar `error_message` antes de enviar para o Bubble. Se o Bubble/Data API ou Cloudflare devolver HTML, esse HTML fica apenas nos logs internos do motor e nao vai mais para a tela.

Para Cloudflare/rate limit, a mensagem publica passa a ser curta:

```text
Bubble limitou temporariamente as chamadas do cronograma. Tente novamente em alguns minutos.
```

Para outro HTML inesperado, a mensagem publica tambem fica curta:

```text
Bubble retornou uma resposta inesperada ao gravar o cronograma.
```

## O Que Observar Nos Logs

Durante rate limit transitorio, podem aparecer logs como:

```text
atividade obra idempotency lookup failed; retrying
```

Na mesma tentativa, o Bubble deve receber a mensagem `Aguardando liberacao do Bubble (tentativa N de M)` com `status: processing`.

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
