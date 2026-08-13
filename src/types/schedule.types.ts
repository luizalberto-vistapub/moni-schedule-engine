import type { NormalizedActivityType } from "./payload.types.js";

export interface ScheduleLine {
  atividade_obra_id_externo: string;
  atividadeId: string;
  atividadeNome: string;
  atividadeTipo: NormalizedActivityType;
  atividadeServicoAncoraId: string | null;
  atividadeServicoAncoraNome: string | null;
  atividadeServicoAncoraExternoId: string | null;
  obraAmbienteProdutoId: string | null;
  produtoId: string | null;
  ambienteId: string | null;
  ambienteItemComposicaoId: string | null;
  external_index: number;
  data_programada: string;
  codigo_d: string;
  dia_semana: string;
  tipo: NormalizedActivityType;
  subtipo_compra: string | null;
  nome_atividade: string;
  equipe: string | null;
  familia: string | null;
  nomeFamilia: string | null;
  projetoId: string | null;
  tipoProjeto: string | null;
  diasAntecedencia: number | null;
  projetoResponsavel: string | null;
  projetoStatus: string | null;
  peso: number;
  ambiente: string | null;
  produto: string | null;
  ordem: number;
  ordemCronograma: number;
  clone_index: number;
  anchor_service_name: string | null;
  interdependenciasMasterIds: string[];
  raw: Record<string, unknown>;
}

export interface EngineResult {
  lines: ScheduleLine[];
  validations: {
    warnings: string[];
    errors: string[];
  };
}
