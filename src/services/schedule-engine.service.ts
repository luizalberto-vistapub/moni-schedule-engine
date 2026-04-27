import type { NormalizedActivity, NormalizedSchedulePayload, ObraAmbientePayload, ObraAmbienteProdutoPayload } from "../types/payload.types.js";
import type { EngineResult, ScheduleLine } from "../types/schedule.types.js";
import { addBusinessDays, nextBusinessDay, previousBusinessDay } from "./business-days.service.js";
import { differenceInCalendarDays, formatDateOnly, parseDateOnly, weekdayName } from "../utils/dates.js";
import { stableLineId } from "../utils/ids.js";

interface PlacementContext {
  payload: NormalizedSchedulePayload;
  obraStart: Date;
  product: ObraAmbienteProdutoPayload | null;
  ambientesById: Map<string, ObraAmbientePayload>;
  serviceStarts: Map<string, Date>;
  lines: ScheduleLine[];
  teamWeightByDay: Map<string, number>;
  activityDays: Map<string, Set<string>>;
}

function getObraStart(payload: NormalizedSchedulePayload): Date {
  const obra = payload.obra_json[0] || {};
  const rawDate = obra.dataInicio || obra.data_inicio || obra.startDate;
  if (typeof rawDate !== "string" || !rawDate) throw new Error("obra_json[0].dataInicio e obrigatorio");
  return nextBusinessDay(parseDateOnly(rawDate), payload.dias_trabalho_semana);
}

function cloneCountFor(activity: NormalizedActivity, product: ObraAmbienteProdutoPayload | null): number {
  if (!activity.duracaoVariavel) return activity.duracao;
  const quantity = Number(product?.quantidade ?? 0);
  if (!activity.quantidadeBase || quantity <= 0) return activity.duracao;
  return Math.max(1, Math.ceil((activity.duracao * quantity) / activity.quantidadeBase));
}

function getProductName(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product.produtoNome || product.produto || product.produtoId || "") || null;
}

function getAmbienteId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product.ambienteId || product.obraAmbienteId || "") || null;
}

function buildLine(ctx: PlacementContext, activity: NormalizedActivity, date: Date, cloneIndex: number, anchor?: NormalizedActivity): ScheduleLine {
  const dateOnly = formatDateOnly(date);
  const ambienteId = getAmbienteId(ctx.product);
  const ambiente = ambienteId ? ctx.ambientesById.get(ambienteId) : undefined;
  const daysFromStart = differenceInCalendarDays(ctx.obraStart, date) + 1;

  return {
    atividade_obra_id_externo: stableLineId(activity.id, dateOnly, cloneIndex),
    atividadeId: activity.id,
    atividadeNome: activity.nome,
    atividadeTipo: activity.tipo,
    atividadeServicoAncoraId: activity.atividadeServicoAncoraId,
    atividadeServicoAncoraNome: anchor?.nome || null,
    obraAmbienteProdutoId: ctx.product ? String(ctx.product.id || ctx.product.unique_id || "") || null : null,
    produtoId: ctx.product ? String(ctx.product.produtoId || "") || null : null,
    ambienteId,
    data_programada: dateOnly,
    codigo_d: `D${daysFromStart >= 0 ? "+" : ""}${daysFromStart}`,
    dia_semana: weekdayName(date),
    tipo: activity.tipo,
    subtipo_compra: activity.tipo === "Compra" ? activity.etapaCompra : null,
    nome_atividade: activity.nome,
    equipe: activity.equipe,
    peso: activity.peso,
    ambiente: ambiente ? String(ambiente.nome || ambiente.name || ambienteId) : null,
    produto: getProductName(ctx.product),
    ordem: activity.ordem,
    clone_index: cloneIndex,
    anchor_service_name: anchor?.nome || null,
    raw: activity.raw
  };
}

function canPlaceService(ctx: PlacementContext, activity: NormalizedActivity, date: Date): boolean {
  const dateOnly = formatDateOnly(date);
  const currentWeight = ctx.teamWeightByDay.get(dateOnly) || 0;
  const activityDates = ctx.activityDays.get(activity.id) || new Set<string>();
  return currentWeight + activity.peso <= 10 && !activityDates.has(dateOnly);
}

function reserveServiceDate(ctx: PlacementContext, activity: NormalizedActivity, date: Date): void {
  const dateOnly = formatDateOnly(date);
  ctx.teamWeightByDay.set(dateOnly, (ctx.teamWeightByDay.get(dateOnly) || 0) + activity.peso);
  const activityDates = ctx.activityDays.get(activity.id) || new Set<string>();
  activityDates.add(dateOnly);
  ctx.activityDays.set(activity.id, activityDates);
}

function latestDependencyDate(ctx: PlacementContext, service: NormalizedActivity): Date | null {
  let latest: Date | null = null;
  for (const dependencyId of service.interdependenciasMasterIds) {
    const dependencyStart = ctx.serviceStarts.get(dependencyId);
    if (!dependencyStart) continue;
    if (!latest || dependencyStart > latest) latest = dependencyStart;
  }
  return latest;
}

function placeService(ctx: PlacementContext, service: NormalizedActivity): void {
  const dependencyDate = latestDependencyDate(ctx, service);
  let cursor = dependencyDate ? addBusinessDays(dependencyDate, 1, ctx.payload.dias_trabalho_semana) : ctx.obraStart;
  const totalClones = cloneCountFor(service, ctx.product);
  let firstDate: Date | null = null;

  for (let cloneIndex = 1; cloneIndex <= totalClones; cloneIndex += 1) {
    cursor = nextBusinessDay(cursor, ctx.payload.dias_trabalho_semana);
    while (!canPlaceService(ctx, service, cursor)) cursor = addBusinessDays(cursor, 1, ctx.payload.dias_trabalho_semana);
    if (!firstDate) firstDate = cursor;
    ctx.lines.push(buildLine(ctx, service, cursor, cloneIndex));
    reserveServiceDate(ctx, service, cursor);
    cursor = addBusinessDays(cursor, 1, ctx.payload.dias_trabalho_semana);
  }

  if (firstDate) ctx.serviceStarts.set(service.id, firstDate);
}

function placeAnchoredActivities(ctx: PlacementContext, activities: NormalizedActivity[], servicesById: Map<string, NormalizedActivity>): void {
  const ordered = [...activities].sort((a, b) => {
    if (a.atividadeServicoAncoraId === b.atividadeServicoAncoraId && a.tipo !== b.tipo) return a.tipo === "Projeto" ? -1 : 1;
    return a.ordem - b.ordem;
  });
  const anchorCounters = new Map<string, number>();

  for (const activity of ordered) {
    const anchorId = activity.atividadeServicoAncoraId;
    if (!anchorId) continue;
    const anchorStart = ctx.serviceStarts.get(anchorId);
    const anchor = servicesById.get(anchorId);
    if (!anchorStart || !anchor) continue;
    const counterKey = `${anchorId}:${activity.tipo}`;
    const currentCounter = anchorCounters.get(counterKey) || 0;
    const defaultOffset = activity.tipo === "Projeto" ? currentCounter + 2 : currentCounter + 1;
    const offset = Number(activity.offsetDias ?? defaultOffset);
    const date = previousBusinessDay(addBusinessDays(anchorStart, -offset, ctx.payload.dias_trabalho_semana), ctx.payload.dias_trabalho_semana);
    ctx.lines.push(buildLine(ctx, activity, date, 1, anchor));
    anchorCounters.set(counterKey, currentCounter + 1);
  }
}

export function runScheduleEngine(payload: NormalizedSchedulePayload): EngineResult {
  const obraStart = getObraStart(payload);
  const product = payload.obra_ambiente_produto_json[0] || null;
  const ambientesById = new Map(payload.obra_ambiente_json.map((ambiente) => [String(ambiente.id || ambiente.unique_id || ""), ambiente]));
  const services = payload.atividades_json.filter((activity) => activity.tipo === "Servi\u00e7o").sort((a, b) => a.ordem - b.ordem);
  const anchored = payload.atividades_json.filter((activity) => activity.tipo === "Projeto" || activity.tipo === "Compra");
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const ctx: PlacementContext = {
    payload,
    obraStart,
    product,
    ambientesById,
    serviceStarts: new Map(),
    lines: [],
    teamWeightByDay: new Map(),
    activityDays: new Map()
  };

  for (const service of services) placeService(ctx, service);
  placeAnchoredActivities(ctx, anchored, servicesById);
  ctx.lines.sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);

  return { lines: ctx.lines, validations: { warnings: [], errors: [] } };
}