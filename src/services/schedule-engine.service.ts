import type { NormalizedActivity, NormalizedSchedulePayload, ObraAmbientePayload, ObraAmbienteProdutoPayload } from "../types/payload.types.js";
import type { EngineResult, ScheduleLine } from "../types/schedule.types.js";
import { addDays } from "../utils/dates.js";
import { addBusinessDays, nextBusinessDay, previousBusinessDay } from "./business-days.service.js";
import { differenceInCalendarDays, formatDateOnly, parseDateOnly, weekdayName } from "../utils/dates.js";
import { stableLineId } from "../utils/ids.js";

interface PlacementContext {
  payload: NormalizedSchedulePayload;
  obraStart: Date;
  productsByProductId: Map<string, ObraAmbienteProdutoPayload[]>;
  productsByProductAndCompositeId: Map<string, ObraAmbienteProdutoPayload[]>;
  productsByProductCompositeAndContextId: Map<string, ObraAmbienteProdutoPayload>;
  compositeIdsByProductId: Map<string, string[]>;
  fallbackProduct: ObraAmbienteProdutoPayload | null;
  ambientesById: Map<string, ObraAmbientePayload>;
  serviceStarts: Map<string, Date>;
  serviceEnds: Map<string, Date>;
  serviceCloneDates: Map<string, Date[]>;
  servicePlacements: ServicePlacement[];
  servicePlacementsById: Map<string, ServicePlacement[]>;
  servicePlacementsByCompositeId: Map<string, ServicePlacement[]>;
  lines: ScheduleLine[];
  lineExternalIndexCounters: Map<string, number>;
  teamWeightByDay: Map<string, number>;
  activityDays: Map<string, Set<string>>;
  warnings: string[];
}

interface ServicePlacement {
  service: NormalizedActivity;
  product: ObraAmbienteProdutoPayload | null;
  key: string;
  compositeId: string | null;
  contextId: string | null;
  firstDate: Date;
  lastDate: Date;
  cloneDates: Date[];
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

function firstProductForActivityFrom(productsByProductId: Map<string, ObraAmbienteProdutoPayload[]>, fallbackProduct: ObraAmbienteProdutoPayload | null, activity: NormalizedActivity): ObraAmbienteProdutoPayload | null {
  const productId = getActivityProductId(activity);
  if (productId) return productsByProductId.get(productId)?.[0] || null;
  return fallbackProduct;
}

function productForActivity(ctx: PlacementContext, activity: NormalizedActivity): ObraAmbienteProdutoPayload | null {
  const productId = getActivityProductId(activity);
  const compositeId = activity.atividadeServicoAncoraId || "";
  if (productId && compositeId) {
    const contextualProduct = ctx.productsByProductAndCompositeId.get(productCompositeKey(productId, compositeId))?.[0];
    if (contextualProduct) return contextualProduct;
  }
  return firstProductForActivityFrom(ctx.productsByProductId, ctx.fallbackProduct, activity);
}

function productsForService(ctx: PlacementContext, activity: NormalizedActivity): (ObraAmbienteProdutoPayload | null)[] {
  const productId = getActivityProductId(activity);
  if (!productId) return [ctx.fallbackProduct];
  return ctx.productsByProductId.get(productId) || [null];
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

function productCompositeKey(productId: string, compositeId: string): string {
  return `${productId}:${compositeId}`;
}

function productCompositeContextKey(productId: string, compositeId: string, contextId: string): string {
  return `${productId}:${compositeId}:${contextId}`;
}

function getAmbienteLookupId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product["id ambiente item composicao"] || product.ambienteItemComposicaoId || product["ambiente x item composicao"] || product.ambienteId || product.obraAmbienteId || product.ambiente || product["id ambiente x obra"] || product["ambiente x obra"] || "") || null;
}

function getProdutoAmbienteXObraId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  return String(product["id ambiente x obra"] || product["ambiente x obra"] || product.ambienteXObraId || product.ambienteXobraId || "") || null;
}

function getAmbienteItemComposicaoId(product: ObraAmbienteProdutoPayload | null): string | null {
  if (!product) return null;
  const id = product["id ambiente item composicao"]
    || product.ambienteItemComposicaoId
    || product["ambiente x item composicao"];
  return String(id || "") || null;
}

function productContextId(product: ObraAmbienteProdutoPayload | null): string | null {
  return getAmbienteItemComposicaoId(product) || getAmbienteLookupId(product) || getProdutoAmbienteXObraId(product);
}

function productForAnchoredActivity(ctx: PlacementContext, activity: NormalizedActivity, anchor: ServicePlacement, anchorCompositeId?: string | null): ObraAmbienteProdutoPayload | null {
  const productId = getActivityProductId(activity);
  const compositeId = anchorCompositeId || activity.atividadeServicoAncoraId || anchor.compositeId || "";
  const contextId = anchor.contextId;
  if (productId && compositeId && contextId) {
    const contextualProduct = ctx.productsByProductCompositeAndContextId.get(productCompositeContextKey(productId, compositeId, contextId));
    if (contextualProduct) return contextualProduct;
  }
  return productForActivity(ctx, activity);
}

function getObraAmbienteXObraId(ambiente: ObraAmbientePayload | undefined, product: ObraAmbienteProdutoPayload | null): string | null {
  const productId = getProdutoAmbienteXObraId(product);
  if (productId) return productId;
  if (!ambiente) return null;
  const id = [ambiente["id ambiente x obra"], ambiente["ambiente x obra"], ambiente.ambienteXObraId, ambiente.ambienteXobraId, ambiente.obraAmbienteId]
    .find((value) => value !== undefined && value !== null && value !== "");
  return id === undefined ? null : String(id);
}

function formatCodigoD(daysFromStart: number): string {
  if (daysFromStart > 0) return `D+${daysFromStart}`;
  if (daysFromStart === 0) return "D-0";
  return `D${daysFromStart}`;
}

function buildLine(ctx: PlacementContext, product: ObraAmbienteProdutoPayload | null, activity: NormalizedActivity, date: Date, cloneIndex: number, anchor?: NormalizedActivity): ScheduleLine {
  const dateOnly = formatDateOnly(date);
  const rawAmbienteId = getAmbienteLookupId(product);
  const ambiente = rawAmbienteId ? ctx.ambientesById.get(rawAmbienteId) : undefined;
  const ambienteId = getObraAmbienteXObraId(ambiente, product);
  const externalContextId = ambienteId || rawAmbienteId || "sem_ambiente";
  const externalCounterKey = `${activity.id}:${externalContextId}`;
  const externalIndex = (ctx.lineExternalIndexCounters.get(externalCounterKey) || 0) + 1;
  ctx.lineExternalIndexCounters.set(externalCounterKey, externalIndex);
  const daysFromStart = differenceInCalendarDays(ctx.obraStart, date) + 1;

  return {
    atividade_obra_id_externo: stableLineId(activity.id, externalContextId, externalIndex),
    atividadeId: activity.id,
    atividadeNome: activity.nome,
    atividadeTipo: activity.tipo,
    atividadeServicoAncoraId: anchor?.id || activity.atividadeServicoAncoraId || null,
    atividadeServicoAncoraNome: anchor?.nome || null,
    atividadeServicoAncoraExternoId: null,
    obraAmbienteProdutoId: product ? String(product.id || product.unique_id || product["unique id"] || "") || null : null,
    produtoId: getProductId(product),
    ambienteId,
    ambienteItemComposicaoId: getAmbienteItemComposicaoId(product),
    external_index: externalIndex,
    data_programada: dateOnly,
    codigo_d: formatCodigoD(daysFromStart),
    dia_semana: weekdayName(date),
    tipo: activity.tipo,
    subtipo_compra: activity.tipo === "Compra" ? activity.etapaCompra : null,
    nome_atividade: activity.nome,
    equipe: activity.equipe,
    familia: activity.familia,
    nomeFamilia: activity.nomeFamilia,
    projetoId: activity.projetoId,
    tipoProjeto: activity.tipoProjeto,
    localAtuacao: activity.localAtuacao,
    diasAntecedencia: activity.offsetDias ?? null,
    projetoResponsavel: activity.projetoResponsavel,
    projetoStatus: activity.projetoStatus,
    peso: activity.peso,
    ambiente: ambiente ? String(ambiente.nome || ambiente.name || ambiente["nome ambiente"] || rawAmbienteId) : null,
    produto: getProductName(product),
    ordem: activity.ordem,
    ordemCronograma: 0,
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

function servicePlacementKey(service: NormalizedActivity, product: ObraAmbienteProdutoPayload | null): string {
  return `${service.id}:${productContextId(product) || "sem_contexto"}:${product ? String(product.id || product.unique_id || product["unique id"] || "") : "sem_produto"}`;
}

function canPlaceService(ctx: PlacementContext, activity: NormalizedActivity, product: ObraAmbienteProdutoPayload | null, date: Date): boolean {
  const dateOnly = formatDateOnly(date);
  const currentWeight = ctx.teamWeightByDay.get(weightKey(activity, dateOnly)) || 0;
  const activityDates = ctx.activityDays.get(servicePlacementKey(activity, product)) || new Set<string>();
  return currentWeight + activity.peso <= 10 && !activityDates.has(dateOnly);
}

function reserveServiceDate(ctx: PlacementContext, activity: NormalizedActivity, product: ObraAmbienteProdutoPayload | null, date: Date): void {
  const dateOnly = formatDateOnly(date);
  const key = weightKey(activity, dateOnly);
  ctx.teamWeightByDay.set(key, (ctx.teamWeightByDay.get(key) || 0) + activity.peso);
  const activityKey = servicePlacementKey(activity, product);
  const activityDates = ctx.activityDays.get(activityKey) || new Set<string>();
  activityDates.add(dateOnly);
  ctx.activityDays.set(activityKey, activityDates);
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

function compareCanonicalPurchase(a: NormalizedActivity, b: NormalizedActivity): number {
  const createdAtTime = (activity: NormalizedActivity): number => {
    if (typeof activity.createdAt !== "string" || !activity.createdAt) return Number.POSITIVE_INFINITY;
    const timestamp = Date.parse(activity.createdAt);
    return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
  };
  return createdAtTime(a) - createdAtTime(b) || a.id.localeCompare(b.id);
}

export function compareAnchorPriority(
  a: Pick<NormalizedActivity, "ordem" | "id">,
  aStart: Date,
  b: Pick<NormalizedActivity, "ordem" | "id">,
  bStart: Date
): number {
  return a.ordem - b.ordem || aStart.getTime() - bStart.getTime() || a.id.localeCompare(b.id);
}

function purchaseChainKey(anchorId: string, activity: NormalizedActivity): string {
  /* v8 ignore next -- fallback supports malformed purchase payloads without an item id. */
  const purchaseItemId = getActivityProductId(activity) || activity.atividadeServicoAncoraId;
  return `${anchorId}:${purchaseItemId || "__default__"}`;
}

function placeService(ctx: PlacementContext, service: NormalizedActivity, product: ObraAmbienteProdutoPayload | null, earliestStart: Date): void {
  const dependencyEnd = latestDependencyEndDate(ctx, service);
  let cursor = dependencyEnd ? laterDate(earliestStart, addBusinessDays(dependencyEnd, 1, ctx.payload.dias_trabalho_semana)) : earliestStart;
  const forcedStart = forcedActivityStart(service);
  if (forcedStart) cursor = laterDate(cursor, forcedStart);
  const totalClones = cloneCountFor(service, product);
  let firstDate: Date | null = null;
  let lastDate: Date | null = null;
  const cloneDates: Date[] = [];

  for (let cloneIndex = 1; cloneIndex <= totalClones; cloneIndex += 1) {
    cursor = nextBusinessDay(cursor, ctx.payload.dias_trabalho_semana);
    while (!canPlaceService(ctx, service, product, cursor)) cursor = addBusinessDays(cursor, 1, ctx.payload.dias_trabalho_semana);
    if (!firstDate) firstDate = cursor;
    lastDate = cursor;
    cloneDates.push(cursor);
    ctx.lines.push(buildLine(ctx, product, service, cursor, cloneIndex));
    reserveServiceDate(ctx, service, product, cursor);
    cursor = addBusinessDays(cursor, 1, ctx.payload.dias_trabalho_semana);
  }

  if (firstDate && lastDate) {
    const placement: ServicePlacement = {
      service,
      product,
      key: servicePlacementKey(service, product),
      compositeId: getCompositeProductId(product),
      contextId: productContextId(product),
      firstDate,
      lastDate,
      cloneDates
    };
    ctx.servicePlacements.push(placement);
    ctx.servicePlacementsById.set(service.id, [...(ctx.servicePlacementsById.get(service.id) || []), placement]);
    if (placement.compositeId) {
      ctx.servicePlacementsByCompositeId.set(placement.compositeId, [...(ctx.servicePlacementsByCompositeId.get(placement.compositeId) || []), placement]);
    }
    const currentStart = ctx.serviceStarts.get(service.id);
    if (!currentStart || firstDate < currentStart) ctx.serviceStarts.set(service.id, firstDate);
    const currentEnd = ctx.serviceEnds.get(service.id);
    if (!currentEnd || lastDate > currentEnd) ctx.serviceEnds.set(service.id, lastDate);
    ctx.serviceCloneDates.set(service.id, [...(ctx.serviceCloneDates.get(service.id) || []), ...cloneDates]);
  }
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
      for (const product of productsForService(ctx, service)) {
        placeService(ctx, service, product, groupEarliestStart);
      }
    }

    const groupEnd = group.reduce<Date | null>((latest, service) => {
      const serviceEnd = ctx.serviceEnds.get(service.id)!;
      return latest ? laterDate(latest, serviceEnd) : serviceEnd;
    }, null);
    previousOrderEnd = previousOrderEnd && groupEnd ? laterDate(previousOrderEnd, groupEnd) : groupEnd;
  }
}

function placeAnchoredActivities(ctx: PlacementContext, activities: NormalizedActivity[], servicesById: Map<string, NormalizedActivity>): void {
  const purchaseCandidates = activities.filter((activity) => activity.tipo === "Compra" && activity.etapaCompra);
  const canonicalPurchasesByStage = new Map<string, NormalizedActivity>();
  for (const activity of purchaseCandidates) {
    const productId = getActivityProductId(activity);
    const key = productId ? `${productId}:${activity.etapaCompra}` : `__atividade__:${activity.id}`;
    const current = canonicalPurchasesByStage.get(key);
    if (!current || compareCanonicalPurchase(activity, current) < 0) canonicalPurchasesByStage.set(key, activity);
  }
  const purchases = [...canonicalPurchasesByStage.values()].sort(comparePurchaseChainOrder);
  const projects = activities.filter((activity) => activity.tipo === "Projeto").sort(compareAnchoredActivityOrder);
  const anchorCounters = new Map<string, number>();
  const purchaseLinesByAnchor = new Map<string, ScheduleLine[]>();
  const skippedAnchors = new Map<string, { count: number; sample: NormalizedActivity; reason: string }>();

  const recordSkippedAnchor = (activity: NormalizedActivity, reason: string): void => {
    const anchorRef = activity.atividadeServicoAncoraId || "__sem_ancora__";
    const productRef = getActivityProductId(activity) || "__sem_produto__";
    const key = `${activity.tipo}:${anchorRef}:${productRef}:${reason}`;
    const current = skippedAnchors.get(key);
    skippedAnchors.set(key, { count: (current?.count || 0) + 1, sample: current?.sample || activity, reason });
  };

  const compareAnchorCandidates = (
    a: { anchor: ServicePlacement; compositeId: string | null },
    b: { anchor: ServicePlacement; compositeId: string | null }
  ): number => (
    compareAnchorPriority(a.anchor.service, a.anchor.firstDate, b.anchor.service, b.anchor.firstDate)
    || String(a.compositeId || "").localeCompare(String(b.compositeId || ""))
    || String(a.anchor.contextId || "").localeCompare(String(b.anchor.contextId || ""))
  );

  const preferredServicesForComposite = (compositeId: string): { anchor: ServicePlacement; compositeId: string }[] => {
    const services = ctx.servicePlacementsByCompositeId.get(compositeId);
    if (!services?.length) return [];
    const preferredByContext = new Map<string, { anchor: ServicePlacement; compositeId: string }>();
    for (const candidate of services
      .map((anchor) => ({ anchor, compositeId }))
      .sort(compareAnchorCandidates)) {
      const key = candidate.anchor.contextId || "__sem_contexto__";
      if (!preferredByContext.has(key)) preferredByContext.set(key, candidate);
    }
    return [...preferredByContext.values()].sort(compareAnchorCandidates);
  };

  const resolveAnchors = (activity: NormalizedActivity): { anchor: ServicePlacement; compositeId: string | null }[] => {
    if (activity.tipo === "Compra") {
      const productId = getActivityProductId(activity);
      const productCandidates = (productId ? ctx.compositeIdsByProductId.get(productId) : null) || [];
      const candidates = productCandidates
        .flatMap((compositeId) => preferredServicesForComposite(compositeId))
        .sort(compareAnchorCandidates);
      if (candidates.length) return candidates;
    }
    if (activity.atividadeServicoAncoraId) {
      const explicitServicePlacements = ctx.servicePlacementsById.get(activity.atividadeServicoAncoraId);
      const explicitService = servicesById.get(activity.atividadeServicoAncoraId);
      if (explicitService) {
        return (explicitServicePlacements || [])
          .map((anchor) => ({ anchor, compositeId: anchor.compositeId }))
          .sort(compareAnchorCandidates);
      }
      const anchorProduct = ctx.productsByProductId.get(activity.atividadeServicoAncoraId)?.[0];
      const anchorCompositeId = getCompositeProductId(anchorProduct || null);
      if (anchorCompositeId) {
        const servicesByAnchorProduct = preferredServicesForComposite(anchorCompositeId);
        if (servicesByAnchorProduct.length) return servicesByAnchorProduct;
      }
      const servicesByComposite = preferredServicesForComposite(activity.atividadeServicoAncoraId);
      if (servicesByComposite.length) return servicesByComposite;
    }
    const compositeId = getCompositeProductId(productForActivity(ctx, activity));
    return compositeId ? preferredServicesForComposite(compositeId) : [];
  };

  const purchasesByChain = new Map<string, { anchorId: string; activity: NormalizedActivity; anchor: ServicePlacement; compositeId: string | null }[]>();
  for (const activity of purchases) {
    const resolvedAnchors = resolveAnchors(activity);
    if (!resolvedAnchors.length) {
      recordSkippedAnchor(activity, "sem servico ancora gerado");
      continue;
    }
    for (const { anchor, compositeId } of resolvedAnchors) {
      const anchorId = anchor.key;
      const chainKey = `${purchaseChainKey(anchorId, activity)}:${anchor.contextId || "__sem_contexto__"}`;
      purchasesByChain.set(chainKey, [...(purchasesByChain.get(chainKey) || []), { anchorId, activity, anchor, compositeId }]);
    }
  }

  for (const purchaseEntries of purchasesByChain.values()) {
    const anchorId = purchaseEntries[0].anchorId;
    const anchorStart = purchaseEntries[0].anchor.firstDate;
    const orderedEntries = [...purchaseEntries].sort((a, b) => comparePurchaseChainOrder(a.activity, b.activity));

    for (const { activity, anchor, compositeId } of orderedEntries.reverse()) {
      let product = productForAnchoredActivity(ctx, activity, anchor, compositeId);
      if (!product) product = anchor.product;
      const counterKey = `${anchorId}:${activity.tipo}`;
      const currentCounter = anchorCounters.get(counterKey) || 0;
      const defaultOffset = currentCounter + 1;
      const offset = Number(activity.offsetDias ?? defaultOffset);
      const forcedStart = forcedActivityStart(activity);
      const date = forcedStart || addDays(anchorStart, -offset);
      const line = buildLine(ctx, product, activity, date, 1, anchor.service);
      ctx.lines.push(line);
      purchaseLinesByAnchor.set(anchorId, [...(purchaseLinesByAnchor.get(anchorId) || []), line]);
      anchorCounters.set(counterKey, currentCounter + 1);
    }
  }

  const projectEntriesById = new Map<string, { activity: NormalizedActivity; anchor: ServicePlacement }[]>();
  for (const activity of projects) {
    const anchors = resolveAnchors(activity);
    if (!anchors.length) {
      recordSkippedAnchor(activity, "sem servico ancora gerado");
      continue;
    }
    projectEntriesById.set(activity.id, [
      ...(projectEntriesById.get(activity.id) || []),
      ...anchors.map(({ anchor }) => ({ activity, anchor }))
    ]);
  }

  const selectedProjects = [...projectEntriesById.values()]
    .map((entries) => entries.sort((a, b) => (
      a.anchor.firstDate.getTime() - b.anchor.firstDate.getTime()
      || compareAnchoredActivityOrder(a.activity, b.activity)
      || a.anchor.service.id.localeCompare(b.anchor.service.id)
      || String(a.anchor.contextId || "").localeCompare(String(b.anchor.contextId || ""))
    ))[0]!)
    .sort((a, b) => compareAnchoredActivityOrder(a.activity, b.activity));

  for (const { activity, anchor } of selectedProjects) {
    const anchorId = anchor.key;
    const anchorStart = anchor.firstDate;
    let product = productForAnchoredActivity(ctx, activity, anchor);
    if (!product) product = anchor.product;
    const earliestPurchase = [...(purchaseLinesByAnchor.get(anchorId) || [])].sort((a, b) => a.data_programada.localeCompare(b.data_programada))[0];
    const counterKey = `${anchorId}:${activity.tipo}`;
    const currentCounter = anchorCounters.get(counterKey) || 0;
    const defaultOffset = currentCounter + 2;
    const offset = Number(activity.offsetDias ?? defaultOffset);
    const forcedStart = forcedActivityStart(activity);
    const referenceStart = earliestPurchase ? parseDateOnly(earliestPurchase.data_programada) : anchorStart;
    const date = forcedStart || addDays(referenceStart, -offset);
    ctx.lines.push(buildLine(ctx, product, activity, date, 1, anchor.service));
    anchorCounters.set(counterKey, currentCounter + 1);
  }

  for (const { count, sample, reason } of skippedAnchors.values()) {
    const anchorRef = sample.atividadeServicoAncoraId || "sem ancora";
    const productRef = getActivityProductId(sample) || "sem produto";
    ctx.warnings.push(`Atividades ancoradas nao geradas: tipo=${sample.tipo}; quantidade=${count}; produto=${productRef}; atividadeServicoAncoraId=${anchorRef}; motivo=${reason}.`);
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

function populateAnchorExternalIds(lines: ScheduleLine[]): void {
  const lineIdsByActivity = new Map<string, string[]>();
  for (const line of lines) {
    lineIdsByActivity.set(line.atividadeId, [...(lineIdsByActivity.get(line.atividadeId) || []), line.atividade_obra_id_externo]);
  }

  for (const line of lines) {
    line.atividadeServicoAncoraExternoId = line.atividadeServicoAncoraId
      ? lineIdsByActivity.get(line.atividadeServicoAncoraId)?.[0] || null
      : null;
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
  const productsByProductId = new Map<string, ObraAmbienteProdutoPayload[]>();
  const productsByProductAndCompositeId = new Map<string, ObraAmbienteProdutoPayload[]>();
  const productsByProductCompositeAndContextId = new Map<string, ObraAmbienteProdutoPayload>();
  const compositeIdsByProductId = new Map<string, string[]>();
  for (const product of orderedProducts) {
    const productId = getProductId(product);
    if (productId) productsByProductId.set(productId, [...(productsByProductId.get(productId) || []), product]);
    const compositeId = getCompositeProductId(product);
    if (productId && compositeId) {
      const compositeIds = compositeIdsByProductId.get(productId) || [];
      if (!compositeIds.includes(compositeId)) compositeIdsByProductId.set(productId, [...compositeIds, compositeId]);
      const key = productCompositeKey(productId, compositeId);
      productsByProductAndCompositeId.set(key, [...(productsByProductAndCompositeId.get(key) || []), product]);
      const contextId = productContextId(product);
      if (contextId) {
        const contextKey = productCompositeContextKey(productId, compositeId, contextId);
        if (!productsByProductCompositeAndContextId.has(contextKey)) productsByProductCompositeAndContextId.set(contextKey, product);
      }
    }
  }
  const ambientesById = new Map(
    payload.obra_ambiente_json.flatMap((ambiente) => {
      const ids = [ambiente.id, ambiente.unique_id, ambiente["unique id"], ambiente.ambiente]
        .concat([ambiente["id ambiente"], ambiente["id ambiente x obra"], ambiente["ambiente x obra"]])
        .map((id) => String(id || ""))
        .filter(Boolean);
      return ids.map((id) => [id, ambiente] as const);
    })
  );
  const services = payload.atividades_json.filter((activity) => activity.tipo === "Servi\u00e7o").sort(compareServiceOrder);
  const anchored = payload.atividades_json.filter((activity) => activity.tipo === "Projeto" || activity.tipo === "Compra");
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const ctx: PlacementContext = {
    payload,
    obraStart,
    productsByProductId,
    productsByProductAndCompositeId,
    productsByProductCompositeAndContextId,
    compositeIdsByProductId,
    fallbackProduct,
    ambientesById,
    serviceStarts: new Map(),
    serviceEnds: new Map(),
    serviceCloneDates: new Map(),
    servicePlacements: [],
    servicePlacementsById: new Map(),
    servicePlacementsByCompositeId: new Map(),
    lines: [],
    lineExternalIndexCounters: new Map(),
    teamWeightByDay: new Map(),
    activityDays: new Map(),
    warnings: []
  };

  placeServices(ctx, services);
  placeAnchoredActivities(ctx, anchored, servicesById);
  populateAtividadeObraDependencies(ctx);
  populateAnchorExternalIds(ctx.lines);
  ctx.lines.sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);
  ctx.lines.forEach((line, index) => {
    line.ordemCronograma = index + 1;
  });

  return { lines: ctx.lines, validations: { warnings: ctx.warnings, errors: [] } };
}
