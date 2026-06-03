import type { SchedulePayload } from "../src/types/payload.types.js";

export function basePayload(overrides: Partial<SchedulePayload> = {}): SchedulePayload {
  return {
    cronograma_unique_id: "cronograma_test",
    bubble_api_version: "version-test",
    mode: "generate",
    dias_trabalho_semana: 5,
    timezone: "America/Sao_Paulo",
    requested_by: "vitest",
    reason: null,
    numero: 1,
    previous_version_id: null,
    obra_json: [{ id: "obra_1", dataInicio: "2026-05-04" }],
    obra_ambiente_json: [{ id: "amb_1", nome: "Sala" }],
    obra_ambiente_produto_json: [{ id: "oap_1", ambienteId: "amb_1", produtoId: "prod_1", produtoNome: "Piso", quantidade: 12 }],
    atividades_json: [],
    atividade_obra_json: [],
    events_old: [],
    events_json: [],
    ...overrides
  };
}
