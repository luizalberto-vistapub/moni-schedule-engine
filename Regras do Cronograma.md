# Regras do Cronograma

Este documento descreve as regras de negócio observáveis do `moni-schedule-engine`. Ele deve servir como especificação para replicação do motor e criação de testes de conformidade em outro projeto.

## 1. Escopo

O motor recebe dados de obra, ambientes, produtos, atividades, dependências e eventos. Ele:

1. normaliza o payload recebido do Bubble;
2. gera ou recalcula as linhas do cronograma;
3. posiciona serviços, compras e projetos;
4. garante dias úteis, dependências, capacidade e sequência de clones;
5. persiste criações ou alterações no Bubble;
6. comunica progresso e resultado por webhook.

Os endpoints de geração e recálculo respondem com `202 Accepted`. O processamento e a persistência são assíncronos e identificados por `job_id`.

## 2. Contrato de entrada

### 2.1 Identificação

- `cronograma_unique_id`: identifica o cronograma.
- `versao_cronograma_unique_id`: identifica a nova versão.
- `previous_version_id`: identifica a versão anterior em recálculos.
- Em recálculo, a nova versão deve ser diferente da versão anterior, exceto nos contratos específicos do motor delta.

### 2.2 Campos estruturais

Os principais conjuntos de dados são:

- `obra_json`;
- `obra_ambiente_json`;
- `obra_ambiente_produto_json`;
- `obra_ambiente_item_composicao_json`;
- `atividades_json`;
- `atividade_obra_json`;
- `atividade_obra_snapshot`;
- `master_dependencies`;
- `master_anchors`;
- `events_old`;
- `events_json`.

### 2.3 Aliases aceitos

O normalizador aceita aliases usados pelo Bubble. Exemplos:

- início da obra: `dataInicio`, `data_inicio`, `startDate`;
- versão do Bubble: `bubble_api_version`, `bubble_version`, `version`;
- versão do cronograma: `versao_cronograma_unique_id`, `versao_cronograma_id`, `versaoCronograma`, `version_id`.

## 3. Normalização

### 3.1 Tipos de atividade

Os tipos são convertidos para o conjunto canônico:

- `Serviço`;
- `Compra`;
- `Projeto`.

Variações sem acento e diferenças de caixa são aceitas na entrada.

### 3.2 Etapas de compra

As etapas são convertidas para:

- `AVISO_ORCAMENTO`;
- `LIMITE_ORCAMENTO`;
- `LIMITE_COMPRA`;
- `RECEBIMENTO`.

### 3.3 Produtos de composição

Quando `obra_ambiente_produto_json` está vazio, o normalizador pode derivar os produtos de `obra_ambiente_item_composicao_json`.

### 3.4 Projetos derivados

Uma referência `atividadeProjeto` em um serviço pode gerar uma atividade do tipo `Projeto`. Projetos explícitos e derivados são combinados sem duplicar a mesma relação.

## 4. Calendário de trabalho

### 4.1 Semana de cinco dias

Com `dias_trabalho_semana = 5`:

- segunda a sexta são dias úteis;
- sábado e domingo não são dias úteis.

### 4.2 Semana de seis dias

Com `dias_trabalho_semana = 6`:

- segunda a sábado são dias úteis;
- domingo não é dia útil.

### 4.3 Normalização de datas

- Uma data calculada em dia não útil é movida para o próximo dia útil.
- A data inicial da obra também é normalizada.
- O calendário atual não contém uma lista de feriados. Um feriado que caia em um dia permitido da semana é tratado como dia útil.

## 5. Identidade das linhas

O identificador externo estável usa o formato:

```text
{atividadeId}|{contextoExterno}|{indice}
```

O contexto externo normalmente representa o ambiente da obra ou outro contexto de produto/ambiente usado na geração.

Identificadores legados no formato abaixo continuam aceitos em snapshots e eventos:

```text
{atividadeId}_{YYYY-MM-DD}_{indice}
```

Datas não devem ser usadas como identidade em novas implementações.

## 6. Geração dos serviços

Serviços formam o eixo principal do cronograma.

### 6.1 Ordenação

O posicionamento considera, nesta ordem lógica:

- `ordem`;
- dependências;
- equipe e capacidade disponível;
- data de criação e identificador como desempates determinísticos.

Atividades de uma ordem posterior só começam depois do término da ordem anterior.

### 6.2 Dependências

- Um serviço dependente começa no mínimo no primeiro dia útil após o último clone da dependência mais tardia.
- Dependências dentro da mesma ordem também devem ser respeitadas.
- Os vínculos persistidos apontam para todas as linhas geradas das atividades predecessoras.

### 6.3 Capacidade diária

- A capacidade é controlada por equipe e data.
- A soma de `peso` de uma equipe em um dia não pode ultrapassar `10`.
- Quando não há capacidade, a linha é movida para o próximo dia útil disponível.

### 6.4 Duração

Para duração fixa:

```text
quantidade de clones = duração
```

Para duração variável, quando quantidade e base são válidas:

```text
quantidade de clones = ceil(duração * quantidade / quantidadeBase)
```

O mínimo é um clone.

## 7. Regra de sequência dos clones

Esta regra é obrigatória tanto na geração quanto no recálculo.

### 7.1 Invariantes

Para uma mesma instância de atividade, identificada por `atividade + contexto externo`:

1. os clones são avaliados pela ordem crescente do índice;
2. cada clone móvel deve cair em um dia útil;
3. a data de um clone deve ser estritamente posterior à data do clone anterior;
4. dois clones da mesma instância nunca podem ocupar a mesma data;
5. uma atividade com duração `N` deve ocupar `N` dias úteis distintos, salvo linhas imutáveis já executadas que não possam ser corrigidas;
6. ao mover um clone para frente, todos os clones móveis subsequentes que colidirem também são empurrados.

Exemplo para uma obra de cinco dias por semana:

```text
Entrada incorreta: 17/09, 18/09, 21/09, 21/09, 21/09, 24/09, 25/09
Saída corrigida:   17/09, 18/09, 21/09, 22/09, 23/09, 24/09, 25/09
```

### 7.2 Algoritmo de conformidade

Para cada grupo `atividade|contexto`:

1. ordenar as linhas pelo índice do clone;
2. normalizar a data do clone atual para o próximo dia útil;
3. se essa data for igual ou anterior à data já ocupada pelo clone anterior, usar o primeiro dia útil posterior ao clone anterior;
4. verificar se `peso já reservado da equipe + peso do clone <= 10`;
5. se a capacidade for excedida, avançar por dias úteis até encontrar capacidade;
6. reservar imediatamente o peso do clone na data escolhida;
7. continuar o processo até o último clone;
8. persistir apenas as linhas cuja data realmente mudou.

Antes de reposicionar um grupo, as reservas de peso de seus clones móveis são removidas das datas antigas. Reservas de outras atividades e linhas imutáveis permanecem ocupando capacidade, evitando que a correção de sequência crie uma sobrecarga de equipe.

### 7.3 Isolamento entre ambientes

- A comparação não é feita apenas por `atividadeId`.
- O prefixo `atividade|contexto` faz parte da chave do grupo.
- A mesma atividade e o mesmo produto podem existir em ambientes diferentes sem compartilhar o cursor de datas.
- Corrigir clones em um ambiente não deve deslocar clones válidos de outro ambiente.

### 7.4 Linhas imutáveis

Em recálculo por snapshot, somente linhas com estado móvel podem ser alteradas. Em geral, são móveis linhas sem status, `Não iniciada` ou `Recalculada`.

Linhas concluídas, iniciadas, pausadas ou usadas como âncoras de um escopo delta permanecem imutáveis. Uma linha imutável ainda funciona como limite cronológico para clones móveis posteriores.

### 7.5 Diagnóstico

Alterações automáticas são informadas em `normalizedDates`:

- `non_working_day`: a data solicitada ou calculada caiu em dia não útil;
- `clone_sequence_collision`: a data já estava ocupada por clone anterior ou quebrava a ordem crescente;
- `team_capacity`: a soma dos pesos da equipe ultrapassaria `10` na data candidata.

## 8. Compras

Compras são posicionadas para trás a partir do serviço âncora.

### 8.1 Resolução da âncora

A resolução considera:

1. serviço explicitamente informado;
2. produto simples ou composto relacionado ao serviço;
3. contexto de produto e ambiente;
4. primeiro serviço aplicável como fallback determinístico.

### 8.2 Cadeia de etapas

A ordem canônica é:

1. aviso de orçamento;
2. limite de orçamento;
3. limite de compra;
4. recebimento.

Quando há duplicidade para o mesmo produto e etapa, prevalece o registro mais antigo por data de criação e, em empate, por identificador.

### 8.3 Antecedência

A data é calculada subtraindo `diasAntecedencia` ou o offset equivalente da data do serviço âncora e ajustando para dia útil quando aplicável.

## 9. Projetos

- Projetos também são posicionados para trás a partir do serviço âncora.
- `diasAntecedencia` define o afastamento em relação ao serviço.
- Responsável, tipo e status do projeto são preservados quando fornecidos.

## 10. Recálculo

### 10.1 Eventos ativos

Quando `events_json` é enviado, ele representa os eventos ativos da requisição e prevalece sobre `events_old` para o processamento atual.

Tipos reconhecidos incluem:

- `work_start_delayed`;
- `from_date_delayed`;
- `activity_start_delayed`;
- `activity_date_changed_cascade`;
- `activity_date_changed_only`;
- `activity_inserted`.

### 10.2 Recálculo da obra para a mesma data

É permitido enviar `work_start_delayed` com `new_start_date` igual à data atual em `obra_json[0].dataInicio`.

Nesse caso:

- a requisição não é recusada por igualdade de datas;
- o deslocamento da obra é zero;
- as linhas não são movidas apenas por causa do evento;
- todas as validações e regras finais de conformidade continuam executando;
- colisões de clones e datas não úteis existentes são corrigidas;
- somente linhas que precisarem de correção geram `PATCH`.

Esse comportamento permite um recálculo de manutenção depois da publicação de uma nova regra de negócio.

O contrato ainda exige:

- `obra_json[0].dataInicio` explícita no recálculo por snapshot;
- `new_start_date` no evento;
- nova versão e versão anterior válidas e diferentes;
- snapshot quando `estrutura_inalterada = true`.

### 10.3 Mudança somente da atividade

`activity_date_changed_only` altera apenas a linha identificada pelo evento. Não deve deslocar dependentes.

### 10.4 Mudança com cascata

`activity_date_changed_cascade` altera a linha alvo, clones posteriores aplicáveis e atividades dependentes, respeitando mobilidade, dependências e normalização final.

### 10.5 Paralisação a partir de uma data

`from_date_delayed`:

- preserva linhas anteriores à data de corte;
- adiciona os dias informados às linhas afetadas;
- normaliza o resultado para dias úteis;
- mantém a ordem dos eventos quando vários eventos são processados.

### 10.6 Atraso de compra

`activity_start_delayed` em uma compra pode deslocar as etapas posteriores da mesma cadeia e os serviços dependentes, conforme a data de corte.

### 10.7 Inserção

`activity_inserted` registra o evento, mas o Bubble deve enviar a estrutura final com a atividade e suas dependências. Não existe inserção estrutural automática no motor de snapshot inalterado.

## 11. Snapshot e mobilidade

Com `payload_version = 2`, `mode = recalculate` e `estrutura_inalterada = true`:

- `atividade_obra_snapshot` é a fonte das linhas existentes;
- as linhas não são recriadas;
- somente datas alteradas são persistidas;
- campos hidratados do Bubble são preservados;
- a regra de sequência dos clones é aplicada retroativamente ao snapshot inteiro.

O snapshot deve conter, para cada linha:

- Bubble unique id;
- `id_atividade_obra_externo`;
- atividade;
- data prevista;
- status e contexto suficientes para decidir mobilidade e agrupamento.

## 12. Motor delta

No contrato delta do `payload_version = 3`:

- o estado base é reconstruído;
- a quantidade esperada de linhas é validada;
- divergências podem gerar `BASE_STATE_INVALID` ou `STATE_DRIFT`;
- somente diferenças de data são persistidas;
- âncoras do escopo não podem ser movidas;
- um escopo insuficiente deve ser recusado em vez de produzir um resultado parcial incorreto.

## 13. Persistência no Bubble

- Geração completa cria registros em bulk e depois resolve vínculos dependentes.
- Recálculo por snapshot envia `PATCH` apenas para linhas alteradas.
- Registros são deduplicados pelo identificador externo.
- Dependências e vínculos master são atualizados depois que os ids Bubble são conhecidos.
- Eventos ativos são persistidos com os nomes de opção esperados pelo Bubble.

## 14. Webhooks

O fluxo normal comunica:

- `processing`, com etapa e percentual;
- `done`, com métricas e `normalizedDates`;
- `error`, com código, mensagem, detalhes e etapa que falhou.

O webhook terminal pode ser repetido em falhas transitórias.

## 15. Matriz mínima de testes de conformidade

Uma implementação compatível deve testar pelo menos:

1. semana de cinco dias pulando sábado e domingo;
2. semana de seis dias aceitando sábado e pulando domingo;
3. duração fixa;
4. duração variável com arredondamento para cima;
5. clones consecutivos atravessando fim de semana;
6. reparo retroativo de clones duplicados em uma segunda-feira;
7. datas estritamente crescentes por índice;
8. isolamento da mesma atividade e produto entre ambientes diferentes;
9. capacidade máxima `10` por equipe e dia;
10. dependência liberada após o último clone do predecessor;
11. ordem posterior iniciando após a anterior;
12. compras posicionadas antes do serviço âncora;
13. ordem das etapas de compra;
14. desempate de compras duplicadas;
15. projetos posicionados pela antecedência;
16. recálculo por snapshot alterando somente datas diferentes;
17. respeito a status imutáveis;
18. respeito a âncoras de escopo;
19. `events_json` prevalecendo sobre eventos antigos;
20. múltiplos eventos processados em ordem;
21. recálculo de início da obra com delta positivo;
22. recálculo de início da obra com a mesma data corrigindo inconsistências sem deslocar linhas válidas;
23. persistência apenas dos clones efetivamente corrigidos;
24. diagnóstico `non_working_day`;
25. diagnóstico `clone_sequence_collision`;
26. clone normalizado avançando novamente quando a equipe excederia peso `10`;
27. diagnóstico `team_capacity`;
28. rejeição de nova versão igual à anterior;
29. rejeição de snapshot incompleto;
30. detecção de estado divergente no motor delta.

## 16. Invariantes finais

Para considerar um resultado válido:

- toda linha móvel está em dia útil;
- clones da mesma instância estão em datas distintas e estritamente crescentes;
- ambientes diferentes não interferem entre si na verificação de clones;
- dependências apontam para linhas existentes;
- capacidade de equipe não é excedida;
- compras e projetos mantêm suas âncoras;
- linhas imutáveis não são alteradas;
- um recálculo com a mesma data pode ser usado para aplicar novas regras de conformidade ao snapshot existente.
