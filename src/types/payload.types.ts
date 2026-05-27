export type ActivityType = "Servico" | "Serviço" | "Compra" | "Projeto";
export type NormalizedActivityType = "Serviço" | "Compra" | "Projeto";
export type ScheduleMode = "generate" | "recalculate" | string;
export type PurchaseStage = "AVISO_ORCAMENTO" | "LIMITE_ORCAMENTO" | "LIMITE_COMPRA" | "RECEBIMENTO";

export interface ObraPayload {
  id?: string;
  unique_id?: string;
  "unique id"?: string;
  nome?: string;
  name?: string;
  dataInicio?: string;
  data_inicio?: string;
  startDate?: string;
  [key: string]: unknown;
}

export interface ObraAmbientePayload {
  id?: string;
  unique_id?: string;
  "unique id"?: string;
  nome?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ObraAmbienteProdutoPayload {
  id?: string;
  unique_id?: string;
  ambienteId?: string;
  obraAmbienteId?: string;
  produtoId?: string;
  produtoNome?: string;
  produto?: string;
  ambienteNome?: string;
  quantidade?: number | null;
  [key: string]: unknown;
}

export interface ObraAmbienteItemComposicaoPayload extends ObraAmbienteProdutoPayload {
  "id ambiente item composicao"?: string;
  "id produto composto"?: string;
  "nome produto composto"?: string;
  "categoria produto composto"?: string;
  "tipo categoria produto composto"?: string;
  "quantidade produto composto"?: number | null;
  "unidade medida produto composto"?: string;
  "id produto simples"?: string;
  "nome produto simples"?: string;
}

export interface ActivityPayload {
  id?: string;
  unique_id?: string;
  nome?: string;
  name?: string;
  tipo: ActivityType;
  atividadeServicoAncoraId?: string | null;
  interdependenciasMasterIds?: string[];
  ordem?: number;
  duracao?: number;
  duracaoVariavel?: boolean;
  quantidadeBase?: number | string | null;
  unidadeMedida?: string | null;
  etapaCompra?: string | null;
  peso?: number;
  equipe?: string | null;
  offsetDias?: number;
  [key: string]: unknown;
}

export interface NormalizedActivity extends Omit<ActivityPayload, "tipo" | "quantidadeBase" | "etapaCompra"> {
  id: string;
  nome: string;
  tipo: NormalizedActivityType;
  ordem: number;
  duracao: number;
  duracaoVariavel: boolean;
  quantidadeBase: number | null;
  etapaCompra: PurchaseStage | null;
  peso: number;
  equipe: string | null;
  atividadeServicoAncoraId: string | null;
  interdependenciasMasterIds: string[];
  raw: Record<string, unknown>;
}

export interface SchedulePayload {
  cronograma_unique_id: string;
  versao_cronograma_unique_id?: string;
  versao_cronograma_id?: string;
  versaoCronograma?: string;
  version_id?: string;
  bubble_api_version?: string;
  bubble_version?: string;
  version?: string;
  mode: ScheduleMode;
  dias_trabalho_semana: 5 | 6;
  timezone?: string;
  requested_by?: string;
  reason?: string | null;
  numero?: number | null;
  previous_version_id?: string | null;
  obra_json: ObraPayload[];
  obra_ambiente_json: ObraAmbientePayload[];
  obra_ambiente_produto_json: ObraAmbienteProdutoPayload[];
  obra_ambiente_item_composicao_json?: ObraAmbienteItemComposicaoPayload[];
  atividades_json: ActivityPayload[];
  atividade_obra_json: Record<string, unknown>[];
  events_json: Record<string, unknown>[];
}

export interface NormalizedSchedulePayload extends Omit<SchedulePayload, "atividades_json"> {
  atividades_json: NormalizedActivity[];
}
