# Contrato de webhooks que o Bubble esta configurado a receber

**App:** `moni-29694` - **Branch:** `test` - **Backend workflow:** `api_cronograma__webhook_v1`
**Metodo:** `POST` - **Autenticacao:** admin - **Data:** 13/09/2026

Este documento lista exatamente o que o Bubble aceita hoje e o que ele faz com cada campo,
para alinhar com o time do motor o que falta para as 4 etapas funcionarem na tela.

---

## 1. Campos aceitos

| Campo                          | Tipo   | Uso no Bubble                                                                                              |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| `job_id`                       | texto  | **Obrigatorio.** Identifica a versao. Chamada sem ele e descartada.                                        |
| `status`                       | texto  | Roteia o webhook. Ver secao 2.                                                                             |
| `progress`                     | numero | Grava o numero da etapa. E o "Etapa N" da tela.                                                            |
| `progress_percent`             | numero | Grava o percentual. E o "N%" da tela.                                                                      |
| `message`                      | texto  | Grava a linha de mensagem abaixo do percentual.                                                            |
| `cronograma_unique_id`         | texto  | Aceito.                                                                                                    |
| `versao_cronograma_unique_id`  | texto  | Aceito.                                                                                                    |
| `previous_version_id`          | texto  | Gravado na auditoria (`resposta_json`).                                                                    |
| `metrics.linesCount`           | numero | Linhas esperadas.                                                                                          |
| `metrics.durationMs`           | numero | Auditoria.                                                                                                 |
| `metrics.patchedCount`         | numero | Linhas alteradas.                                                                                          |
| `metrics.eventCount`           | numero | Eventos persistidos.                                                                                       |
| `metrics.dependencyPatchCount` | numero | Dependencias alteradas.                                                                                    |
| `metrics.patchRequestCount`    | numero | Auditoria (tolera ausencia, assume 0).                                                                     |
| `metrics.patchBatchCount`      | numero | Auditoria (tolera ausencia, assume 0).                                                                     |
| `normalizedDates[]`            | lista  | `id_atividade_obra_externo`, `requested`, `applied`, `reason`. Vira o aviso "Data ajustada para dia util". |
| `error_code`                   | texto  | Mensagem de erro na tela.                                                                                  |
| `error_message`                | texto  | Mensagem de erro na tela.                                                                                  |
| `failed_step`                  | texto  | Mensagem de erro na tela.                                                                                  |

---

## 2. Comportamento por `status`

### `status: "processing"` - unico webhook que move a tela

1. Grava `progress`, `progress_percent` e `message` na versao.
2. Cancela o guardrail atual e reagenda para **600 s a partir deste webhook**.
3. Encerra. Nao conclui a versao.

### `status: "done"`

1. Cancela o guardrail.
2. Conclui a versao: `ATIVA` quando o motivo e `payload_v2: false`; `PERSISTIDO` no caminho in-place.
3. Grava metricas, `retorno: "true"` e **forca `progress: 4` / `progress_percent: 100`**.
4. Libera a tela - o carregamento fecha praticamente no mesmo instante.

### Qualquer outro `status`

1. Marca a versao como `ERRO` com `error_code`, `error_message` e `failed_step`.
2. Grava `progress` e `progress_percent` **como vieram no webhook**.
3. Libera a tela e abre o popup de falha.

### Chamadas descartadas

- `job_id` vazio;
- versao ja em `ATIVA`, `SUPERADA`, `MONTANDO_PAYLOAD` ou `PERSISTIDO`;
- versao em `ERRO` com `status` diferente de `done`.

---

## 3. O que o motor emite hoje

Medido nos logs do dia 12/09 (obra FK0002, branch `test`).

| Etapa | Webhooks observados                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------- |
| 1     | **nenhum**                                                                                                |
| 2     | `0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100` - `message: "Atualizando datas recalculadas"`, a cada ~50 s |
| 3     | **nenhum**                                                                                                |
| 4     | **nenhum** (o `4 / 100%` do `done` e escrito pelo proprio Bubble)                                         |

Execucao completa de 12/09:

```yaml
09:38:47  clique no botao vermelho      -> tela mostra "Etapa 1 de 4   0%"
                                          (4 min 06 s sem nenhum webhook)
09:42:54  etapa 2     0%   Atualizando datas recalculadas
09:43:47  etapa 2    10%
09:44:45  etapa 2    20%
...
09:51:19  etapa 2   100%
          done -> Bubble grava 4/100% e fecha a tela no mesmo instante
```

**Consequencia na tela:** etapa 1 fica parada em 0% por minutos, nunca chega a 100%,
e a etapa 2 aparece do zero. As etapas 3 e 4 nunca sao vistas.

---

## 4. O que pedir ao motor

1. **Quais sao as etapas 1 a 4** na definicao do motor, e qual `message` corresponde a cada uma.
   O Bubble mostra "Etapa N de 4" literalmente a partir de `progress`.
2. **Emitir `progress` das etapas 1, 3 e 4.** Hoje so a 2 existe.
3. **Fechar cada etapa em 100% antes de abrir a proxima em 0%.** Sequencia desejada:
   `1 0% -> 1 100% -> 2 0% -> ... -> 2 100% -> 3 0% -> ...`
4. **Progresso por tempo decorrido tambem na etapa 1** (ja e a pendencia 8.1.3 do handoff).
   Alem da percepcao, ha um risco real: o guardrail encerra a execucao **600 s** apos o ultimo
   webhook de progresso, e o silencio medido na etapa 1 ja foi de 4 min 06 s - **41% do orcamento**.
5. Confirmar se `message` pode vir em toda emissao. Hoje ela so chega na etapa 2.

---

## 5. Pendencia do lado Bubble (depende da resposta acima)

- `api_cronograma__gerar_v1` limpa `progress_mensagem` logo depois de o clique gravar
  "Enviando o recalculo ao motor". Resultado: durante toda a etapa 1 a tela fica **sem mensagem
  nenhuma**, so o "Etapa 1 de 4   0%" congelado. Corrigir junto com o desenho final do progresso.
- Definir se o texto continua como "Etapa N de 4" ou vira um percentual unico do processo.

---

## 6. Atualizacao do motor apos logs de 13/09

Decisao aplicada: o motor mantem as 4 etapas como **marcos de UI**, nao como quatro blocos
proporcionais de trabalho. Pelos logs reais, quase todo o tempo pesado continua na etapa 2
(`Atualizando datas recalculadas`). As etapas 1, 3 e 4 devem ser exibidas como transicoes de
estado, nao como fases longas.

### Ordem garantida

Os marcos de etapa agora sao enviados de forma serial pelo motor. O Bubble deve receber e aplicar
esta ordem:

```yaml
1 0%    Calculando cronograma
1 100%  Calculando cronograma
2 0%    Atualizando datas recalculadas | Criando registros em bulk
2 10%   Atualizando datas recalculadas | Criando registros em bulk
...
2 90%   Atualizando datas recalculadas | Criando registros em bulk
2 100%  Atualizando datas recalculadas | Criando registros em bulk
3 100%  Atualizando vinculos/dependencias
4 0%    Finalizando cronograma
done    Bubble grava 4/100% e fecha a tela
```

### Contagem esperada de webhooks

Decisao aplicada: manter a etapa 2 de **10% em 10%**.

Motivo:

- nos logs reais, 10% em 10% gerou uma atualizacao percebida a cada ~10 s em uma execucao de
  ~105 s, que e uma cadencia boa para feedback visual;
- 5% em 5% dobraria o numero de webhooks/acoes Bubble sem ganho proporcional claro;
- 2% em 2% multiplicaria o custo operacional por 5 e voltaria a criar ruido parecido com o
  problema de duplicacao;
- o guardrail de 600 s continua protegido por avancos reais e por uma renovacao rara quando o
  percentual fica parado por muito tempo.

Para um recalculo pesado que avanca normalmente de 10 em 10%, o esperado passa a ser:

- **15 webhooks `processing`**:
  - 2 da etapa 1 (`0%`, `100%`);
  - 11 da etapa 2 (`0%`, `10%`, ..., `100%`);
  - 1 da etapa 3 (`100%`);
  - 1 da etapa 4 (`0%`);
- 1 webhook terminal `done`.

Observacao: pode haver um reenvio do mesmo percentual apenas como renovacao rara de guardrail
em operacoes extremamente paradas. O motor nao deve mais reenviar o mesmo percentual a cada
heartbeat curto.

### Como aplicar na UI do Bubble

- Manter "Etapa N de 4" se a tela quiser mostrar macroestado.
- Tratar etapas 1, 3 e 4 como **marcos rapidos**; elas podem aparecer brevemente.
- Nao esperar que etapa 1, 3 ou 4 tenham duracao proporcional ao tempo total.
- Usar a etapa 2 como a barra realmente longa quando o job esta persistindo datas/registros.
- Continuar fechando a tela somente no `done`; `processing 4/0%` e apenas a entrada em finalizacao.
