import { z } from "zod";
import type { ActivityPayload, NormalizedActivity, NormalizedSchedulePayload, ObraAmbienteItemComposicaoPayload, ObraAmbienteProdutoPayload, PurchaseStage, SchedulePayload } from "../types/payload.types.js";

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
  obra_ambiente_item_composicao_json: recordArray,
  atividades_json: z.array(z.record(z.unknown())).default([]),
  atividade_obra_json: recordArray,
  events_old: recordArray,
  events_json: recordArray
}).passthrough() as unknown as z.ZodType<SchedulePayload>;

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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
  const tipo = normalizeActivityType(activity.tipo);
  const rawOffset = activity.offsetDias ?? field(activity, "diasAntecedencia");
  const rawEquipe = activity.equipe || field(activity, "tipo equipe");

  return {
    ...activity,
    id,
    nome,
    tipo,
    ordem: Number(activity.ordem ?? index + 1),
    duracao: Math.max(1, Math.ceil(Number(activity.duracao ?? 1))),
    duracaoVariavel: Boolean(activity.duracaoVariavel),
    quantidadeBase: normalizeQuantityBase(activity.quantidadeBase),
    etapaCompra: normalizePurchaseStage(activity.etapaCompra),
    peso: Number(activity.peso ?? 1),
    equipe: typeof rawEquipe === "string" && rawEquipe ? rawEquipe : null,
    atividadeServicoAncoraId: tipo === "Compra" ? activity.atividadeServicoAncoraId || null : null,
    interdependenciasMasterIds: Array.isArray(activity.interdependenciasMasterIds) ? activity.interdependenciasMasterIds : [],
    offsetDias: rawOffset === undefined || rawOffset === null || rawOffset === "" ? undefined : Number(rawOffset),
    raw: { ...activity }
  };
}

function normalizeActivityProjects(activity: NormalizedActivity): NormalizedActivity[] {
  if (activity.tipo !== "Servi\u00e7o" || !Array.isArray(activity.raw.atividadeProjeto)) return [];

  return activity.raw.atividadeProjeto
    .filter((project): project is Record<string, unknown> => typeof project === "object" && project !== null)
    .map((project, index): NormalizedActivity => {
      const id = asString(field(project, "idAtividadeProjeto", "id", "unique_id", "unique id"), `${activity.id}_projeto_${index + 1}`);
      const nome = asString(field(project, "nomeAtividadeProjeto", "nome", "name"), id);

      return {
        id,
        nome,
        tipo: "Projeto",
        ordem: activity.ordem,
        duracao: 1,
        duracaoVariavel: false,
        quantidadeBase: null,
        etapaCompra: null,
        peso: 1,
        equipe: null,
        offsetDias: project.diasAntecedencia === undefined || project.diasAntecedencia === null || project.diasAntecedencia === "" ? undefined : Number(project.diasAntecedencia),
        atividadeServicoAncoraId: activity.id,
        interdependenciasMasterIds: [],
        produto: activity.produto,
        produtoId: activity.produtoId,
        raw: { ...project, sourceActivityId: activity.id }
      };
    });
}

function mergeDirectProjectWithReference(directProject: NormalizedActivity, linkedProject: NormalizedActivity): NormalizedActivity {
  return {
    ...directProject,
    ordem: linkedProject.ordem,
    offsetDias: linkedProject.offsetDias ?? directProject.offsetDias,
    atividadeServicoAncoraId: linkedProject.atividadeServicoAncoraId,
    produto: directProject.produto || linkedProject.produto,
    produtoId: directProject.produtoId || linkedProject.produtoId,
    raw: {
      ...directProject.raw,
      atividadeProjetoLink: linkedProject.raw,
      sourceActivityId: linkedProject.atividadeServicoAncoraId
    }
  };
}

function normalizeCompositionProduct(product: ObraAmbienteItemComposicaoPayload): ObraAmbienteProdutoPayload {
  const id = optionalString(product.id) || optionalString(product.unique_id) || optionalString(product["unique id"]);
  const ambienteId = optionalString(product.ambienteId)
    || optionalString(product.obraAmbienteId)
    || optionalString(product["ambiente x obra"])
    || optionalString(product["id ambiente item composicao"]);
  const produtoId = optionalString(product.produtoId) || optionalString(product.produto) || optionalString(product["id produto simples"]);
  const produtoNome = optionalString(product.produtoNome) || optionalString(product["nome produto"]) || optionalString(product["nome produto simples"]);

  return {
    ...product,
    id,
    unique_id: optionalString(product.unique_id) || optionalString(product["unique id"]),
    ambienteId,
    obraAmbienteId: ambienteId,
    produtoId,
    produto: produtoId,
    produtoNome,
    quantidade: product.quantidade ?? product["quantidade produto composto"] ?? null
  };
}

export function normalizePayload(payload: SchedulePayload): NormalizedSchedulePayload {
  const compositionProducts = payload.obra_ambiente_item_composicao_json || [];
  const obraAmbienteProdutos = payload.obra_ambiente_produto_json.length
    ? payload.obra_ambiente_produto_json
    : compositionProducts.map(normalizeCompositionProduct);
  const activities = payload.atividades_json.map(normalizeActivity);
  const directActivitiesById = new Map(activities.map((activity) => [activity.id, activity]));
  const linkedProjectKeys = new Set<string>();
  const linkedProjectIds = new Set<string>();
  const projectActivities = activities
    .flatMap(normalizeActivityProjects)
    .flatMap((linkedProject) => {
      const directActivity = directActivitiesById.get(linkedProject.id);
      if (directActivity && directActivity.tipo !== "Projeto") return [];
      const project = directActivity ? mergeDirectProjectWithReference(directActivity, linkedProject) : linkedProject;
      const key = `${project.id}:${project.atividadeServicoAncoraId}`;
      if (linkedProjectKeys.has(key)) return [];
      linkedProjectKeys.add(key);
      linkedProjectIds.add(project.id);
      return [project];
    });
  const baseActivities = activities.filter((activity) => activity.tipo !== "Projeto" || !linkedProjectIds.has(activity.id));

  return {
    ...payload,
    obra_ambiente_produto_json: obraAmbienteProdutos,
    obra_ambiente_item_composicao_json: compositionProducts,
    atividades_json: [...baseActivities, ...projectActivities]
  };
}
