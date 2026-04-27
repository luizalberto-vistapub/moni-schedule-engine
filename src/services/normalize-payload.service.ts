import { z } from "zod";
import type { ActivityPayload, NormalizedActivity, NormalizedSchedulePayload, PurchaseStage, SchedulePayload } from "../types/payload.types.js";

const recordArray = z.array(z.record(z.unknown())).default([]);

export const payloadSchema = z.object({
  cronograma_unique_id: z.string().min(1),
  mode: z.string().default("generate"),
  dias_trabalho_semana: z.union([z.literal(5), z.literal(6)]).default(5),
  timezone: z.string().optional(),
  requested_by: z.string().optional(),
  reason: z.string().nullable().optional(),
  numero: z.number().nullable().optional(),
  previous_version_id: z.string().nullable().optional(),
  obra_json: z.array(z.record(z.unknown())).min(1),
  obra_ambiente_json: recordArray,
  obra_ambiente_produto_json: recordArray,
  atividades_json: z.array(z.record(z.unknown())).default([]),
  atividade_obra_json: recordArray,
  events_json: recordArray
}) as unknown as z.ZodType<SchedulePayload>;

function normalizeActivityType(value: unknown): NormalizedActivity["tipo"] {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (text === "servico") return "Servi\u00e7o";
  if (text === "compra") return "Compra";
  if (text === "projeto") return "Projeto";
  throw new Error(`Tipo de atividade invalido: ${String(value)}`);
}

function normalizeQuantityBase(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizePurchaseStage(value: unknown): PurchaseStage | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const aliases: Record<string, PurchaseStage> = {
    AVISO_ORCAMENTO: "AVISO_ORCAMENTO",
    AVISO_DE_ORCAMENTO: "AVISO_ORCAMENTO",
    LIMITE_ORCAMENTO: "LIMITE_ORCAMENTO",
    LIMITE_DE_ORCAMENTO: "LIMITE_ORCAMENTO",
    LIMITE_COMPRA: "LIMITE_COMPRA",
    LIMITE_DE_COMPRA: "LIMITE_COMPRA",
    RECEBIMENTO: "RECEBIMENTO"
  };

  return aliases[normalized] || null;
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function field(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeActivity(activity: ActivityPayload, index: number): NormalizedActivity {
  const id = asString(field(activity, "id", "unique_id", "unique id"), `atividade_${index + 1}`);
  const nome = asString(activity.nome || activity.name, id);
  const rawOffset = activity.offsetDias ?? field(activity, "diasAntecedencia");
  const rawEquipe = activity.equipe || field(activity, "tipo equipe");

  return {
    ...activity,
    id,
    nome,
    tipo: normalizeActivityType(activity.tipo),
    ordem: Number(activity.ordem ?? index + 1),
    duracao: Math.max(1, Math.ceil(Number(activity.duracao ?? 1))),
    duracaoVariavel: Boolean(activity.duracaoVariavel),
    quantidadeBase: normalizeQuantityBase(activity.quantidadeBase),
    etapaCompra: normalizePurchaseStage(activity.etapaCompra),
    peso: Number(activity.peso ?? 1),
    equipe: typeof rawEquipe === "string" && rawEquipe ? rawEquipe : null,
    atividadeServicoAncoraId: activity.atividadeServicoAncoraId || null,
    interdependenciasMasterIds: Array.isArray(activity.interdependenciasMasterIds) ? activity.interdependenciasMasterIds : [],
    offsetDias: rawOffset === undefined || rawOffset === null || rawOffset === "" ? undefined : Number(rawOffset),
    raw: { ...activity }
  };
}

export function normalizePayload(payload: SchedulePayload): NormalizedSchedulePayload {
  return {
    ...payload,
    atividades_json: payload.atividades_json.map(normalizeActivity)
  };
}
