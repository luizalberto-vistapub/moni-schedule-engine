import type { Logger } from "pino";
import type { NormalizedSchedulePayload, ObraAmbientePayload, ObraPayload } from "../types/payload.types.js";
import type { ScheduleLine } from "../types/schedule.types.js";

const DEFAULT_BUBBLE_API_BASE_URL = "https://moni-29694.bubbleapps.io";
const DEFAULT_BUBBLE_API_VERSION = "version-test";
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CRONOGRAMA_LINHA_TYPE = "cronogramalinha";
const DEFAULT_ATIVIDADE_OBRA_TYPE = "atividadexobra";
const DEFAULT_EVENTO_CRONOGRAMA_TYPE = "eventocronograma";
const DEFAULT_ATIVIDADE_OBRA_DEPENDENCIES_FIELD = "interdependencias MASTER (Atividade x Obra)";

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

function eventType(event: Record<string, unknown>): string | null {
  return stringValue(recordValue(event, "type", "tipo"));
}

function eventDate(event: Record<string, unknown>): string | null {
  return stringValue(recordValue(event, "new_start_date", "dataInicio", "data_inicio", "startDate", "date", "data", "from", "to"));
}

function eventDays(event: Record<string, unknown>): number | null {
  const value = recordValue(event, "days", "dias", "duration_days", "durationDays");
  const days = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(days) ? Math.trunc(days) : null;
}

function eventActivityId(event: Record<string, unknown>): string | null {
  const activityId = stringValue(recordValue(event, "atividade_id", "activity_id", "atividade"));
  if (activityId) return activityId;
  return stringValue(recordValue(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"))?.replace(/_\d{4}-\d{2}-\d{2}_\d+$/, "") || null;
}

function activeEventKey(event: Record<string, unknown>, index: number): string {
  const type = eventType(event) || `event_${index}`;
  if (type === "activity_start_delayed") return `${type}:${eventActivityId(event) || stringValue(recordValue(event, "id_atividade_obra_externo")) || index}`;
  if (type === "work_start_delayed" || type === "from_date_delayed") return type;
  return `${type}:${stringValue(recordValue(event, "_id", "id", "unique id")) || index}`;
}

function activeScheduleEvents(payload: NormalizedSchedulePayload): Record<string, unknown>[] {
  const activeEvents = new Map<string, Record<string, unknown>>();
  [...payload.events_old, ...payload.events_json].forEach((event, index) => {
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
    dados_brutos_json: JSON.stringify(line)
  }));
}

export function buildAtividadeObraRecords(payload: NormalizedSchedulePayload, lines: ScheduleLine[]): Record<string, unknown>[] {
  const currentObraId = obraId(payload);
  const currentObraNome = obraNome(payload.obra_json[0]) || "";
  const currentAmbientesByName = ambientesByName(payload);
  const versionId = versaoCronogramaId(payload);

  if (!currentObraId || !versionId) return [];

  return lines.map((line) => {
    const ambiente = line.ambiente ? currentAmbientesByName.get(line.ambiente) : undefined;

    return {
      copyDuracao: line.clone_index > 1,
      cronograma: payload.cronograma_unique_id,
      dataFimPrevista: toBubbleDate(line.data_programada),
      dataInicioPrevista: toBubbleDate(line.data_programada),
      duracao: 1,
      equipe: line.equipe || "",
      atividade: line.atividadeId,
      id_atividade_obra_externo: line.atividade_obra_id_externo,
      nomeAtividade: line.nome_atividade,
      nomeObra: currentObraNome,
      nomeProduto: line.produto || "",
      obra: currentObraId,
      ordemRaiz: line.ordem,
      peso: line.peso,
      status: "Não iniciada",
      tipo: line.tipo,
      versaoCronograma: versionId,
      ambiente: line.ambiente || "",
      "ambiente x item composicao": line.ambienteItemComposicaoId || "",
      "ambiente x obra": line.ambienteItemComposicaoId ? "" : line.ambienteId || "",
      icon: iconFromAmbiente(ambiente) || ""
    };
  });
}

export function buildEventoCronogramaRecords(payload: NormalizedSchedulePayload): Record<string, unknown>[] {
  const versionId = versaoCronogramaId(payload);
  if (!versionId) return [];

  return activeScheduleEvents(payload).flatMap((event) => {
    const type = eventType(event);
    if (!type) return [];

    const date = eventDate(event);
    const record: Record<string, unknown> = {
      atividade: eventActivityId(event) || "",
      "atividade x obra": stringValue(recordValue(event, "atividade x obra", "atividade_obra", "atividade_obra_id")) || "",
      cronograma: payload.cronograma_unique_id,
      data: date ? toBubbleDate(date) : "",
      dias: eventDays(event) ?? 0,
      id_atividade_obra_externo: stringValue(recordValue(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id")) || "",
      tipo: type,
      versaoCronograma: versionId
    };

    return [record];
  });
}

function buildAtividadeObraDependencyPatches(lines: ScheduleLine[], persistedRecords: PersistedBulkRecord[]): { id: string; fields: Record<string, unknown> }[] {
  const bubbleIdByExternalId = new Map<string, string>();
  for (const persisted of persistedRecords) {
    const externalId = stringValue(persisted.record.id_atividade_obra_externo);
    if (externalId && persisted.bubbleId) bubbleIdByExternalId.set(externalId, persisted.bubbleId);
  }

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

async function patchAtividadeObraDependencies(patches: { id: string; fields: Record<string, unknown> }[], config: BubbleBulkConfig, options: PersistScheduleOptions): Promise<void> {
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

  const cronogramaLinhaRecords = buildCronogramaLinhaRecords(payload, lines);
  const atividadeObraRecords = buildAtividadeObraRecords(payload, lines);
  const eventoCronogramaRecords = buildEventoCronogramaRecords(payload);

  if (!cronogramaLinhaRecords.length || !atividadeObraRecords.length || !requestedBubbleApiVersion) {
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

  await postBulk(config.cronogramaLinhaType, cronogramaLinhaRecords, config, options);
  const persistedAtividadeObraRecords = await postBulk(config.atividadeObraType, atividadeObraRecords, config, options);
  if (eventoCronogramaRecords.length) {
    await postBulk(config.eventoCronogramaType, eventoCronogramaRecords, config, options);
  }
  const dependencyPatches = buildAtividadeObraDependencyPatches(lines, persistedAtividadeObraRecords);
  await patchAtividadeObraDependencies(dependencyPatches, config, options);
}
