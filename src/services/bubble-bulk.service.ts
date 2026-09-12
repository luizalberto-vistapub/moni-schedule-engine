import type { Logger } from "pino";
import type { NormalizedSchedulePayload, ObraAmbientePayload, ObraAmbienteProdutoPayload, ObraPayload } from "../types/payload.types.js";
import type { ScheduleLine } from "../types/schedule.types.js";
import type { ScheduleJobProgress } from "./schedule-webhook.service.js";
import { formatDateOnly, parseDateOnly } from "../utils/dates.js";
import { nextBusinessDay } from "./business-days.service.js";

const DEFAULT_BUBBLE_API_BASE_URL = "https://moni-29694.bubbleapps.io";
const DEFAULT_BUBBLE_API_VERSION = "version-test";
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_PATCH_CONCURRENCY = 10;
const DEFAULT_PATCH_MAX_RETRIES = 4;
const DEFAULT_PATCH_RETRY_BASE_MS = 250;
const DEFAULT_PATCH_RATE_LIMIT_COOLDOWN_MS = 30000;
const DEFAULT_PATCH_PROGRESS_INTERVAL_MS = 120000;
const MAX_PATCH_CONCURRENCY = 25;
const DEFAULT_CRONOGRAMA_LINHA_TYPE = "cronogramalinha";
const DEFAULT_ATIVIDADE_OBRA_TYPE = "atividadexobra";
const DEFAULT_EVENTO_CRONOGRAMA_TYPE = "eventocronograma";
const DEFAULT_ATIVIDADE_OBRA_DEPENDENCIES_FIELD = "interdependencias MASTER (Atividade x Obra)";
const ATIVIDADE_OBRA_MASTER_FIELD = "Atividade x Obra Master";
const LOCAL_ATUACAO_FIELD = "localatuacao_option_os_localatua__o";
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
  "observacao",
  "localAtuacao"
] as const;

interface BubbleBulkConfig {
  apiToken?: string;
  baseUrl: string;
  version: string;
  batchSize: number;
  cronogramaLinhaType: string;
  atividadeObraType: string;
  eventoCronogramaType: string;
  patchConcurrency: number;
  patchMaxRetries: number;
  patchRetryBaseMs: number;
  patchRateLimitCooldownMs: number;
  patchProgressIntervalMs: number;
}

interface PersistScheduleOptions {
  requestId?: string | number | object;
  log?: Logger;
  onProgress?: (progress: {
    progress: ScheduleJobProgress;
    progress_percent: number;
    message: string;
  }) => void | Promise<void>;
  onStep?: (step: "bulk_create" | "patch_dependencies" | "patch_dates") => void;
  phase2Progress?: PersistencePhaseProgress;
  phase3Progress?: PersistencePhaseProgress;
}

interface PersistencePhaseProgress {
  completed: number;
  report: (completed: number, force?: boolean) => Promise<void>;
}

interface PersistedBulkRecord {
  record: Record<string, unknown>;
  bubbleId: string | null;
}

interface PatchPersistResult {
  persistedRecords: PersistedBulkRecord[];
  requestCount: number;
  peakInFlight: number;
  durationMs: number;
}

interface UpsertPersistResult extends PatchPersistResult {
}

interface PatchResponse {
  ok: boolean;
  status: number;
  text: string;
}

export interface PersistenceSummary {
  patchedCount: number;
  patchRequestCount: number;
  patchBatchCount: number;
  eventCount: number;
  dependencyPatchCount: number;
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

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(stringValue(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
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
    eventoCronogramaType: process.env.BUBBLE_EVENTO_CRONOGRAMA_TYPE || DEFAULT_EVENTO_CRONOGRAMA_TYPE,
    patchConcurrency: boundedInteger(process.env.BUBBLE_PATCH_CONCURRENCY, DEFAULT_PATCH_CONCURRENCY, 1, MAX_PATCH_CONCURRENCY),
    patchMaxRetries: boundedInteger(process.env.BUBBLE_PATCH_MAX_RETRIES, DEFAULT_PATCH_MAX_RETRIES, 0, 10),
    patchRetryBaseMs: boundedInteger(process.env.BUBBLE_PATCH_RETRY_BASE_MS, DEFAULT_PATCH_RETRY_BASE_MS, 0, 60000),
    patchRateLimitCooldownMs: boundedInteger(process.env.BUBBLE_PATCH_RATE_LIMIT_COOLDOWN_MS, DEFAULT_PATCH_RATE_LIMIT_COOLDOWN_MS, 0, 600000),
    patchProgressIntervalMs: boundedInteger(process.env.BUBBLE_PATCH_PROGRESS_INTERVAL_MS, DEFAULT_PATCH_PROGRESS_INTERVAL_MS, 1000, 540000)
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

function localAtuacaoSlug(value: unknown): "indoor" | "outdoor" | null {
  const normalized = stringValue(value)?.toLowerCase();
  if (normalized === "indoor") return "indoor";
  if (normalized === "outdoor") return "outdoor";
  return null;
}

function atividadeObraLocalAtuacaoFields(line: ScheduleLine, previousFields: Record<string, unknown>): Record<string, unknown> {
  const slug = localAtuacaoSlug(recordValue(previousFields, "localAtuacao") ?? line.localAtuacao);
  return slug ? { [LOCAL_ATUACAO_FIELD]: slug } : {};
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

function dateOnly(value: string): string {
  const trimmed = value.trim();
  const textDate = trimmed.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
  if (textDate) {
    const months: Record<string, string> = {
      jan: "01",
      january: "01",
      feb: "02",
      february: "02",
      mar: "03",
      march: "03",
      apr: "04",
      april: "04",
      may: "05",
      jun: "06",
      june: "06",
      jul: "07",
      july: "07",
      aug: "08",
      august: "08",
      sep: "09",
      sept: "09",
      september: "09",
      oct: "10",
      october: "10",
      nov: "11",
      november: "11",
      dec: "12",
      december: "12"
    };
    const month = months[textDate[1]!.toLowerCase()];
    if (month) return `${textDate[3]}-${month}-${textDate[2]!.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  return value;
}

function businessEventDate(payload: NormalizedSchedulePayload, value: string | null): string | null {
  if (!value) return null;
  const date = dateOnly(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value;
  return formatDateOnly(nextBusinessDay(parseDateOnly(date), payload.dias_trabalho_semana));
}

function scopeNewDate(payload: NormalizedSchedulePayload): string | null {
  return stringValue(recordValue(payload.scope as Record<string, unknown> | undefined, "nova_data", "new_start_date", "data"));
}

function scheduleEventDate(payload: NormalizedSchedulePayload, event: Record<string, unknown>): string | null {
  const sourceDate = payload.mode === "recalculate" && payload.estrutura_inalterada === true && payload.events_json.includes(event) && scopeNewDate(payload)
    ? scopeNewDate(payload)
    : eventDate(event);
  return businessEventDate(payload, sourceDate);
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

function createProgressReporter(
  options: PersistScheduleOptions,
  progress: ScheduleJobProgress,
  total: number,
  message: string
): (completed: number) => Promise<void> {
  let lastPercent = 0;

  return async (completed: number, force = false) => {
    if (!options.onProgress || total <= 0) return;

    const percent = Math.min(100, Math.floor((completed / total) * 100));
    const roundedPercent = Math.floor(percent / 10) * 10;
    if (!force && roundedPercent <= lastPercent) return;

    lastPercent = roundedPercent;
    await options.onProgress({
      progress,
      progress_percent: roundedPercent,
      message
    });
  };
}

async function reportPersistenceProgress(progress: PersistencePhaseProgress | undefined, completedCount: number): Promise<void> {
  if (!progress || completedCount <= 0) return;
  progress.completed += completedCount;
  await progress.report(progress.completed);
}

function startProgressHeartbeat(progress: PersistencePhaseProgress | undefined, intervalMs: number): ReturnType<typeof setInterval> | null {
  if (!progress) return null;
  const timer = setInterval(() => {
    void progress.report(progress.completed, true);
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function retryDelayMs(attempt: number, config: BubbleBulkConfig): number {
  return Math.min(10000, config.patchRetryBaseMs * (2 ** attempt));
}

function transportErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function createPatchRateLimitGate(): {
  wait: () => Promise<void>;
  postpone: (cooldownMs: number) => number;
} {
  let resumeAt = 0;

  return {
    async wait(): Promise<void> {
      const waitMs = resumeAt - Date.now();
      if (waitMs > 0) await delay(waitMs);
    },
    postpone(cooldownMs: number): number {
      const nextResumeAt = Date.now() + Math.max(0, cooldownMs);
      resumeAt = Math.max(resumeAt, nextResumeAt);
      return Math.max(0, resumeAt - Date.now());
    }
  };
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function isUnrecognizedLocalAtuacaoField(responseText: string): boolean {
  return responseText.includes(`Unrecognized field: ${LOCAL_ATUACAO_FIELD}`);
}

function omitLocalAtuacao(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.map((record) => {
    const { [LOCAL_ATUACAO_FIELD]: _localAtuacao, ...rest } = record;
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
    const { localAtuacao: _localAtuacao, ...bubblePreviousFields } = previousFields;

    return {
      copyDuracao: line.clone_index > 1,
      cronograma: payload.cronograma_unique_id,
      dataFimPrevista: toBubbleDate(line.data_programada),
      dataInicioPrevista: toBubbleDate(line.data_programada),
      duracao: 1,
      equipe: line.equipe || "",
      familia: line.familia || "",
      nomeFamilia: line.nomeFamilia || line.familia || "",
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
      projeto: line.tipo === "Projeto" ? line.projetoId || "" : "",
      tipoProjeto: line.tipo === "Projeto" ? line.tipoProjeto || "" : "",
      diasAntecedencia: line.tipo === "Projeto" ? line.diasAntecedencia || 0 : 0,
      responsavelFranqueado: line.tipo === "Projeto" ? line.projetoResponsavel || "" : "",
      statusProjeto: line.tipo === "Projeto" ? line.projetoStatus || "" : "",
      status: "Não iniciada",
      tipo: line.tipo,
      versaoCronograma: versionId,
      ambiente: line.ambiente || "",
      "ambiente x item composicao": line.ambienteItemComposicaoId || "",
      "ambiente x obra": line.ambienteId || "",
      icon: iconFromAmbiente(ambiente) || "",
      master: false,
      ...bubblePreviousFields,
      ...activityResponsibleFields(line),
      ...atividadeObraLocalAtuacaoFields(line, previousFields),
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

    const date = scheduleEventDate(payload, event);
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
          await reportPersistenceProgress(options.phase2Progress, batch.length);
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

      if (
        typeName === config.atividadeObraType
        && isUnrecognizedLocalAtuacaoField(responseText)
        && batch.some((record) => Object.prototype.hasOwnProperty.call(record, LOCAL_ATUACAO_FIELD))
      ) {
        options.log?.warn({
          requestId: options.requestId,
          typeName,
          url,
          batchIndex,
          recordsCount: batch.length,
          statusCode: response.status,
          responseText
        }, "retrying atividade obra bulk without local atuacao field");

        const retryResponse = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "text/plain"
          },
          body: ndjson(omitLocalAtuacao(batch))
        });
        const retryResponseText = await retryResponse.text();
        if (retryResponse.ok) {
          assertBulkBodySucceeded(typeName, retryResponseText);
          const createdIds = parseBulkCreatedIds(retryResponseText, batch.length);
          persistedRecords.push(...batch.map((record, index) => ({ record, bubbleId: createdIds[index] || null })));
          await reportPersistenceProgress(options.phase2Progress, batch.length);
          options.log?.info({
            requestId: options.requestId,
            typeName,
            url,
            batchIndex,
            recordsCount: batch.length
          }, "bubble bulk batch persisted without local atuacao field");
          continue;
        }

        options.log?.error({
          requestId: options.requestId,
          typeName,
          url,
          batchIndex,
          recordsCount: batch.length,
          statusCode: retryResponse.status,
          responseText: retryResponseText
        }, "bubble bulk batch failed");
        throw new BubbleBulkRequestError(`Bubble bulk ${typeName} failed with ${retryResponse.status}: ${retryResponseText}`);
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
    await reportPersistenceProgress(options.phase2Progress, batch.length);

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
): Promise<PatchPersistResult> {
  const startedAt = Date.now();
  const results = new Array<PersistedBulkRecord>(updates.length);
  let nextIndex = 0;
  let requestCount = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const rateLimitGate = createPatchRateLimitGate();

  options.log?.info({
    requestId: options.requestId,
    typeName: config.atividadeObraType,
    patchType: "date",
    updatesCount: updates.length,
    configuredConcurrency: config.patchConcurrency,
    maxRetries: config.patchMaxRetries,
    retryBaseMs: config.patchRetryBaseMs,
    rateLimitCooldownMs: config.patchRateLimitCooldownMs,
    progressIntervalMs: config.patchProgressIntervalMs
  }, "atividade obra patch pool started");

  const patchRecord = async (url: string, record: Record<string, unknown>, patchIndex: number): Promise<PatchResponse> => {
    for (let attempt = 0; attempt <= config.patchMaxRetries; attempt += 1) {
      await rateLimitGate.wait();
      requestCount += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      let response: Response | null = null;
      let responseText = "";
      try {
        response = await fetch(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(record)
        });
        responseText = await response.text();
      } catch (error) {
        const errorMessage = transportErrorMessage(error);
        if (attempt >= config.patchMaxRetries) {
          return { ok: false, status: 0, text: `Transport error after ${attempt + 1} attempts: ${errorMessage}` };
        }

        const waitMs = retryDelayMs(attempt, config);
        options.log?.warn({
          requestId: options.requestId,
          typeName: config.atividadeObraType,
          url,
          patchIndex,
          attempt: attempt + 1,
          retryInMs: waitMs,
          errorMessage
        }, "atividade obra patch transport failed; retrying");
        await delay(waitMs);
        continue;
      } finally {
        inFlight -= 1;
      }

      if (!response) continue;
      if (response.status !== 429 || attempt >= config.patchMaxRetries) {
        return { ok: response.ok, status: response.status, text: responseText };
      }

      const waitMs = rateLimitGate.postpone(Math.max(retryDelayMs(attempt, config), config.patchRateLimitCooldownMs));
      options.log?.warn({
        requestId: options.requestId,
        typeName: config.atividadeObraType,
        url,
        patchIndex,
        attempt: attempt + 1,
        retryInMs: waitMs
      }, "atividade obra patch rate limited; pausing patch pool");
    }

    /* v8 ignore next -- loop always returns on the final configured attempt. */
    return { ok: false, status: 429, text: "Rate limited" };
  };

  const patchOne = async (update: { id: string; record: Record<string, unknown> }, index: number): Promise<void> => {
    const url = `${config.baseUrl}/${config.version}/api/1.1/obj/${config.atividadeObraType}/${encodeURIComponent(update.id)}`;

    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index,
      patchConcurrency: config.patchConcurrency
    }, "atividade obra idempotent patch started");

    const response = await patchRecord(url, update.record, index);

    if (!response.ok) {
      if (isMissingAmbienteXObraReference(response.text) && update.record["ambiente x obra"]) {
        const retryRecord = omitAmbienteXObra([update.record])[0]!;
        const retryResponse = await patchRecord(url, retryRecord, index);
        if (retryResponse.ok) {
          results[index] = { record: update.record, bubbleId: update.id };
          await reportPersistenceProgress(options.phase2Progress, 1);
          options.log?.info({
            requestId: options.requestId,
            typeName: config.atividadeObraType,
            url,
            patchIndex: index
          }, "atividade obra idempotent patch persisted without ambiente x obra reference");
          return;
        }

        options.log?.error({
          requestId: options.requestId,
          typeName: config.atividadeObraType,
          url,
          patchIndex: index,
          statusCode: retryResponse.status,
          responseText: retryResponse.text
        }, "atividade obra idempotent patch failed");
        throw new BubbleBulkRequestError(`Bubble atividade obra idempotent patch failed with ${retryResponse.status}: ${retryResponse.text}`);
      }

      if (
        isUnrecognizedLocalAtuacaoField(response.text)
        && Object.prototype.hasOwnProperty.call(update.record, LOCAL_ATUACAO_FIELD)
      ) {
        const retryRecord = omitLocalAtuacao([update.record])[0]!;
        const retryResponse = await patchRecord(url, retryRecord, index);
        if (retryResponse.ok) {
          results[index] = { record: update.record, bubbleId: update.id };
          await reportPersistenceProgress(options.phase2Progress, 1);
          options.log?.info({
            requestId: options.requestId,
            typeName: config.atividadeObraType,
            url,
            patchIndex: index
          }, "atividade obra idempotent patch persisted without local atuacao field");
          return;
        }

        options.log?.error({
          requestId: options.requestId,
          typeName: config.atividadeObraType,
          url,
          patchIndex: index,
          statusCode: retryResponse.status,
          responseText: retryResponse.text
        }, "atividade obra idempotent patch failed");
        throw new BubbleBulkRequestError(`Bubble atividade obra idempotent patch failed with ${retryResponse.status}: ${retryResponse.text}`);
      }

      options.log?.error({
        requestId: options.requestId,
        typeName: config.atividadeObraType,
        url,
        patchIndex: index,
        statusCode: response.status,
        responseText: response.text
      }, "atividade obra idempotent patch failed");
      throw new BubbleBulkRequestError(`Bubble atividade obra idempotent patch failed with ${response.status}: ${response.text}`);
    }

    results[index] = { record: update.record, bubbleId: update.id };
    await reportPersistenceProgress(options.phase2Progress, 1);
    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index
    }, "atividade obra idempotent patch persisted");
  };

  const worker = async (): Promise<void> => {
    while (nextIndex < updates.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await patchOne(updates[currentIndex]!, currentIndex);
    }
  };

  const heartbeat = startProgressHeartbeat(options.phase2Progress, config.patchProgressIntervalMs);
  try {
    await Promise.all(Array.from({ length: Math.min(config.patchConcurrency, updates.length) }, () => worker()));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const durationMs = Date.now() - startedAt;
  options.log?.info({
    requestId: options.requestId,
    typeName: config.atividadeObraType,
    patchType: "date",
    updatesCount: updates.length,
    configuredConcurrency: config.patchConcurrency,
    peakInFlight,
    patchRequestCount: requestCount,
    durationMs
  }, "atividade obra patch pool finished");

  return {
    persistedRecords: results.filter((record): record is PersistedBulkRecord => Boolean(record)),
    requestCount,
    peakInFlight,
    durationMs
  };
}

async function upsertAtividadeObraRecords(
  records: Record<string, unknown>[],
  config: BubbleBulkConfig,
  options: PersistScheduleOptions
): Promise<UpsertPersistResult> {
  const versionId = stringValue(recordValue(records[0], "versaoCronograma"));
  if (!versionId) {
    return {
      persistedRecords: await postBulk(config.atividadeObraType, records, config, options),
      requestCount: 0,
      peakInFlight: 0,
      durationMs: 0
    };
  }

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

  const updatedResult = await patchExistingAtividadeObraRecords(updates, config, options);
  const updatedRecords = updatedResult.persistedRecords;
  const createdRecords = await postBulk(config.atividadeObraType, creates, config, options);
  const persistedByExternalId = new Map<string, PersistedBulkRecord>();

  for (const persisted of [...updatedRecords, ...createdRecords]) {
    const externalId = stringValue(recordValue(persisted.record, "id_atividade_obra_externo"));
    if (externalId) persistedByExternalId.set(externalId, persisted);
  }

  return {
    persistedRecords: records.map((record) => {
      const externalId = stringValue(recordValue(record, "id_atividade_obra_externo"));
      return externalId ? persistedByExternalId.get(externalId) || { record, bubbleId: null } : { record, bubbleId: null };
    }),
    requestCount: updatedResult.requestCount,
    peakInFlight: updatedResult.peakInFlight,
    durationMs: updatedResult.durationMs
  };
}

async function patchAtividadeObraDependencies(patches: AtividadeObraPatch[], config: BubbleBulkConfig, options: PersistScheduleOptions): Promise<PatchPersistResult> {
  const startedAt = Date.now();
  const persistedRecords = new Array<PersistedBulkRecord>(patches.length);
  let nextIndex = 0;
  let requestCount = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const rateLimitGate = createPatchRateLimitGate();

  options.log?.info({
    requestId: options.requestId,
    typeName: config.atividadeObraType,
    patchType: "dependency",
    updatesCount: patches.length,
    configuredConcurrency: config.patchConcurrency,
    maxRetries: config.patchMaxRetries,
    retryBaseMs: config.patchRetryBaseMs,
    rateLimitCooldownMs: config.patchRateLimitCooldownMs,
    progressIntervalMs: config.patchProgressIntervalMs
  }, "atividade obra patch pool started");

  const patchRecord = async (url: string, fields: Record<string, unknown>, patchIndex: number): Promise<PatchResponse> => {
    for (let attempt = 0; attempt <= config.patchMaxRetries; attempt += 1) {
      await rateLimitGate.wait();
      requestCount += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      let response: Response | null = null;
      let responseText = "";
      try {
        response = await fetch(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(fields)
        });
        responseText = await response.text();
      } catch (error) {
        const errorMessage = transportErrorMessage(error);
        if (attempt >= config.patchMaxRetries) {
          return { ok: false, status: 0, text: `Transport error after ${attempt + 1} attempts: ${errorMessage}` };
        }

        const waitMs = retryDelayMs(attempt, config);
        options.log?.warn({
          requestId: options.requestId,
          typeName: config.atividadeObraType,
          url,
          patchIndex,
          attempt: attempt + 1,
          retryInMs: waitMs,
          errorMessage
        }, "atividade obra dependency patch transport failed; retrying");
        await delay(waitMs);
        continue;
      } finally {
        inFlight -= 1;
      }

      if (!response) continue;
      if (response.status !== 429 || attempt >= config.patchMaxRetries) {
        return { ok: response.ok, status: response.status, text: responseText };
      }

      const waitMs = rateLimitGate.postpone(Math.max(retryDelayMs(attempt, config), config.patchRateLimitCooldownMs));
      options.log?.warn({
        requestId: options.requestId,
        typeName: config.atividadeObraType,
        url,
        patchIndex,
        attempt: attempt + 1,
        retryInMs: waitMs
      }, "atividade obra dependency patch rate limited; pausing patch pool");
    }

    /* v8 ignore next -- loop always returns on the final configured attempt. */
    return { ok: false, status: 429, text: "Rate limited" };
  };

  const patchOne = async (patch: AtividadeObraPatch, index: number): Promise<void> => {
    const url = `${config.baseUrl}/${config.version}/api/1.1/obj/${config.atividadeObraType}/${encodeURIComponent(patch.id)}`;

    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index,
      patchConcurrency: config.patchConcurrency
    }, "atividade obra dependency patch started");

    const response = await patchRecord(url, patch.fields, index);

    if (!response.ok) {
      options.log?.error({
        requestId: options.requestId,
        typeName: config.atividadeObraType,
        url,
        patchIndex: index,
        statusCode: response.status,
        responseText: response.text
      }, "atividade obra dependency patch failed");
      throw new BubbleBulkRequestError(`Bubble atividade obra dependency patch failed with ${response.status}: ${response.text}`);
    }

    persistedRecords[index] = { record: patch.fields, bubbleId: patch.id };
    options.log?.info({
      requestId: options.requestId,
      typeName: config.atividadeObraType,
      url,
      patchIndex: index
    }, "atividade obra dependency patch persisted");
    await reportPersistenceProgress(options.phase3Progress, 1);
  };

  const worker = async (): Promise<void> => {
    while (nextIndex < patches.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await patchOne(patches[currentIndex]!, currentIndex);
    }
  };

  const heartbeat = startProgressHeartbeat(options.phase3Progress, config.patchProgressIntervalMs);
  try {
    await Promise.all(Array.from({ length: Math.min(config.patchConcurrency, patches.length) }, () => worker()));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const durationMs = Date.now() - startedAt;
  options.log?.info({
    requestId: options.requestId,
    typeName: config.atividadeObraType,
    patchType: "dependency",
    updatesCount: patches.length,
    configuredConcurrency: config.patchConcurrency,
    peakInFlight,
    patchRequestCount: requestCount,
    durationMs
  }, "atividade obra patch pool finished");

  return {
    persistedRecords: persistedRecords.filter((record): record is PersistedBulkRecord => Boolean(record)),
    requestCount,
    peakInFlight,
    durationMs
  };
}

function atividadeObraSnapshot(payload: NormalizedSchedulePayload): Record<string, unknown>[] {
  if (payload.mode === "recalculate" && payload.estrutura_inalterada === true) return payload.atividade_obra_snapshot || [];
  return payload.atividade_obra_snapshot?.length ? payload.atividade_obra_snapshot : payload.atividade_obra_json;
}

function atividadeObraSnapshotByExternalId(payload: NormalizedSchedulePayload): Map<string, Record<string, unknown>> {
  const recordsByExternalId = new Map<string, Record<string, unknown>>();
  for (const record of atividadeObraSnapshot(payload)) {
    const externalId = stringValue(recordValue(record, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
    if (externalId) recordsByExternalId.set(externalId, record);
  }
  return recordsByExternalId;
}

function snapshotScopeRole(record: Record<string, unknown>): string {
  return stringValue(recordValue(record, "scopeRole", "scope_role", "scope role")) || "";
}

function isScopeAnchor(record: Record<string, unknown>): boolean {
  return snapshotScopeRole(record) === "anchor";
}

function snapshotBubbleId(record: Record<string, unknown>): string | null {
  return bubbleId(record);
}

function snapshotDate(record: Record<string, unknown>, ...keys: string[]): string | null {
  const value = stringValue(recordValue(record, ...keys));
  return value ? toBubbleDate(value) : null;
}

function snapshotNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  const raw = recordValue(record, ...keys);
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(stringValue(raw));
  return Number.isFinite(value) ? value : null;
}

function buildAtividadeObraDatePatchFields(line: ScheduleLine, snapshot: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const nextStart = toBubbleDate(line.data_programada);
  const nextEnd = toBubbleDate(line.data_programada);
  const currentStart = snapshotDate(snapshot, "dataInicioPrevista", "data_inicio_prevista", "data_programada");
  const currentEnd = snapshotDate(snapshot, "dataFimPrevista", "data_fim_prevista", "data_programada");

  if (currentStart !== nextStart) fields.dataInicioPrevista = nextStart;
  if (currentEnd !== nextEnd) fields.dataFimPrevista = nextEnd;

  const nextDuration = snapshotNumber(line.raw, "duracao") ?? 1;
  const currentDuration = snapshotNumber(snapshot, "duracao");
  if (currentDuration !== null && currentDuration !== nextDuration) fields.duracao = nextDuration;

  return fields;
}

export async function persistScheduleDatePatches(payload: NormalizedSchedulePayload, lines: ScheduleLine[], options: PersistScheduleOptions = {}): Promise<PersistenceSummary> {
  const requestedBubbleApiVersion = bubbleApiVersion(payload);
  const config = { ...readConfig(), version: requestedBubbleApiVersion || DEFAULT_BUBBLE_API_VERSION };
  if (!config.apiToken) {
    throw new BubbleBulkConfigError("BUBBLE_API_TOKEN is required to persist schedule bulks");
  }
  if (!requestedBubbleApiVersion) {
    throw new BubbleBulkPayloadError("Missing required Bubble id(s): bubble_api_version", [
      requiredFieldDiagnostic(
        "bubble_api_version",
        rawRecordValue(payload as unknown as Record<string, unknown>, "bubble_api_version", "bubble_version", "version"),
        requestedBubbleApiVersion
      )
    ].filter((field): field is BubbleFieldDiagnostic => Boolean(field)));
  }

  const snapshotByExternalId = atividadeObraSnapshotByExternalId(payload);
  const updates = lines.flatMap((line) => {
    const snapshot = snapshotByExternalId.get(line.atividade_obra_id_externo);
    if (!snapshot) return [];
    if (isScopeAnchor(snapshot)) return [];
    const id = snapshotBubbleId(snapshot);
    if (!id) return [];
    const record = buildAtividadeObraDatePatchFields(line, snapshot);
    return Object.keys(record).length ? [{ id, record }] : [];
  });
  const eventoCronogramaRecords = buildEventoCronogramaRecords(payload);
  const phase2Options: PersistScheduleOptions = {
    ...options,
    phase2Progress: {
      completed: 0,
      report: createProgressReporter(options, 2, updates.length + eventoCronogramaRecords.length, "Atualizando datas recalculadas")
    }
  };

  options.onStep?.("patch_dates");
  const datePatchResult = await patchExistingAtividadeObraRecords(updates, config, phase2Options);
  if (eventoCronogramaRecords.length) {
    await postBulk(config.eventoCronogramaType, eventoCronogramaRecords, config, phase2Options);
  }

  return {
    patchedCount: updates.length,
    patchRequestCount: datePatchResult.requestCount,
    patchBatchCount: 0,
    eventCount: eventoCronogramaRecords.length,
    dependencyPatchCount: 0
  };
}

export async function persistScheduleBulks(payload: NormalizedSchedulePayload, lines: ScheduleLine[], options: PersistScheduleOptions = {}): Promise<PersistenceSummary> {
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

  options.onStep?.("bulk_create");
  const phase2Options: PersistScheduleOptions = {
    ...options,
    phase2Progress: {
      completed: 0,
      report: createProgressReporter(options, 2, atividadeObraRecords.length + eventoCronogramaRecords.length, "Criando registros em bulk")
    }
  };

  const upsertResult = await upsertAtividadeObraRecords(atividadeObraRecords, config, phase2Options);
  const persistedAtividadeObraRecords = upsertResult.persistedRecords;
  if (eventoCronogramaRecords.length) {
    await postBulk(config.eventoCronogramaType, eventoCronogramaRecords, config, phase2Options);
  }
  const postPersistPatches = mergeAtividadeObraPatches([
    ...buildAtividadeObraDependencyPatches(lines, persistedAtividadeObraRecords),
    ...buildAtividadeObraMasterPatches(lines, persistedAtividadeObraRecords)
  ]);
  const phase3Options: PersistScheduleOptions = {
    ...options,
    phase3Progress: {
      completed: 0,
      report: createProgressReporter(options, 3, postPersistPatches.length, "Atualizando vínculos/dependências")
    }
  };
  options.onStep?.("patch_dependencies");
  const dependencyPatchResult = await patchAtividadeObraDependencies(postPersistPatches, config, phase3Options);

  return {
    patchedCount: 0,
    patchRequestCount: upsertResult.requestCount + dependencyPatchResult.requestCount,
    patchBatchCount: 0,
    eventCount: eventoCronogramaRecords.length,
    dependencyPatchCount: postPersistPatches.length
  };
}
