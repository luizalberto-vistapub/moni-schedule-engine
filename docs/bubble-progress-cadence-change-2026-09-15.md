# Aviso Para Bubble - Cadencia De Progresso Do Cronograma

## O Que Mudou

O Servidor de Cronograma passa a enviar webhooks `processing` mais cedo durante as etapas longas de persistencia:

```yaml
Etapa 2: 0%, 1%, 3%, 5%, 10%, 15%, ... 100%
Etapa 3: 1%, 3%, 5%, 10%, 15%, ... 100% quando houver muitos vinculos/dependencias
```

Antes, as etapas longas avancavam de 10% em 10%. Em obras grandes, isso podia deixar a tela muito tempo sem novo sinal de vida.

## O Que Nao Muda

- O webhook continua usando `status: "processing"`.
- O Bubble pode continuar exibindo exatamente o `progress_percent` que chegar.
- O encerramento do fluxo continua dependendo apenas do webhook final `status: "done"` ou `status: "error"`.
- O webhook final de sucesso continua sendo `progress: 4` e `progress_percent: 100`.
- Webhooks intermediarios continuam sendo apenas feedback visual; eles nao devem ativar a versao nem encerrar a tela.

## Ajuste Esperado No Bubble

Nenhum ajuste obrigatorio, desde que a tela ja use o valor recebido em `progress_percent`.

Se houver alguma regra fixa esperando somente multiplos de 10, remover essa restricao para aceitar tambem `1`, `3`, `5` e multiplos de `5`.
