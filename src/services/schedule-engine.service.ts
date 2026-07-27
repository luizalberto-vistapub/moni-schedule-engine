import type { NormalizedActivity, NormalizedSchedulePayload, ObraAmbientePayload, ObraAmbienteProdutoPayload } from "../types/payload.types.js";
import type { EngineResult, ScheduleLine } from "../types/schedule.types.js";
import { addDays } from "../utils/dates.js";
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
  servicesByCompositeId: Map<string, NormalizedActivity[]>;
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
  return String(product.produtoNome || product["nome produto"] || product["nome produto simples"] || product.produto || product.produtoId || product["id produto simples"] || "") || null;
}

function getProductId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product.produtoId || product.produto || product["id produto simples"] || "") || null;
}

function getCompositeProductId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product["id produto composto"] || product.produtoCompostoId || product["produto composto"] || "") || null;
}

function getActivityProductId(activity: NormalizedActivity): string | null {
  return String(activity.produto || activity.produtoId || "") || null;
}

function productForActivityFrom(productsByProductId: Map<string, ObraAmbienteProdutoPayload>, fallbackProduct: ObraAmbienteProdutoPayload | null, activity: NormalizedActivity): ObraAmbienteProdutoPayload | null {
  const productId = getActivityProductId(activity);
  if (productId) return productsByProductId.get(productId) || null;
  return fallbackProduct;
}

function productForActivity(ctx: PlacementContext, activity: NormalizedActivity): ObraAmbienteProdutoPayload | null {
  return productForActivityFrom(ctx.productsByProductId, ctx.fallbackProduct, activity);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function productSortKey(product: ObraAmbienteProdutoPayload): string {
  return [
    getProductId(product),
    getCompositeProductId(product),
    stringValue(product.produtoNome),
    stringValue(product["nome produto"]),
    stringValue(product["nome produto simples"]),
    String(product.quantidade ?? ""),
    getAmbienteItemComposicaoId(product),
    stringValue(product.id),
    stringValue(product.unique_id),
    stringValue(product["unique id"])
  ].map((value) => value || "").join("|");
}

function compareProductOrder(a: ObraAmbienteProdutoPayload, b: ObraAmbienteProdutoPayload): number {
  return productSortKey(a).localeCompare(productSortKey(b));
}

function getAmbienteId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product.ambienteId || product.obraAmbienteId || product["ambiente x obra"] || product["id ambiente item composicao"] || product.ambiente || "") || null;
}

function getAmbienteItemComposicaoId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  const id = product["id ambiente item composicao"]
    || product.ambienteItemComposicaoId
    || product["ambiente x item composicao"];
  return String(id || "") || null;
}

function getObraAmbienteId(ambiente: ObraAmbientePayload | undefined, fallbackId: string | null): string | null {
  if (!ambiente) return fallbackId;
  const id = [ambiente["unique id"], ambiente.unique_id, ambiente.id, fallbackId]
    .find((value) => value !== undefined && value !== null && value !== "");
  return String(id);
}

function formatCodigoD(daysFromStart: number): string {
  if (daysFromStart > 0) return `D+${daysFromStart}`;
  if (daysFromStart === 0) return "D-0";
  return `D${daysFromStart}`;
}

function buildLine(ctx: PlacementContext, product: ObraAmbienteProdutoPayload | null, activity: NormalizedActivity, date: Date, cloneIndex: number, anchor?: NormalizedActivity): ScheduleLine {
  const dateOnly = formatDateOnly(date);
  const rawAmbienteId = getAmbienteId(product);
  const ambiente = rawAmbienteId ? ctx.ambientesById.get(rawAmbienteId) : undefined;
  const ambienteId = getObraAmbienteId(ambiente, rawAmbienteId);
  const daysFromStart = differenceInCalendarDays(ctx.obraStart, date) + 1;

  return {
    atividade_obra_id_externo: stableLineId(activity.id, dateOnly, cloneIndex),
    atividadeId: activity.id,
    atividadeNome: activity.nome,
    atividadeTipo: activity.tipo,
    atividadeServicoAncoraId: anchor?.id || activity.atividadeServicoAncoraId || null,
    atividadeServicoAncoraNome: anchor?.nome || null,
    obraAmbienteProdutoId: product ? String(product.id || product.unique_id || product["unique id"] || "") || null : null,
    produtoId: getProductId(product),
    ambienteId,
    ambienteItemComposicaoId: getAmbienteItemComposicaoId(product),
    data_programada: dateOnly,
    codigo_d: formatCodigoD(daysFromStart),
    dia_semana: weekdayName(date),
    tipo: activity.tipo,
    subtipo_compra: activity.tipo === "Compra" ? activity.etapaCompra : null,
    nome_atividade: activity.nome,
    equipe: activity.equipe,
    peso: activity.peso,
    ambiente: ambiente ? String(ambiente.nome || ambiente.name || ambiente["nome ambiente"] || rawAmbienteId) : null,
    produto: getProductName(product),
    ordem: activity.ordem,
    clone_index: cloneIndex,
    anchor_service_name: anchor?.nome || null,
    interdependenciasMasterIds: [],
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

function forcedActivityStart(activity: NormalizedActivity): Date | null {
  const value = activity.__recalculateStartDate;
  return typeof value === "string" && value ? parseDateOnly(value) : null;
}

function purchaseStageOrder(activity: NormalizedActivity): number {
  const stageOrder: Record<string, number> = {
    AVISO_ORCAMENTO: 1,
    LIMITE_ORCAMENTO: 2,
    LIMITE_COMPRA: 3,
    RECEBIMENTO: 4
  };
  /* v8 ignore next -- normalized purchases have a known stage before ordering. */
  return activity.etapaCompra ? stageOrder[activity.etapaCompra] || 99 : 99;
}

function compareAnchoredActivityOrder(a: NormalizedActivity, b: NormalizedActivity): number {
  return a.ordem - b.ordem || a.id.localeCompare(b.id);
}

function comparePurchaseChainOrder(a: NormalizedActivity, b: NormalizedActivity): number {
  return purchaseStageOrder(a) - purchaseStageOrder(b) || compareAnchoredActivityOrder(a, b);
}

function purchaseChainKey(anchorId: string, activity: NormalizedActivity): string {
  const activityAnchorId = activity.atividadeServicoAncoraId || "";
  /* v8 ignore next -- fallback supports malformed purchase payloads without an item id. */
  const purchaseItemId = activityAnchorId && activityAnchorId !== anchorId ? activityAnchorId : getActivityProductId(activity);
  return `${anchorId}:${purchaseItemId || "__default__"}`;
}

function placeService(ctx: PlacementContext, service: NormalizedActivity, earliestStart: Date): void {
  const dependencyEnd = latestDependencyEndDate(ctx, service);
  let cursor = dependencyEnd ? laterDate(earliestStart, addBusinessDays(dependencyEnd, 1, ctx.payload.dias_trabalho_semana)) : earliestStart;
  const forcedStart = forcedActivityStart(service);
  if (forcedStart) cursor = laterDate(cursor, forcedStart);
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
  const purchases = activities.filter((activity) => activity.tipo === "Compra" && activity.etapaCompra).sort(comparePurchaseChainOrder);
  const projects = activities.filter((activity) => activity.tipo === "Projeto").sort(compareAnchoredActivityOrder);
  const anchorCounters = new Map<string, number>();
  const purchaseLinesByAnchor = new Map<string, ScheduleLine[]>();

  const resolveAnchor = (activity: NormalizedActivity): NormalizedActivity | null => {
    const earliestServiceForComposite = (compositeId: string): NormalizedActivity | null => {
      const services = ctx.servicesByCompositeId.get(compositeId);
      if (!services?.length) return null;
      const [earliest] = [...services].sort((a, b) => ctx.serviceStarts.get(a.id)!.getTime() - ctx.serviceStarts.get(b.id)!.getTime());
      return earliest;
    };

    if (activity.atividadeServicoAncoraId) {
      const explicitService = servicesById.get(activity.atividadeServicoAncoraId);
      if (explicitService) {
        const explicitCompositeId = getCompositeProductId(productForActivity(ctx, explicitService));
        return explicitCompositeId ? earliestServiceForComposite(explicitCompositeId) || explicitService : explicitService;
      }
      const anchorProduct = ctx.productsByProductId.get(activity.atividadeServicoAncoraId);
      const anchorCompositeId = getCompositeProductId(anchorProduct || null);
      if (anchorCompositeId) {
        const serviceByAnchorProduct = earliestServiceForComposite(anchorCompositeId);
        if (serviceByAnchorProduct) return serviceByAnchorProduct;
      }
      const serviceByComposite = earliestServiceForComposite(activity.atividadeServicoAncoraId);
      if (serviceByComposite) return serviceByComposite;
    }
    const compositeId = getCompositeProductId(productForActivity(ctx, activity));
    return compositeId ? earliestServiceForComposite(compositeId) : null;
  };

  const purchasesByChain = new Map<string, { anchorId: string; activity: NormalizedActivity; anchor: NormalizedActivity }[]>();
  for (const activity of purchases) {
    const anchor = resolveAnchor(activity);
    const anchorId = anchor?.id;
    if (!anchorId) continue;
    const chainKey = purchaseChainKey(anchorId, activity);
    purchasesByChain.set(chainKey, [...(purchasesByChain.get(chainKey) || []), { anchorId, activity, anchor }]);
  }

  for (const purchaseEntries of purchasesByChain.values()) {
    const anchorId = purchaseEntries[0].anchorId;
    const anchorStart = ctx.serviceStarts.get(anchorId)!;
    const orderedEntries = [...purchaseEntries].sort((a, b) => comparePurchaseChainOrder(a.activity, b.activity));

    for (const { activity, anchor } of orderedEntries.reverse()) {
      let product = productForActivity(ctx, activity);
      if (!product) product = productForActivity(ctx, anchor);
      const counterKey = `${anchorId}:${activity.tipo}`;
      const currentCounter = anchorCounters.get(counterKey) || 0;
      const defaultOffset = currentCounter + 1;
      const offset = Number(activity.offsetDias ?? defaultOffset);
      const forcedStart = forcedActivityStart(activity);
      const date = forcedStart || addDays(anchorStart, -offset);
      const line = buildLine(ctx, product, activity, date, 1, anchor);
      ctx.lines.push(line);
      purchaseLinesByAnchor.set(anchorId, [...(purchaseLinesByAnchor.get(anchorId) || []), line]);
      anchorCounters.set(counterKey, currentCounter + 1);
    }
  }

  for (const activity of projects) {
    const anchor = resolveAnchor(activity);
    const anchorId = anchor?.id;
    if (!anchorId) continue;
    const anchorStart = ctx.serviceStarts.get(anchorId)!;
    let product = productForActivity(ctx, activity);
    if (!product) product = productForActivity(ctx, anchor);
    const earliestPurchase = [...(purchaseLinesByAnchor.get(anchorId) || [])].sort((a, b) => a.data_programada.localeCompare(b.data_programada))[0];
    const counterKey = `${anchorId}:${activity.tipo}`;
    const currentCounter = anchorCounters.get(counterKey) || 0;
    const defaultOffset = currentCounter + 2;
    const offset = Number(activity.offsetDias ?? defaultOffset);
    const forcedStart = forcedActivityStart(activity);
    const referenceStart = earliestPurchase ? parseDateOnly(earliestPurchase.data_programada) : anchorStart;
    const date = forcedStart || addDays(referenceStart, -offset);
    ctx.lines.push(buildLine(ctx, product, activity, date, 1, anchor));
    anchorCounters.set(counterKey, currentCounter + 1);
  }
}

function populateAtividadeObraDependencies(ctx: PlacementContext): void {
  const lineIdsByActivity = new Map<string, string[]>();
  for (const line of ctx.lines) {
    lineIdsByActivity.set(line.atividadeId, [...(lineIdsByActivity.get(line.atividadeId) || []), line.atividade_obra_id_externo]);
  }

  const activityDependenciesById = new Map(ctx.payload.atividades_json.map((activity) => [activity.id, activity.interdependenciasMasterIds]));
  for (const line of ctx.lines) {
    const dependencyActivityIds = activityDependenciesById.get(line.atividadeId) || [];
    line.interdependenciasMasterIds = dependencyActivityIds.flatMap((dependencyId) => lineIdsByActivity.get(dependencyId) || []);
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
  const orderedProducts = [...payload.obra_ambiente_produto_json].sort(compareProductOrder);
  const fallbackProduct = orderedProducts[0] || null;
  const productsByProductId = new Map<string, ObraAmbienteProdutoPayload>();
  for (const product of orderedProducts) {
    const productId = getProductId(product);
    if (productId && !productsByProductId.has(productId)) productsByProductId.set(productId, product);
  }
  const ambientesById = new Map(
    payload.obra_ambiente_json.flatMap((ambiente) => {
      const ids = [ambiente.id, ambiente.unique_id, ambiente["unique id"], ambiente.ambiente]
        .map((id) => String(id || ""))
        .filter(Boolean);
      return ids.map((id) => [id, ambiente] as const);
    })
  );
  const services = payload.atividades_json.filter((activity) => activity.tipo === "Servi\u00e7o").sort(compareServiceOrder);
  const anchored = payload.atividades_json.filter((activity) => activity.tipo === "Projeto" || activity.tipo === "Compra");
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const servicesByCompositeId = new Map<string, NormalizedActivity[]>();
  for (const service of services) {
    const compositeId = getCompositeProductId(productForActivityFrom(productsByProductId, fallbackProduct, service));
    if (!compositeId) continue;
    servicesByCompositeId.set(compositeId, [...(servicesByCompositeId.get(compositeId) || []), service]);
  }
  const ctx: PlacementContext = {
    payload,
    obraStart,
    productsByProductId,
    fallbackProduct,
    ambientesById,
    serviceStarts: new Map(),
    serviceEnds: new Map(),
    serviceCloneDates: new Map(),
    servicesByCompositeId,
    lines: [],
    teamWeightByDay: new Map(),
    activityDays: new Map()
  };

  placeServices(ctx, services);
  placeAnchoredActivities(ctx, anchored, servicesById);
  populateAtividadeObraDependencies(ctx);
  ctx.lines.sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);

  return { lines: ctx.lines, validations: { warnings: [], errors: [] } };
}
