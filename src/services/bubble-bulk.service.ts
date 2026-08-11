import type { Logger } from "pino";
import type { NormalizedSchedulePayload, ObraAmbientePayload, ObraAmbienteProdutoPayload, ObraPayload } from "../types/payload.types.js";
import type { ScheduleLine } from "../types/schedule.types.js";

const DEFAULT_BUBBLE_API_BASE_URL = "https://moni-29694.bubbleapps.io";
const DEFAULT_BUBBLE_API_VERSION = "version-test";
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CRONOGRAMA_LINHA_TYPE = "cronogramalinha";
const DEFAULT_ATIVIDADE_OBRA_TYPE = "atividadexobra";
const DEFAULT_EVENTO_CRONOGRAMA_TYPE = "eventocronograma";
const DEFAULT_ATIVIDADE_OBRA_DEPENDENCIES_FIELD = "interdependencias MASTER (Atividade x Obra)";
const ATIVIDADE_OBRA_MASTER_FIELD = "Atividade x Obra Master";
const PREVIOUS_ATIVIDADE_OBRA_FIELDS = [
  "responsavel",
  "responsavelFranqueado",
  "sortOcorrencia",
  "sortTipo",
  "status",
  "statusCompra",
  "statusProjeto",
  "statusOcorrencia",
  "dataInicioExecucao",
  "dataExecucao",
  "dataExecu\u00e7\u00e3o",
  "dataAprovacao",
  "dataReprovacao",
  "observacao"
] as const;

interface BubbleBulkConfig {
  apiToken?: string;
  baseUrl: string;
  version: string;
  batchSize: number;
  cronogramaLinhaType: string;
  atividadeObraType: string;
  eventoCronogramaType: string;
}

interface PersistScheduleOptions {
  requestId?: string | number | object;
  log?: Logger;
}

interface PersistedBulkRecord {
  record: Record<string, unknown>;
  bubbleId: string | null;
}

interface AtividadeObraPatch {
  id: string;
  fields: Record<string, unknown>;
}

interface BubbleListResponse {
  response?: {
    cursor?: number;
    count?: number;
    remaining?: number;
    results?: Record<string, unknown>[];
  };
}

interface BubbleFieldDiagnostic {
  field: string;
  receivedValue: unknown;
  receivedType: string;
  normalizedValue: string | null;
  reason: "missing_or_blank" | "invalid";
}

export class BubbleBulkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BubbleBulkConfigError";
  }
}

export class BubbleBulkPayloadError extends Error {
  constructor(message: string, readonly invalidFields: BubbleFieldDiagnostic[] = []) {
    super(message);
    this.name = "BubbleBulkPayloadError";
  }
}

export class BubbleBulkRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BubbleBulkRequestError";
  }
}

function normalizeAtividadeObraTypeName(value: string): string {
  return value === "atividade_x_obra" ? DEFAULT_ATIVIDADE_OBRA_TYPE : value;
}

function readConfig(): BubbleBulkConfig {
  const rawBatchSize = Number(process.env.BUBBLE_BULK_BATCH_SIZE || DEFAULT_BATCH_SIZE);

  return {
    apiToken: process.env.BUBBLE_API_TOKEN,
    baseUrl: (process.env.BUBBLE_API_BASE_URL || DEFAULT_BUBBLE_API_BASE_URL).replace(/\/+$/g, ""),
    version: process.env.BUBBLE_API_VERSION || DEFAULT_BUBBLE_API_VERSION,
    batchSize: Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? Math.floor(rawBatchSize) : DEFAULT_BATCH_SIZE,
    cronogramaLinhaType: process.env.BUBBLE_CRONOGRAMA_LINHA_TYPE || DEFAULT_CRONOGRAMA_LINHA_TYPE,
    atividadeObraType: normalizeAtividadeObraTypeName(process.env.BUBBLE_ATIVIDADE_OBRA_TYPE || DEFAULT_ATIVIDADE_OBRA_TYPE),
    eventoCronogramaType: process.env.BUBBLE_EVENTO_CRONOGRAMA_TYPE || DEFAULT_EVENTO_CRONOGRAMA_TYPE
  };
}

function recordValue(record: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function rawRecordValue(record: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function externalActivityParts(externalId: string): { activityId: string; cloneIndex: number } | null {
  const current = externalId.match(/^(.*)\|[^|]*\|(\d+)$/);
  if (current) {
    return {
      activityId: current[1]!,
      cloneIndex: Number(current[2])
    };
  }
  const match = externalId.match(/^(.*)_\d{4}-\d{2}-\d{2}_(\d+)$/);
  if (!match) return null;
  return {
    activityId: match[1]!,
    cloneIndex: Number(match[2])
  };
}

function activityRecordId(record: Record<string, unknown>): string {
  const direct = stringValue(recordValue(record, "atividade", "atividade_id", "activity_id", "atividadeId"));
  if (direct) return direct;
  const external = stringValue(recordValue(record, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  return external ? externalActivityParts(external)?.activityId || "" : "";
}

function activityRecordCloneIndex(record: Record<string, unknown>): number {
  const raw = recordValue(record, "indice_clone", "clone_index", "cloneIndex");
  const explicit = typeof raw === "number" ? raw : Number(stringValue(raw));
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const external = stringValue(recordValue(record, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  return external ? externalActivityParts(external)?.cloneIndex || 1 : 1;
}

function activityLineKey(activityId: string, cloneIndex: number): string {
  return `${activityId}:${cloneIndex}`;
}

function activityLineEquivalentKey(line: ScheduleLine): string {
  return `${line.atividadeId}:${line.ambienteId || ""}:${line.external_index}`;
}

function previousAtividadeObraFields(payload: NormalizedSchedulePayload): Map<string, Record<string, unknown>> {
  const fieldsByLine = new Map<string, Record<string, unknown>>();

  for (const record of payload.atividade_obra_json) {
    const activityId = activityRecordId(record);
    if (!activityId) continue;

    const fields: Record<string, unknown> = {};
    for (const fieldName of PREVIOUS_ATIVIDADE_OBRA_FIELDS) {
      const value = rawRecordValue(record, fieldName);
      if (value !== undefined) fields[fieldName] = value;
    }

    if (Object.keys(fields).length) {
      const equivalentKey = atividadeObraEquivalentKey(record);
      if (equivalentKey) fieldsByLine.set(equivalentKey, fields);
      fieldsByLine.set(activityLineKey(activityId, activityRecordCloneIndex(record)), fields);
    }
  }

  return fieldsByLine;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeBubbleVersion(value: string): string {
  const version = value.replace(/^\/+|\/+$/g, "");
  if (version === "version-test" || version.startsWith("version-")) return version;
  return `version-${version}`;
}

function bubbleId(record: Record<string, unknown> | undefined): string | null {
  return stringValue(recordValue(record, "unique id", "unique_id", "id", "_id"));
}

function versaoCronogramaId(payload: NormalizedSchedulePayload): string | null {
  return stringValue(recordValue(payload as unknown as Record<string, unknown>, "versao_cronograma_unique_id", "versao_cronograma_id", "versaoCronograma", "version_id"));
}

function bubbleApiVersion(payload: NormalizedSchedulePayload): string | null {
  const version = stringValue(recordValue(payload as unknown as Record<string, unknown>, "bubble_api_version", "bubble_version", "version"));
  return version ? normalizeBubbleVersion(version) : null;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function requiredFieldDiagnostic(field: string, rawValue: unknown, normalizedValue: string | null): BubbleFieldDiagnostic | null {
  if (normalizedValue) return null;
  return {
    field,
    receivedValue: rawValue,
    receivedType: valueType(rawValue),
    normalizedValue,
    reason: rawValue === undefined || rawValue === null || rawValue === "" ? "missing_or_blank" : "invalid"
  };
}

function obraId(payload: NormalizedSchedulePayload): string | null {
  return bubbleId(payload.obra_json[0]);
}

function obraNome(obra: ObraPayload | undefined): string | null {
  return stringValue(recordValue(obra, "nome", "name", "nomeObra", "nome_obra"));
}

function iconFromAmbiente(ambiente: ObraAmbientePayload | undefined): string | null {
  const icon = recordValue(ambiente, "icon_image", "icon", "icone", "icon_url", "iconUrl");
  if (typeof icon === "string") return stringValue(icon);
  if (icon && typeof icon === "object") {
    return stringValue(recordValue(icon as Record<string, unknown>, "icon", "url", "image", "src"));
  }
  return null;
}

function ambientesByName(payload: NormalizedSchedulePayload): Map<string, ObraAmbientePayload> {
  const entries = payload.obra_ambiente_json
    .map((ambiente) => [stringValue(recordValue(ambiente, "nome", "name", "nome ambiente")), ambiente] as const)
    .filter((entry): entry is [string, ObraAmbientePayload] => Boolean(entry[0]));

  return new Map(entries);
}

function toBubbleDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00.000Z`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function atividadeObraNomeAtividade(line: ScheduleLine): string {
  const activityName = line.nome_atividade.trim();
  const productName = (line.produto || "").trim();
  if (line.tipo !== "Projeto" || !productName || activityName.includes(productName)) return line.nome_atividade;
  const separator = /[-:]\s*$/.test(activityName) ? " " : " - ";
  return `${activityName}${separator}${productName}`;
}

function activityResponsibleFields(line: ScheduleLine): Record<string, unknown> {
  const responsavel = stringValue(recordValue(line.raw, "responsavel", "respons\u00e1vel"));
  return responsavel ? { responsavel } : {};
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;

  const text = value.trim();
  if (!text) return 0;

  let normalized = text.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(/,/g, "");
  } else if (lastComma >= 0) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function productRecordId(product: ObraAmbienteProdutoPayload): string | null {
  return stringValue(recordValue(product, "id", "unique_id", "unique id"));
}

function productSimpleId(product: ObraAmbienteProdutoPayload): string | null {
  return stringValue(recordValue(product, "produtoId", "produto", "id produto simples"));
}

function valorRaizLineKey(line: ScheduleLine): string {
  return [
    line.tipo,
    line.atividadeId,
    line.obraAmbienteProdutoId || "",
    line.produtoId || ""
  ].join("|");
}

function serviceCopyCounts(lines: ScheduleLine[]): Map<string, number> {
  const copyCounts = new Map<string, number>();
  for (const line of lines) {
    if (line.tipo !== "Servi\u00e7o") continue;
    const key = valorRaizLineKey(line);
    copyCounts.set(key, (copyCounts.get(key) || 0) + 1);
  }
  return copyCounts;
}

function productValues(payload: NormalizedSchedulePayload): { byRecordId: Map<string, number>; byProductId: Map<string, number> } {
  const byRecordId = new Map<string, number>();
  const byProductId = new Map<string, number>();

  for (const product of payload.obra_ambiente_produto_json) {
    const valor = numberValue(recordValue(product, "valor"));
    const recordId = productRecordId(product);
    const productId = productSimpleId(product);
    if (recordId) byRecordId.set(recordId, valor);
    if (productId && !byProductId.has(productId)) byProductId.set(productId, valor);
  }

  return { byRecordId, byProductId };
}

function productValueForLine(line: ScheduleLine, values: { byRecordId: Map<string, number>; byProductId: Map<string, number> }): number {
  const byRecordId = line.obraAmbienteProdutoId ? values.byRecordId.get(line.obraAmbienteProdutoId) : undefined;
  if (byRecordId !== undefined) return byRecordId;
  return line.produtoId ? values.byProductId.get(line.produtoId) ?? 0 : 0;
}

function roundValorRaiz(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function valorRaizForLine(line: ScheduleLine, values: { byRecordId: Map<string, number>; byProductId: Map<string, number> }, copyCounts: Map<string, number>): number {
  const valorProduto = productValueForLine(line, values);
  const percentual = numberValue(recordValue(line.raw, "percentual"));

  if (line.tipo === "Compra") return roundValorRaiz(valorProduto * percentual);
  if (line.tipo === "Servi\u00e7o") return roundValorRaiz(valorProduto * (percentual / (copyCounts.get(valorRaizLineKey(line)) || 1)));
  return 0;
}

function eventType(event: Record<string, unknown>): string | null {
  const type = stringValue(recordValue(event, "type", "tipo"));
  return type ? normalizeEventType(type) : null;
}

function normalizeEventType(type: string): string {
  const types: Record<string, string> = {
    "Adiar início da obra": "work_start_delayed",
    "Adiar inicio da obra": "work_start_delayed",
    "Adiar início da atividade": "activity_start_delayed",
    "Adiar inicio da atividade": "activity_start_delayed",
    "Alterar data da atividade com dependentes": "activity_date_changed_cascade",
    "Alterar data da atividade e dependentes": "activity_date_changed_cascade",
    "Alterar somente data da atividade": "activity_date_changed_only",
    "Alterar data somente desta atividade": "activity_date_changed_only",
    "Paralisar a obra": "from_date_delayed",
    "Inserida nova atividade": "activity_inserted"
  };

  return types[type] || type;
}

function bubbleScheduleEventType(type: string): string {
  const types: Record<string, string> = {
    work_start_delayed: "Adiar início da obra",
    activity_start_delayed: "Adiar início da atividade",
    activity_date_changed_cascade: "Alterar data da atividade com dependentes",
    activity_date_changed_only: "Alterar somente data da atividade",
    from_date_delayed: "Paralisar a obra",
    activity_inserted: "Inserida nova atividade"
  };

  return types[type] || type;
}

function eventDate(event: Record<string, unknown>): string | null {
  return stringValue(recordValue(event, "new_start_date", "dataInicio", "data_inicio", "startDate", "date", "data", "from", "to"));
}

function requestDate(payload: NormalizedSchedulePayload, event: Record<string, unknown>): string | null {
  return stringValue(recordValue(payload as unknown as Record<string, unknown>, "event_date", "request_date", "requisicao_data", "data_requisicao"))
    || stringValue(recordValue(event, "request_date", "requisicao_data", "event_date", "data_requisicao"));
}

function eventDays(event: Record<string, unknown>): number | null {
  const value = recordValue(event, "days", "dias", "duration_days", "durationDays");
  const days = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(days) ? Math.trunc(days) : null;
}

function eventActivityId(event: Record<string, unknown>): string | null {
  const activityId = stringValue(recordValue(event, "atividade_id", "activity_id", "atividade"));
  if (activityId) return activityId;
  const external = stringValue(recordValue(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  if (!external) return null;
  return externalActivityParts(external)?.activityId || external.replace(/_\d{4}-\d{2}-\d{2}_\d+$/, "") || null;
}

function activeEventKey(event: Record<string, unknown>, index: number): string {
  const type = eventType(event) || `event_${index}`;
  if (type === "activity_date_changed_cascade" || type === "activity_date_changed_only") return `${type}:${stringValue(recordValue(event, "id_atividade_obra_externo")) || eventActivityId(event) || index}`;
  if (type === "activity_start_delayed") return `${type}:${eventActivityId(event) || stringValue(recordValue(event, "id_atividade_obra_externo")) || index}`;
  if (type === "work_start_delayed" || type === "from_date_delayed") return type;
  return `${type}:${stringValue(recordValue(event, "_id", "id", "unique id")) || index}`;
}

function scheduleEventOverrideKey(event: Record<string, unknown>): string {
  const type = eventType(event);
  if (type === "work_start_delayed" || type === "from_date_delayed") return "schedule";
  if (type === "activity_start_delayed" || type === "activity_date_changed_cascade" || type === "activity_date_changed_only") {
    const activityId = eventActivityId(event);
    return activityId ? `activity:${activityId}` : "";
  }
  return "";
}

function activeScheduleEvents(payload: NormalizedSchedulePayload): Record<string, unknown>[] {
  const currentEventKeys = new Set(
    payload.events_json
      .map(scheduleEventOverrideKey)
      .filter(Boolean)
  );
  const oldEvents = currentEventKeys.size
    ? payload.events_old.filter((event) => {
      const key = scheduleEventOverrideKey(event);
      return !key || !currentEventKeys.has(key);
    })
    : payload.events_old;

  const activeEvents = new Map<string, Record<string, unknown>>();
  [...oldEvents, ...payload.events_json].forEach((event, index) => {
    activeEvents.set(activeEventKey(event, index), event);
  });
  return [...activeEvents.values()];
}

function ndjson(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function assertBulkBodySucceeded(typeName: string, responseText: string): void {
  if (!responseText.trim()) return;

  const failures: unknown[] = [];
  for (const line of responseText.split(/\r?\n/).filter((item) => item.trim())) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.status === "error" || parsed.success === false) failures.push(parsed);
    } catch {
      return;
    }
  }

  if (failures.length) {
    throw new BubbleBulkRequestError(`Bubble bulk ${typeName} returned ${failures.length} row error(s): ${JSON.stringify(failures.slice(0, 3))}`);
  }
}

function parseBulkCreatedIds(responseText: string, expectedCount: number): (string | null)[] {
  const lines = responseText.split(/\r?\n/).filter((item) => item.trim());
  if (!lines.length) return Array.from({ length: expectedCount }, () => null);

  const ids: (string | null)[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      ids.push(stringValue(parsed.id));
    } catch {
      return Array.from({ length: expectedCount }, () => null);
    }
  }

  /* v8 ignore next -- Bubble normally returns one NDJSON line per created record. */
  while (ids.length < expectedCount) ids.push(null);
  return ids.slice(0, expectedCount);
}

function isMissingAmbienteXObraReference(responseText: string): boolean {
  return responseText.includes("ambiente x obra") && responseText.includes("MISSING_DATA");
}

function omitAmbienteXObra(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.map((record) => {
    const { ["ambiente x obra"]: _ambienteXObra, ...rest } = record;
    return rest;
  });
}

function atividadeObraLookupUrl(config: BubbleBulkConfig, versionId: string, cursor: number): string {
  const constraints = encodeURIComponent(JSON.stringify([
    { key: "versaoCronograma", constraint_type: "equals", value: versionId }
  ]));
  return `${config.baseUrl}/${config.version}/api/1.1/obj/${config.atividadeObraType}?constraints=${constraints}&limit=100&cursor=${cursor}`;
}

async function findExistingAtividadeObraIds(
  versionId: string,
  config: BubbleBulkConfig,
  options: PersistScheduleOptions
): Promise<Map<string, string>> {
  const existingIds = new Map<string, string>();
  let cursor = 0;

  for (;;) {
    const url = atividadeObraLookupUrl(config, versionId, cursor);

    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      cursor
    }, "atividade obra idempotency lookup started");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiToken}`
      }
    });
    const responseText = await response.text();

    if (!response.ok) {
      options.log?.error({
        requestId: options.requestId,
        typeName: config.atividadeObraType,
        url,
        statusCode: response.status,
        responseText
      }, "atividade obra idempotency lookup failed");
      throw new BubbleBulkRequestError(`Bubble atividade obra lookup failed with ${response.status}: ${responseText}`);
    }

    let parsed: BubbleListResponse;
    try {
      parsed = responseText.trim() ? JSON.parse(responseText) as BubbleListResponse : {};
    } catch {
      throw new BubbleBulkRequestError(`Bubble atividade obra lookup returned invalid JSON: ${responseText}`);
    }

    const results = Array.isArray(parsed.response?.results) ? parsed.response.results : [];
    for (const result of results) {
      const externalId = stringValue(recordValue(result, "id_atividade_obra_externo"));
      const id = bubbleId(result);
      if (!externalId || !id) continue;
      if (existingIds.has(externalId)) {
        options.log?.warn({
          requestId: options.requestId,
          typeName: config.atividadeObraType,
          externalId,
          keptId: existingIds.get(externalId),
          duplicateId: id
        }, "duplicate atividade obra external id found during lookup");
        continue;
      }
      existingIds.set(externalId, id);
    }

    const remaining = Number(parsed.response?.remaining || 0);
    const count = Number(parsed.response?.count || results.length);
    const currentCursor = Number(parsed.response?.cursor || cursor);
    if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isFinite(count) || count <= 0) break;
    cursor = currentCursor + count;
  }

  options.log?.info({
    requestId: options.requestId,
    typeName: config.atividadeObraType,
    existingRecordsCount: existingIds.size
  }, "atividade obra idempotency lookup completed");

  return existingIds;
}

function atividadeObraAmbienteXObraId(record: Record<string, unknown>): string {
  return stringValue(recordValue(record, "ambiente x obra", "ambienteXobraId", "ambienteXObraId", "ambienteId", "obraAmbienteId")) || "";
}

function atividadeObraEquivalentKey(record: Record<string, unknown>): string | null {
  const activityId = activityRecordId(record);
  if (!activityId) return null;
  return `${activityId}:${atividadeObraAmbienteXObraId(record)}:${activityRecordCloneIndex(record)}`;
}

export function buildCronogramaLinhaRecords(payload: NormalizedSchedulePayload, lines: ScheduleLine[]): Record<string, unknown>[] {
  const versionId = versaoCronogramaId(payload);
  const currentObraId = obraId(payload);

  if (!versionId || !currentObraId) return [];

  return lines.map((line) => ({
    versao_cronograma: versionId,
    obra: currentObraId,
    id_atividade_obra_externo: line.atividade_obra_id_externo,
    data_programada: toBubbleDate(line.data_programada),
    codigo_dia: line.codigo_d,
    dia_semana: line.dia_semana,
    tipo: line.tipo,
    subtipo_compra: line.subtipo_compra || "",
    nome_atividade: line.nome_atividade,
    equipe: line.equipe || "",
    peso: line.peso,
    ambiente: line.ambiente || "",
    produto: line.produto || "",
    ordem: line.ordem,
    indice_clone: line.clone_index,
    nome_servico_ancora: line.anchor_service_name || "",
    id_atividade_obra_externo_servico_ancora: line.atividadeServicoAncoraExternoId || "",
    dados_brutos_json: JSON.stringify(line)
  }));
}

export function buildAtividadeObraRecords(payload: NormalizedSchedulePayload, lines: ScheduleLine[]): Record<string, unknown>[] {
  const currentObraId = obraId(payload);
  const currentObraNome = obraNome(payload.obra_json[0]) || "";
  const currentAmbientesByName = ambientesByName(payload);
  const versionId = versaoCronogramaId(payload);

  if (!currentObraId || !versionId) return [];

  const previousFieldsByLine = previousAtividadeObraFields(payload);
  const values = productValues(payload);
  const copyCounts = serviceCopyCounts(lines);

  return lines.map((line) => {
    const ambiente = line.ambiente ? currentAmbientesByName.get(line.ambiente) : undefined;
    const previousFields = previousFieldsByLine.get(activityLineEquivalentKey(line))
      || previousFieldsByLine.get(activityLineKey(line.atividadeId, line.clone_index))
      || {};

    return {
      copyDuracao: line.clone_index > 1,
      cronograma: payload.cronograma_unique_id,
      dataFimPrevista: toBubbleDate(line.data_programada),
      dataInicioPrevista: toBubbleDate(line.data_programada),
      duracao: 1,
      equipe: line.equipe || "",
      atividade: line.atividadeId,
      id_atividade_obra_externo: line.atividade_obra_id_externo,
      nomeAtividade: atividadeObraNomeAtividade(line),
      nomeObra: currentObraNome,
      nomeProduto: line.produto || "",
      "Produto (raiz)": line.produtoId || "",
      obra: currentObraId,
      ordemRaiz: line.ordem,
      ordemCronograma: line.ordemCronograma,
      peso: line.peso,
      status: "Não iniciada",
      tipo: line.tipo,
      versaoCronograma: versionId,
      ambiente: line.ambiente || "",
      "ambiente x item composicao": line.ambienteItemComposicaoId || "",
      "ambiente x obra": line.ambienteId || "",
      icon: iconFromAmbiente(ambiente) || "",
      master: false,
      ...previousFields,
      ...activityResponsibleFields(line),
      valorRaiz: valorRaizForLine(line, values, copyCounts)
    };
  });
}

export function buildEventoCronogramaRecords(payload: NormalizedSchedulePayload): Record<string, unknown>[] {
  const versionId = versaoCronogramaId(payload);
  const currentObraId = obraId(payload);
  if (!versionId || !currentObraId) return [];

  return activeScheduleEvents(payload).flatMap((event) => {
    const type = eventType(event);
    if (!type) return [];

    const date = eventDate(event);
    const eventRequestDate = requestDate(payload, event);
    const record: Record<string, unknown> = {
      atividade: eventActivityId(event) || "",
      cronograma: payload.cronograma_unique_id,
      data: date ? toBubbleDate(date) : "",
      dias: eventDays(event) ?? 0,
      id_atividade_obra_externo: stringValue(recordValue(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id")) || "",
      tipo: bubbleScheduleEventType(type),
      obra: currentObraId,
      requisicao_data: eventRequestDate ? toBubbleDate(eventRequestDate) : "",
      versaoCronograma: versionId
    };

    return [record];
  });
}

function persistedIdByExternalId(persistedRecords: PersistedBulkRecord[]): Map<string, string> {
  const bubbleIdByExternalId = new Map<string, string>();
  for (const persisted of persistedRecords) {
    const externalId = stringValue(persisted.record.id_atividade_obra_externo);
    if (externalId && persisted.bubbleId) bubbleIdByExternalId.set(externalId, persisted.bubbleId);
  }

  return bubbleIdByExternalId;
}

function buildAtividadeObraDependencyPatches(lines: ScheduleLine[], persistedRecords: PersistedBulkRecord[]): AtividadeObraPatch[] {
  const bubbleIdByExternalId = persistedIdByExternalId(persistedRecords);

  return lines
    .filter((line) => line.interdependenciasMasterIds.length)
    .map((line) => {
      const ownBubbleId = bubbleIdByExternalId.get(line.atividade_obra_id_externo);
      const dependencyBubbleIds = line.interdependenciasMasterIds.map((externalId) => bubbleIdByExternalId.get(externalId));
      const missingIds = dependencyBubbleIds.some((id) => !id);
      if (!ownBubbleId || missingIds) {
        throw new BubbleBulkRequestError(`Could not resolve Bubble atividade x obra dependency ids for ${line.atividade_obra_id_externo}`);
      }

      return {
        id: ownBubbleId,
        fields: {
          [DEFAULT_ATIVIDADE_OBRA_DEPENDENCIES_FIELD]: dependencyBubbleIds.filter((id): id is string => Boolean(id))
        }
      };
    });
}

function explicitAtividadeMasterCatalogId(line: ScheduleLine): string | null {
  const explicitMaster = stringValue(recordValue(line.raw, "atividadeMaster"));
  return explicitMaster || null;
}

function catalogDependencyIds(line: ScheduleLine): string[] {
  const rawDependencies = recordValue(line.raw, "interdependenciasMasterIds");
  if (!Array.isArray(rawDependencies)) return [];
  return rawDependencies.map((dependency) => stringValue(dependency)).filter((dependency): dependency is string => Boolean(dependency));
}

function catalogDependencyRoot(
  activityId: string,
  dependenciesByActivityId: Map<string, string[]>,
  explicitMasterByActivityId: Map<string, string>,
  visiting = new Set<string>()
): string {
  const explicit = explicitMasterByActivityId.get(activityId);
  if (explicit) return explicit;
  if (visiting.has(activityId)) return activityId;

  const dependencies = [...(dependenciesByActivityId.get(activityId) || [])].sort();
  if (!dependencies.length) return activityId;

  visiting.add(activityId);
  const root = catalogDependencyRoot(dependencies[0]!, dependenciesByActivityId, explicitMasterByActivityId, visiting);
  visiting.delete(activityId);
  return root;
}

function sameLineContext(a: ScheduleLine, b: ScheduleLine, options: { sameProduct?: boolean } = {}): boolean {
  return (a.ambienteId || "") === (b.ambienteId || "")
    && (!options.sameProduct || (a.produtoId || "") === (b.produtoId || ""));
}

function firstMasterCandidate(lines: ScheduleLine[]): ScheduleLine | undefined {
  return [...lines].sort(compareMasterCandidates)[0];
}

function compareMasterCandidates(a: ScheduleLine, b: ScheduleLine): number {
  return a.ordemCronograma - b.ordemCronograma
    || a.clone_index - b.clone_index
    || a.data_programada.localeCompare(b.data_programada)
    || a.atividadeId.localeCompare(b.atividadeId);
}

function atividadeObraMasterExternalId(
  line: ScheduleLine,
  lines: ScheduleLine[],
  dependenciesByActivityId: Map<string, string[]>,
  explicitMasterByActivityId: Map<string, string>
): string {
  if ((line.tipo === "Compra" || line.tipo === "Projeto") && line.atividadeServicoAncoraExternoId) {
    return line.atividadeServicoAncoraExternoId;
  }

  if ((line.tipo === "Compra" || line.tipo === "Projeto") && line.atividadeServicoAncoraId) {
    const anchor = firstMasterCandidate(lines.filter((candidate) => (
      candidate.atividadeId === line.atividadeServicoAncoraId
      && sameLineContext(candidate, line)
    )));
    if (anchor) return anchor.atividade_obra_id_externo;
  }

  const targetActivityId = line.tipo === "Serviço"
    ? catalogDependencyRoot(line.atividadeId, dependenciesByActivityId, explicitMasterByActivityId)
    : explicitAtividadeMasterCatalogId(line) || line.atividadeId;

  const target = firstMasterCandidate(lines.filter((candidate) => (
    candidate.atividadeId === targetActivityId
    && sameLineContext(candidate, line, { sameProduct: line.tipo === "Serviço" })
  )));

  return (target || firstMasterCandidate(lines.filter((candidate) => (
    candidate.atividadeId === line.atividadeId
    && sameLineContext(candidate, line, { sameProduct: true })
  ))) || line).atividade_obra_id_externo;
}

function buildAtividadeObraMasterPatches(lines: ScheduleLine[], persistedRecords: PersistedBulkRecord[]): AtividadeObraPatch[] {
  const bubbleIdByExternalId = persistedIdByExternalId(persistedRecords);
  const dependenciesByActivityId = new Map<string, string[]>();
  const explicitMasterByActivityId = new Map<string, string>();
  for (const line of lines) {
    if (!dependenciesByActivityId.has(line.atividadeId)) dependenciesByActivityId.set(line.atividadeId, catalogDependencyIds(line));
    const explicitMaster = explicitAtividadeMasterCatalogId(line);
    if (explicitMaster) explicitMasterByActivityId.set(line.atividadeId, explicitMaster);
  }

  return lines.map((line) => {
    const ownBubbleId = bubbleIdByExternalId.get(line.atividade_obra_id_externo);
    const masterExternalId = atividadeObraMasterExternalId(line, lines, dependenciesByActivityId, explicitMasterByActivityId);
    const masterBubbleId = masterExternalId ? bubbleIdByExternalId.get(masterExternalId) : undefined;
    if (!ownBubbleId || !masterBubbleId) {
      throw new BubbleBulkRequestError(`Could not resolve Bubble atividade x obra master ids for ${line.atividade_obra_id_externo}`);
    }

    return {
      id: ownBubbleId,
      fields: {
        [ATIVIDADE_OBRA_MASTER_FIELD]: masterBubbleId,
        master: line.atividade_obra_id_externo === masterExternalId
      }
    };
  });
}

function mergeAtividadeObraPatches(patches: AtividadeObraPatch[]): AtividadeObraPatch[] {
  const fieldsById = new Map<string, Record<string, unknown>>();
  for (const patch of patches) {
    fieldsById.set(patch.id, {
      ...(fieldsById.get(patch.id) || {}),
      ...patch.fields
    });
  }

  return [...fieldsById.entries()].map(([id, fields]) => ({ id, fields }));
}

async function postBulk(typeName: string, records: Record<string, unknown>[], config: BubbleBulkConfig, options: PersistScheduleOptions): Promise<PersistedBulkRecord[]> {
  const persistedRecords: PersistedBulkRecord[] = [];

  for (const [batchIndex, batch] of chunks(records, config.batchSize).entries()) {
    const url = `${config.baseUrl}/${config.version}/api/1.1/obj/${typeName}/bulk`;

    options.log?.info({
      requestId: options.requestId,
      typeName,
      url,
      batchIndex,
      recordsCount: batch.length
    }, "bubble bulk batch started");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "text/plain"
      },
      body: ndjson(batch)
    });

    const responseText = await response.text();
    if (!response.ok) {
      if (
        typeName === config.atividadeObraType
        && isMissingAmbienteXObraReference(responseText)
        && batch.some((record) => record["ambiente x obra"])
      ) {
        options.log?.warn({
          requestId: options.requestId,
          typeName,
          url,
          batchIndex,
          recordsCount: batch.length,
          statusCode: response.status,
          responseText
        }, "retrying atividade obra bulk without ambiente x obra reference");

        const retryResponse = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "text/plain"
          },
          body: ndjson(omitAmbienteXObra(batch))
        });
        const retryResponseText = await retryResponse.text();
        if (retryResponse.ok) {
          assertBulkBodySucceeded(typeName, retryResponseText);
          const createdIds = parseBulkCreatedIds(retryResponseText, batch.length);
          persistedRecords.push(...batch.map((record, index) => ({ record, bubbleId: createdIds[index] || null })));
          options.log?.info({
            requestId: options.requestId,
            typeName,
            url,
            batchIndex,
            recordsCount: batch.length
          }, "bubble bulk batch persisted without ambiente x obra reference");
          continue;
        }
      }

      options.log?.error({
        requestId: options.requestId,
        typeName,
        url,
        batchIndex,
        recordsCount: batch.length,
        statusCode: response.status,
        responseText
      }, "bubble bulk batch failed");
      throw new BubbleBulkRequestError(`Bubble bulk ${typeName} failed with ${response.status}: ${responseText}`);
    }
    assertBulkBodySucceeded(typeName, responseText);
    const createdIds = parseBulkCreatedIds(responseText, batch.length);
    persistedRecords.push(...batch.map((record, index) => ({ record, bubbleId: createdIds[index] || null })));

    options.log?.info({
      requestId: options.requestId,
      typeName,
      url,
      batchIndex,
      recordsCount: batch.length
    }, "bubble bulk batch persisted");
  }

  return persistedRecords;
}

async function patchExistingAtividadeObraRecords(
  updates: { id: string; record: Record<string, unknown> }[],
  config: BubbleBulkConfig,
  options: PersistScheduleOptions
): Promise<PersistedBulkRecord[]> {
  const persistedRecords: PersistedBulkRecord[] = [];

  for (const [index, update] of updates.entries()) {
    const url = `${config.baseUrl}/${config.version}/api/1.1/obj/${config.atividadeObraType}/${encodeURIComponent(update.id)}`;

    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index
    }, "atividade obra idempotent patch started");

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(update.record)
    });
    const responseText = await response.text();

    if (!response.ok) {
      if (isMissingAmbienteXObraReference(responseText) && update.record["ambiente x obra"]) {
        const retryRecord = omitAmbienteXObra([update.record])[0]!;
        const retryResponse = await fetch(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(retryRecord)
        });
        const retryResponseText = await retryResponse.text();
        if (retryResponse.ok) {
          persistedRecords.push({ record: update.record, bubbleId: update.id });
          options.log?.info({
            requestId: options.requestId,
            typeName: config.atividadeObraType,
            url,
            patchIndex: index
          }, "atividade obra idempotent patch persisted without ambiente x obra reference");
          continue;
        }

        options.log?.error({
          requestId: options.requestId,
          typeName: config.atividadeObraType,
          url,
          patchIndex: index,
          statusCode: retryResponse.status,
          responseText: retryResponseText
        }, "atividade obra idempotent patch failed");
        throw new BubbleBulkRequestError(`Bubble atividade obra idempotent patch failed with ${retryResponse.status}: ${retryResponseText}`);
      }

      options.log?.error({
        requestId: options.requestId,
        typeName: config.atividadeObraType,
        url,
        patchIndex: index,
        statusCode: response.status,
        responseText
      }, "atividade obra idempotent patch failed");
      throw new BubbleBulkRequestError(`Bubble atividade obra idempotent patch failed with ${response.status}: ${responseText}`);
    }

    persistedRecords.push({ record: update.record, bubbleId: update.id });
    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index
    }, "atividade obra idempotent patch persisted");
  }

  return persistedRecords;
}

async function upsertAtividadeObraRecords(
  records: Record<string, unknown>[],
  config: BubbleBulkConfig,
  options: PersistScheduleOptions
): Promise<PersistedBulkRecord[]> {
  const versionId = stringValue(recordValue(records[0], "versaoCronograma"));
  if (!versionId) return postBulk(config.atividadeObraType, records, config, options);

  const existingIds = await findExistingAtividadeObraIds(versionId, config, options);
  const updates: { id: string; record: Record<string, unknown> }[] = [];
  const creates: Record<string, unknown>[] = [];

  for (const record of records) {
    const externalId = stringValue(recordValue(record, "id_atividade_obra_externo"));
    const existingId = externalId ? existingIds.get(externalId) : null;
    if (existingId) {
      updates.push({ id: existingId, record });
    } else {
      creates.push(record);
    }
  }

  const updatedRecords = await patchExistingAtividadeObraRecords(updates, config, options);
  const createdRecords = await postBulk(config.atividadeObraType, creates, config, options);
  const persistedByExternalId = new Map<string, PersistedBulkRecord>();

  for (const persisted of [...updatedRecords, ...createdRecords]) {
    const externalId = stringValue(recordValue(persisted.record, "id_atividade_obra_externo"));
    if (externalId) persistedByExternalId.set(externalId, persisted);
  }

  return records.map((record) => {
    const externalId = stringValue(recordValue(record, "id_atividade_obra_externo"));
    return externalId ? persistedByExternalId.get(externalId) || { record, bubbleId: null } : { record, bubbleId: null };
  });
}

async function patchAtividadeObraDependencies(patches: AtividadeObraPatch[], config: BubbleBulkConfig, options: PersistScheduleOptions): Promise<void> {
  for (const [index, patch] of patches.entries()) {
    const url = `${config.baseUrl}/${config.version}/api/1.1/obj/${config.atividadeObraType}/${encodeURIComponent(patch.id)}`;

    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index
    }, "atividade obra dependency patch started");

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(patch.fields)
    });
    const responseText = await response.text();

    if (!response.ok) {
      options.log?.error({
        requestId: options.requestId,
        typeName: config.atividadeObraType,
        url,
        patchIndex: index,
        statusCode: response.status,
        responseText
      }, "atividade obra dependency patch failed");
      throw new BubbleBulkRequestError(`Bubble atividade obra dependency patch failed with ${response.status}: ${responseText}`);
    }

    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index
    }, "atividade obra dependency patch persisted");
  }
}

export async function persistScheduleBulks(payload: NormalizedSchedulePayload, lines: ScheduleLine[], options: PersistScheduleOptions = {}): Promise<void> {
  const requestedBubbleApiVersion = bubbleApiVersion(payload);
  const requestedVersaoCronogramaId = versaoCronogramaId(payload);
  const requestedObraId = obraId(payload);
  const config = { ...readConfig(), version: requestedBubbleApiVersion || DEFAULT_BUBBLE_API_VERSION };
  if (!config.apiToken) {
    throw new BubbleBulkConfigError("BUBBLE_API_TOKEN is required to persist schedule bulks");
  }

  const atividadeObraRecords = buildAtividadeObraRecords(payload, lines);
  const eventoCronogramaRecords = buildEventoCronogramaRecords(payload);

  if (!atividadeObraRecords.length || !requestedBubbleApiVersion) {
    const invalidFields = [
      requiredFieldDiagnostic(
        "bubble_api_version",
        rawRecordValue(payload as unknown as Record<string, unknown>, "bubble_api_version", "bubble_version", "version"),
        requestedBubbleApiVersion
      ),
      requiredFieldDiagnostic(
        "versao_cronograma_unique_id",
        rawRecordValue(payload as unknown as Record<string, unknown>, "versao_cronograma_unique_id", "versao_cronograma_id", "versaoCronograma", "version_id"),
        requestedVersaoCronogramaId
      ),
      requiredFieldDiagnostic(
        "obra_json[0].unique id",
        rawRecordValue(payload.obra_json[0], "unique id", "unique_id", "id", "_id"),
        requestedObraId
      )
    ].filter((field): field is BubbleFieldDiagnostic => Boolean(field));
    const missingFields = [
      requestedBubbleApiVersion ? null : "bubble_api_version",
      requestedVersaoCronogramaId ? null : "versao_cronograma_unique_id",
      requestedObraId ? null : "obra_json[0].unique id"
    ].filter(Boolean);

    options.log?.warn({
      requestId: options.requestId,
      hasBubbleApiVersion: Boolean(requestedBubbleApiVersion),
      hasVersaoCronogramaId: Boolean(requestedVersaoCronogramaId),
      hasObraId: Boolean(requestedObraId),
      linesCount: lines.length,
      missingFields,
      invalidFields
    }, "missing required Bubble ids");

    throw new BubbleBulkPayloadError(`Missing required Bubble id(s): ${missingFields.join(", ")}`, invalidFields);
  }

  const persistedAtividadeObraRecords = await upsertAtividadeObraRecords(atividadeObraRecords, config, options);
  if (eventoCronogramaRecords.length) {
    await postBulk(config.eventoCronogramaType, eventoCronogramaRecords, config, options);
  }
  const postPersistPatches = mergeAtividadeObraPatches([
    ...buildAtividadeObraDependencyPatches(lines, persistedAtividadeObraRecords),
    ...buildAtividadeObraMasterPatches(lines, persistedAtividadeObraRecords)
  ]);
  await patchAtividadeObraDependencies(postPersistPatches, config, options);
}
