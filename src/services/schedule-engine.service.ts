import type { NormalizedActivity, NormalizedSchedulePayload, ObraAmbientePayload, ObraAmbienteProdutoPayload } from "../types/payload.types.js";
import type { EngineResult, ScheduleLine } from "../types/schedule.types.js";
import { addBusinessDays, nextBusinessDay, previousBusinessDay } from "./business-days.service.js";
import { differenceInCalendarDays, formatDateOnly, parseDateOnly, weekdayName } from "../utils/dates.js";
import { stableLineId } from "../utils/ids.js";

interface PlacementContext {
  payload: NormalizedSchedulePayload;
  obraStart: Date;
  productsByProductId: Map<string, ObraAmbienteProdutoPayload>;
  fallbackProduct: ObraAmbienteProdutoPayload | null;
  ambientesById: Map<string, ObraAmbientePayload>;
  serviceStarts: Map<string, Date>;
  serviceEnds: Map<string, Date>;
  serviceCloneDates: Map<string, Date[]>;
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
  return String(product.produtoNome || product["nome produto"] || product.produto || product.produtoId || "") || null;
}

function getProductId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product.produtoId || product.produto || "") || null;
}

function getActivityProductId(activity: NormalizedActivity): string | null {
  return String(activity.produto || activity.produtoId || "") || null;
}

function productForActivity(ctx: PlacementContext, activity: NormalizedActivity): ObraAmbienteProdutoPayload | null {
  const productId = getActivityProductId(activity);
  if (productId) return ctx.productsByProductId.get(productId) || null;
  return ctx.fallbackProduct;
}

function getAmbienteId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product.ambienteId || product.obraAmbienteId || product["ambiente x obra"] || product.ambiente || "") || null;
}

function formatCodigoD(daysFromStart: number): string {
  if (daysFromStart > 0) return `D+${daysFromStart}`;
  if (daysFromStart === 0) return "D-0";
  return `D${daysFromStart}`;
}

function buildLine(ctx: PlacementContext, product: ObraAmbienteProdutoPayload | null, activity: NormalizedActivity, date: Date, cloneIndex: number, anchor?: NormalizedActivity): ScheduleLine {
  const dateOnly = formatDateOnly(date);
  const ambienteId = getAmbienteId(product);
  const ambiente = ambienteId ? ctx.ambientesById.get(ambienteId) : undefined;
  const daysFromStart = differenceInCalendarDays(ctx.obraStart, date) + 1;

  return {
    atividade_obra_id_externo: stableLineId(activity.id, dateOnly, cloneIndex),
    atividadeId: activity.id,
    atividadeNome: activity.nome,
    atividadeTipo: activity.tipo,
    atividadeServicoAncoraId: activity.atividadeServicoAncoraId,
    atividadeServicoAncoraNome: anchor?.nome || null,
    obraAmbienteProdutoId: product ? String(product.id || product.unique_id || product["unique id"] || "") || null : null,
    produtoId: getProductId(product),
    ambienteId,
    data_programada: dateOnly,
    codigo_d: formatCodigoD(daysFromStart),
    dia_semana: weekdayName(date),
    tipo: activity.tipo,
    subtipo_compra: activity.tipo === "Compra" ? activity.etapaCompra : null,
    nome_atividade: activity.nome,
    equipe: activity.equipe,
    peso: activity.peso,
    ambiente: ambiente ? String(ambiente.nome || ambiente.name || ambiente["nome ambiente"] || ambienteId) : null,
    produto: getProductName(product),
    ordem: activity.ordem,
    clone_index: cloneIndex,
    anchor_service_name: anchor?.nome || null,
    raw: activity.raw
  };
}

function teamKey(activity: NormalizedActivity): string {
  return activity.equipe || "__sem_equipe__";
}

function weightKey(activity: NormalizedActivity, dateOnly: string): string {
  return `${dateOnly}:${teamKey(activity)}`;
}

function canPlaceService(ctx: PlacementContext, activity: NormalizedActivity, date: Date): boolean {
  const dateOnly = formatDateOnly(date);
  const currentWeight = ctx.teamWeightByDay.get(weightKey(activity, dateOnly)) || 0;
  const activityDates = ctx.activityDays.get(activity.id) || new Set<string>();
  return currentWeight + activity.peso <= 10 && !activityDates.has(dateOnly);
}

function reserveServiceDate(ctx: PlacementContext, activity: NormalizedActivity, date: Date): void {
  const dateOnly = formatDateOnly(date);
  const key = weightKey(activity, dateOnly);
  ctx.teamWeightByDay.set(key, (ctx.teamWeightByDay.get(key) || 0) + activity.peso);
  const activityDates = ctx.activityDays.get(activity.id) || new Set<string>();
  activityDates.add(dateOnly);
  ctx.activityDays.set(activity.id, activityDates);
}

function latestDependencyEndDate(ctx: PlacementContext, service: NormalizedActivity): Date | null {
  let latest: Date | null = null;
  for (const dependencyId of service.interdependenciasMasterIds) {
    const dependencyEnd = ctx.serviceEnds.get(dependencyId);
    if (!dependencyEnd) continue;
    if (!latest || dependencyEnd > latest) latest = dependencyEnd;
  }
  return latest;
}

function laterDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function placeService(ctx: PlacementContext, service: NormalizedActivity, earliestStart: Date): void {
  const dependencyEnd = latestDependencyEndDate(ctx, service);
  let cursor = dependencyEnd ? laterDate(earliestStart, addBusinessDays(dependencyEnd, 1, ctx.payload.dias_trabalho_semana)) : earliestStart;
  const product = productForActivity(ctx, service);
  const totalClones = cloneCountFor(service, product);
  let firstDate: Date | null = null;
  let lastDate: Date | null = null;
  const cloneDates: Date[] = [];

  for (let cloneIndex = 1; cloneIndex <= totalClones; cloneIndex += 1) {
    cursor = nextBusinessDay(cursor, ctx.payload.dias_trabalho_semana);
    while (!canPlaceService(ctx, service, cursor)) cursor = addBusinessDays(cursor, 1, ctx.payload.dias_trabalho_semana);
    if (!firstDate) firstDate = cursor;
    lastDate = cursor;
    cloneDates.push(cursor);
    ctx.lines.push(buildLine(ctx, product, service, cursor, cloneIndex));
    reserveServiceDate(ctx, service, cursor);
    cursor = addBusinessDays(cursor, 1, ctx.payload.dias_trabalho_semana);
  }

  if (firstDate) ctx.serviceStarts.set(service.id, firstDate);
  if (lastDate) ctx.serviceEnds.set(service.id, lastDate);
  if (cloneDates.length) ctx.serviceCloneDates.set(service.id, cloneDates);
}

function hasUnplacedDependencyInSameOrder(service: NormalizedActivity, sameOrderIds: Set<string>, ctx: PlacementContext): boolean {
  return service.interdependenciasMasterIds.some((dependencyId) => sameOrderIds.has(dependencyId) && !ctx.serviceEnds.has(dependencyId));
}

function placeServices(ctx: PlacementContext, services: NormalizedActivity[]): void {
  const servicesByOrder = new Map<number, NormalizedActivity[]>();
  for (const service of services) {
    servicesByOrder.set(service.ordem, [...(servicesByOrder.get(service.ordem) || []), service]);
  }

  let previousOrderEnd: Date | null = null;
  for (const ordem of [...servicesByOrder.keys()].sort((a, b) => a - b)) {
    const group = [...servicesByOrder.get(ordem)!].sort(compareServiceOrder);
    const sameOrderIds = new Set(group.map((service) => service.id));
    const groupEarliestStart = previousOrderEnd ? addBusinessDays(previousOrderEnd, 1, ctx.payload.dias_trabalho_semana) : ctx.obraStart;
    const pending = [...group];

    while (pending.length) {
      const index = pending.findIndex((service) => !hasUnplacedDependencyInSameOrder(service, sameOrderIds, ctx));
      const [service] = pending.splice(index >= 0 ? index : 0, 1);
      placeService(ctx, service, groupEarliestStart);
    }

    const groupEnd = group.reduce<Date | null>((latest, service) => {
      const serviceEnd = ctx.serviceEnds.get(service.id)!;
      return latest ? laterDate(latest, serviceEnd) : serviceEnd;
    }, null);
    previousOrderEnd = previousOrderEnd && groupEnd ? laterDate(previousOrderEnd, groupEnd) : groupEnd;
  }
}

function placeAnchoredActivities(ctx: PlacementContext, activities: NormalizedActivity[], servicesById: Map<string, NormalizedActivity>): void {
  const purchases = activities.filter((activity) => activity.tipo === "Compra").sort((a, b) => a.ordem - b.ordem);
  const projects = activities.filter((activity) => activity.tipo === "Projeto").sort((a, b) => a.ordem - b.ordem);
  const anchorCounters = new Map<string, number>();
  const purchaseLinesByAnchor = new Map<string, ScheduleLine[]>();

  for (const activity of purchases) {
    const anchorId = activity.atividadeServicoAncoraId;
    if (!anchorId) continue;
    const anchorStart = ctx.serviceStarts.get(anchorId);
    const anchor = servicesById.get(anchorId);
    if (!anchorStart || !anchor) continue;
    const product = productForActivity(ctx, anchor);
    const counterKey = `${anchorId}:${activity.tipo}`;
    const currentCounter = anchorCounters.get(counterKey) || 0;
    const defaultOffset = currentCounter + 1;
    const offset = Number(activity.offsetDias ?? defaultOffset);
    const date = previousBusinessDay(addBusinessDays(anchorStart, -offset, ctx.payload.dias_trabalho_semana), ctx.payload.dias_trabalho_semana);
    const line = buildLine(ctx, product, activity, date, 1, anchor);
    ctx.lines.push(line);
    purchaseLinesByAnchor.set(anchorId, [...(purchaseLinesByAnchor.get(anchorId) || []), line]);
    anchorCounters.set(counterKey, currentCounter + 1);
  }

  for (const activity of projects) {
    const anchorId = activity.atividadeServicoAncoraId;
    if (!anchorId) continue;
    const anchorStart = ctx.serviceStarts.get(anchorId);
    const anchor = servicesById.get(anchorId);
    if (!anchorStart || !anchor) continue;
    const product = productForActivity(ctx, anchor);
    const purchasesForAnchor = purchaseLinesByAnchor.get(anchorId) || [];
    const avisoOrcamento = purchasesForAnchor.find((line) => line.subtipo_compra === "AVISO_ORCAMENTO");
    const earliestPurchase = [...purchasesForAnchor].sort((a, b) => a.data_programada.localeCompare(b.data_programada))[0];
    const referenceDate = avisoOrcamento?.data_programada || earliestPurchase?.data_programada;
    const counterKey = `${anchorId}:${activity.tipo}`;
    const currentCounter = anchorCounters.get(counterKey) || 0;
    const defaultOffset = currentCounter + 2;
    const offset = Number(activity.offsetDias ?? defaultOffset);
    const referenceStart = referenceDate ? parseDateOnly(referenceDate) : anchorStart;
    const date = previousBusinessDay(addBusinessDays(referenceStart, -offset, ctx.payload.dias_trabalho_semana), ctx.payload.dias_trabalho_semana);
    ctx.lines.push(buildLine(ctx, product, activity, date, 1, anchor));
    anchorCounters.set(counterKey, currentCounter + 1);
  }
}

function compareServiceOrder(a: NormalizedActivity, b: NormalizedActivity): number {
  return (
    a.ordem - b.ordem
    || teamKey(a).localeCompare(teamKey(b))
    || String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
    || a.id.localeCompare(b.id)
  );
}

export function runScheduleEngine(payload: NormalizedSchedulePayload): EngineResult {
  const obraStart = getObraStart(payload);
  const fallbackProduct = payload.obra_ambiente_produto_json[0] || null;
  const productsByProductId = new Map(
    payload.obra_ambiente_produto_json
      .map((product) => [getProductId(product), product] as const)
      .filter((entry): entry is [string, ObraAmbienteProdutoPayload] => Boolean(entry[0]))
  );
  const ambientesById = new Map(payload.obra_ambiente_json.map((ambiente) => [String(ambiente.id || ambiente.unique_id || ambiente["unique id"] || ""), ambiente]));
  const services = payload.atividades_json.filter((activity) => activity.tipo === "Servi\u00e7o").sort(compareServiceOrder);
  const anchored = payload.atividades_json.filter((activity) => activity.tipo === "Projeto" || activity.tipo === "Compra");
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const ctx: PlacementContext = {
    payload,
    obraStart,
    productsByProductId,
    fallbackProduct,
    ambientesById,
    serviceStarts: new Map(),
    serviceEnds: new Map(),
    serviceCloneDates: new Map(),
    lines: [],
    teamWeightByDay: new Map(),
    activityDays: new Map()
  };

  placeServices(ctx, services);
  placeAnchoredActivities(ctx, anchored, servicesById);
  ctx.lines.sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);

  return { lines: ctx.lines, validations: { warnings: [], errors: [] } };
}
