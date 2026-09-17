import type { Request, Response } from "express";
import type { Logger } from "pino";
import { ZodError, type ZodIssue } from "zod";
import { BaseStateInvalidError, BubbleBulkConfigError, BubbleBulkPayloadError, BubbleBulkRequestError, persistScheduleBulks, persistScheduleDatePatches, persistScheduleDeltaMotorPatches, StateDriftError } from "../services/bubble-bulk.service.js";
import { isBusinessDay, nextBusinessDay } from "../services/business-days.service.js";
import { normalizePayload, parseSchedulePayload } from "../services/normalize-payload.service.js";
import { buildScheduleAcceptedResponse, buildScheduleErrorResponse } from "../services/response-builder.service.js";
import { sendScheduleWebhook, webhookBaseFields, webhookBubbleApiVersion } from "../services/schedule-webhook.service.js";
import { runScheduleEngine } from "../services/schedule-engine.service.js";
import type { NormalizedActivityType, NormalizedSchedulePayload, ScheduleMode, SchedulePayload } from "../types/payload.types.js";
import type { EngineResult, NormalizedDate, ScheduleLine } from "../types/schedule.types.js";
import { addDays, differenceInCalendarDays, formatDateOnly, parseDateOnly, weekdayName } from "../utils/dates.js";
import { makeId } from "../utils/ids.js";

const RECALCULATE_EVENT_TYPES = new Set([
  "work_start_delayed",
  "activity_start_delayed",
  "activity_date_changed_cascade",
  "activity_date_changed_only",
  "from_date_delayed",
  "activity_inserted"
]);

type ObservedRequest = Request & {
  id?: string | number | object;
  log?: Logger;
};

function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack
    };
  }

  return {
    errorName: typeof error,
    errorMessage: String(error)
  };
}

function scheduleErrorCode(error: unknown): string {
  if (error instanceof BaseStateInvalidError) return "BASE_STATE_INVALID";
  if (error instanceof StateDriftError) return "STATE_DRIFT";
  if (error instanceof ScopeInsufficientError) return "SCOPE_INSUFFICIENT";
  if (error instanceof BubbleBulkPayloadError) return "BUBBLE_BULK_PAYLOAD_ERROR";
  if (error instanceof BubbleBulkConfigError) return "BUBBLE_BULK_CONFIG_ERROR";
  if (error instanceof BubbleBulkRequestError) return "BUBBLE_BULK_REQUEST_ERROR";
  if (error instanceof ZodError) return "INVALID_PAYLOAD";
  return "SCHEDULE_ENGINE_ERROR";
}

function looksLikeHtml(text: string): boolean {
  return /<\s*(?:!doctype|html|head|body|title|div|span|p|br)\b/i.test(text) || /<\/[a-z][^>]*>/i.test(text);
}

function publicScheduleErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unexpected error";
  if (error instanceof BubbleBulkRequestError) {
    if (/cloudflare|error 1015|rate limited|with 429/i.test(error.message)) {
      return "Bubble limitou temporariamente as chamadas do cronograma. Tente novamente em alguns minutos.";
    }
    if (looksLikeHtml(error.message)) {
      return "Bubble retornou uma resposta inesperada ao gravar o cronograma.";
    }
  }
  return error.message;
}

function requestLog(req: ObservedRequest): Logger | undefined {
  /* v8 ignore next -- Express request logs are optional in production wiring. */
  return req.log;
}

function modeFromRequest(req: ObservedRequest, fallback: ScheduleMode): ScheduleMode {
  if (fallback === "recalculate" && String(req.body?.payload_version) === "3") return "recalculate";
  return typeof req.body?.mode === "string" && req.body.mode.trim() ? req.body.mode : fallback;
}

function eventType(event: Record<string, unknown>): string {
  return normalizeEventType(stringValue(field(event, "type", "tipo")));
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

  /* v8 ignore next -- unsupported event types are rejected during recalculate validation. */
  return types[type] || type;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function field(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

class ScopeInsufficientError extends Error {
  constructor(public readonly details: ScopeInsufficientDetails) {
    super("Delta scope is missing required schedule lines");
    this.name = "ScopeInsufficientError";
  }
}

interface ScopeInsufficientDetails {
  missingActivityIds: string[];
  missingExternalIds: string[];
  anchorWouldMoveIds: string[];
  unsupportedEventTypes?: string[];
}

function zodIssuePath(path: Array<string | number>): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === "number") return `${text}[${part}]`;
    return text ? `${text}.${part}` : String(part);
  }, "");
}

function zodIssueMessage(issue: ZodIssue): string {
  const path = zodIssuePath(issue.path);
  if (!path || issue.code === "custom") return issue.message;
  return `${path}: ${issue.message}`;
}

function zodErrorDetails(error: ZodError): Record<string, unknown> {
  return {
    ...error.flatten(),
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.message
    }))
  };
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const numeric = Number(stringValue(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = numberValue(value, Number.NaN);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value: unknown): string {
  return stringValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function snapshotActivityType(value: unknown): NormalizedActivityType {
  const normalized = normalizeText(value);
  if (normalized === "compra") return "Compra";
  if (normalized === "projeto") return "Projeto";
  return "Servi\u00e7o";
}

function purchaseStage(value: unknown): string | null {
  const normalized = normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return null;
  if (normalized.includes("AVISO_ORCAMENTO") || normalized.includes("AVISO_DE_ORCAMENTO")) return "AVISO_ORCAMENTO";
  if (normalized.includes("LIMITE_ORCAMENTO") || normalized.includes("LIMITE_DE_ORCAMENTO")) return "LIMITE_ORCAMENTO";
  if (normalized.includes("LIMITE_COMPRA") || normalized.includes("LIMITE_DE_COMPRA")) return "LIMITE_COMPRA";
  if (normalized.includes("RECEBIMENTO")) return "RECEBIMENTO";
  return null;
}

function isSnapshotRecalculate(payload: SchedulePayload): boolean {
  return payload.mode === "recalculate" && payload.estrutura_inalterada === true;
}

function isDeltaMotorRecalculate(payload: SchedulePayload): boolean {
  return String(payload.payload_version) === "3"
    && scopeType(payload) === "delta_motor";
}

function versionId(payload: SchedulePayload): string {
  return stringValue(field(payload as unknown as Record<string, unknown>, "versao_cronograma_unique_id", "versao_cronograma_id", "versaoCronograma", "version_id"));
}

function explicitObraStartDate(payload: SchedulePayload): string {
  const obra = payload.obra_json[0];
  return obra ? stringValue(field(obra, "dataInicio", "data_inicio", "startDate")) : "";
}

function validateRecalculateContract(mode: ScheduleMode, payload: SchedulePayload): void {
  if (mode !== "recalculate") return;

  const newVersionId = versionId(payload);
  const previousVersionId = stringValue(payload.previous_version_id);
  const issues = [];
  const snapshot = atividadeObraSnapshot(payload);

  if (!newVersionId) {
    issues.push({
      code: "custom" as const,
      path: ["versao_cronograma_unique_id"],
      message: "versao_cronograma_unique_id is required for recalculate and must be the new version id"
    });
  }

  if (!previousVersionId) {
    issues.push({
      code: "custom" as const,
      path: ["previous_version_id"],
      message: "previous_version_id is required for recalculate"
    });
  }

  if (!isDeltaMotorRecalculate(payload) && newVersionId && previousVersionId && newVersionId === previousVersionId) {
    issues.push({
      code: "custom" as const,
      path: ["versao_cronograma_unique_id"],
      message: "versao_cronograma_unique_id must be different from previous_version_id for recalculate"
    });
  }

  if (payload.estrutura_inalterada === true && !isDeltaMotorRecalculate(payload)) {
    const insertedEventIndex = payload.events_json.findIndex((event) => eventType(event) === "activity_inserted");
    if (insertedEventIndex !== -1) {
      issues.push({
        code: "custom" as const,
        path: ["events_json", insertedEventIndex, "type"],
        message: "activity_inserted cannot use estrutura_inalterada=true"
      });
    }

    const hasWorkStartDelay = [...payload.events_old, ...payload.events_json]
      .some((event) => eventType(event) === "work_start_delayed");
    if (hasWorkStartDelay && !explicitObraStartDate(payload)) {
      issues.push({
        code: "custom" as const,
        path: ["obra_json", 0, "dataInicio"],
        message: "work_start_delayed snapshot recalculation requires obra_json[0].dataInicio"
      });
    }

    if (!snapshot.length && activeRecalculateEvents(payload).length) {
      issues.push({
        code: "custom" as const,
        path: ["atividade_obra_snapshot"],
        message: "atividade_obra_snapshot is required when estrutura_inalterada=true"
      });
    }

    snapshot.forEach((record, index) => {
      if (!stringValue(field(record, "unique id", "unique_id", "id", "_id"))) {
        issues.push({
          code: "custom" as const,
          path: ["atividade_obra_snapshot", index, "unique id"],
          message: "snapshot items must include Bubble unique id when estrutura_inalterada=true"
        });
      }
      if (!snapshotRecordExternalId(record)) {
        issues.push({
          code: "custom" as const,
          path: ["atividade_obra_snapshot", index, "id_atividade_obra_externo"],
          message: "snapshot items must include id_atividade_obra_externo when estrutura_inalterada=true"
        });
      }
      if (!snapshotRecordActivityId(record)) {
        issues.push({
          code: "custom" as const,
          path: ["atividade_obra_snapshot", index, "atividade"],
          message: "snapshot items must include atividade when estrutura_inalterada=true"
        });
      }
      if (!snapshotRecordDate(record)) {
        issues.push({
          code: "custom" as const,
          path: ["atividade_obra_snapshot", index, "dataInicioPrevista"],
          message: "snapshot items must include dataInicioPrevista when estrutura_inalterada=true"
        });
      }
    });
  }

  if (issues.length) throw new ZodError(issues);
}

function validateRecalculateEvents(mode: ScheduleMode, events: Record<string, unknown>[], pathRoot = "events_json"): void {
  if (mode !== "recalculate") return;
  const invalidEventIndex = events.findIndex((event) => !eventType(event));
  if (invalidEventIndex === -1) return;

  throw new ZodError([{
    code: "custom",
    path: [pathRoot, invalidEventIndex, "type"],
    message: `${pathRoot} items must include a non-empty type when mode is recalculate`
  }]);
}

function validateRecalculateEventTypes(mode: ScheduleMode, events: Record<string, unknown>[], pathRoot = "events_json"): void {
  if (mode !== "recalculate") return;
  const unsupportedEventIndex = events.findIndex((event) => {
    const type = eventType(event);
    return type && !RECALCULATE_EVENT_TYPES.has(type);
  });
  if (unsupportedEventIndex === -1) return;

  throw new ZodError([{
    code: "custom",
    path: [pathRoot, unsupportedEventIndex, "type"],
    message: `Unsupported recalculate event type: ${eventType(events[unsupportedEventIndex]!)}`
  }]);
}

function eventDate(event: Record<string, unknown>): string {
  return stringValue(field(event, "new_start_date", "dataInicio", "data_inicio", "startDate", "date", "data", "from", "to"));
}

function eventDays(event: Record<string, unknown>): number {
  const value = field(event, "days", "dias", "duration_days", "durationDays");
  const days = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : 0;
}

function eventDateOnly(value: string, payload?: SchedulePayload): string {
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: payload ? stringValue(field(payload as unknown as Record<string, unknown>, "timezone")) || "America/Sao_Paulo" : "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : value;
}

function scopeNewDate(payload: SchedulePayload): string {
  return stringValue(field(payload.scope || {}, "nova_data", "new_start_date", "data"));
}

function requestedRecalculateDate(payload: SchedulePayload, event: Record<string, unknown>): string {
  const sourceDate = isSnapshotRecalculate(payload) && payload.events_json.includes(event) && scopeNewDate(payload)
    ? scopeNewDate(payload)
    : eventDate(event);
  return eventDateOnly(sourceDate, payload);
}

function businessDateOnly(date: string, payload: SchedulePayload): string {
  if (!date) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return formatDateOnly(nextBusinessDay(parseDateOnly(date), payload.dias_trabalho_semana));
}

function recalculatedStartDate(payload: SchedulePayload, event: Record<string, unknown>): string {
  return businessDateOnly(requestedRecalculateDate(payload, event), payload);
}

function activityStartEventActivityId(event: Record<string, unknown>): string {
  const activityId = stringValue(field(event, "atividade_id", "activity_id", "atividade"));
  if (activityId) return activityId;
  const external = stringValue(field(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  return externalActivityParts(external)?.activityId || external.replace(/_\d{4}-\d{2}-\d{2}_\d+$/, "");
}

function isActivityDateChangeEvent(type: string): boolean {
  return type === "activity_start_delayed" || type === "activity_date_changed_cascade" || type === "activity_date_changed_only";
}

function validateRecalculateEventFields(mode: ScheduleMode, events: Record<string, unknown>[], pathRoot = "events_json"): void {
  if (mode !== "recalculate") return;
  const missingWorkStartDateIndex = events.findIndex((event) => {
    const type = eventType(event);
    return (type === "work_start_delayed" || type === "from_date_delayed" || isActivityDateChangeEvent(type)) && !eventDate(event);
  });
  if (missingWorkStartDateIndex !== -1) {
    throw new ZodError([{
      code: "custom",
      path: [pathRoot, missingWorkStartDateIndex, "new_start_date"],
      message: `${eventType(events[missingWorkStartDateIndex]!)} events must include new_start_date`
    }]);
  }

  const missingActivityIdIndex = events.findIndex((event) => isActivityDateChangeEvent(eventType(event)) && !activityStartEventActivityId(event));
  if (missingActivityIdIndex !== -1) {
    throw new ZodError([{
      code: "custom",
      path: [pathRoot, missingActivityIdIndex, "atividade_id"],
      message: `${eventType(events[missingActivityIdIndex]!)} events must include atividade_id`
    }]);
  }
}

function recalculateEventOverrideKey(event: Record<string, unknown>): string {
  const type = eventType(event);
  if (type === "work_start_delayed" || type === "from_date_delayed") return "schedule";
  if (!isActivityDateChangeEvent(type)) return "";

  const activityId = activityStartEventActivityId(event);
  return activityId ? `activity:${activityId}` : "";
}

function activeRecalculateEvents(payload: SchedulePayload): Record<string, unknown>[] {
  // Snapshot dates already include the historical events.
  if (isSnapshotRecalculate(payload)) return payload.events_json;
  const currentEventKeys = new Set(
    payload.events_json
      .map(recalculateEventOverrideKey)
      .filter(Boolean)
  );
  const currentWorkStartResetsTimeline = currentEventKeys.has("schedule")
    && payload.events_json.some((event) => eventType(event) === "work_start_delayed");
  const oldEvents = currentEventKeys.size
    ? payload.events_old.filter((event) => {
      const key = recalculateEventOverrideKey(event);
      if (currentWorkStartResetsTimeline && key.startsWith("activity:")) return false;
      return !key || !currentEventKeys.has(key);
    })
    : payload.events_old;

  return [...oldEvents, ...payload.events_json];
}

function payloadEventDate(payload: SchedulePayload): string {
  return eventDateOnly(stringValue(field(payload as unknown as Record<string, unknown>, "event_date", "request_date", "requisicao_data", "data_requisicao")), payload);
}

function lastEventOfType(events: Record<string, unknown>[], ...types: string[]): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = eventType(events[index]!);
    if (types.includes(type)) return events[index];
  }
  return undefined;
}

function applyRecalculateEvents(payload: SchedulePayload): SchedulePayload {
  const events = activeRecalculateEvents(payload);
  if (payload.mode !== "recalculate" || !events.length) return payload;

  const scheduleStartEvent = lastEventOfType(events, "work_start_delayed", "from_date_delayed");
  const workStartEvent = scheduleStartEvent && eventType(scheduleStartEvent) === "work_start_delayed" ? scheduleStartEvent : undefined;
  const activityStartEvents = events.filter((event) => eventType(event) === "activity_start_delayed");

  const activityStartDateById = new Map(
    activityStartEvents
      .map((event) => {
        return [activityStartEventActivityId(event), recalculatedStartDate(payload, event)] as const;
      })
      .filter(([activityId, date]) => activityId && date)
  );
  const atividades_json = activityStartDateById.size
    ? payload.atividades_json.map((activity) => {
      const activityId = stringValue(field(activity, "id", "unique_id", "unique id"));
      const recalculatedStartDate = activityStartDateById.get(activityId);
      return recalculatedStartDate ? { ...activity, __recalculateStartDate: recalculatedStartDate } : activity;
    })
    : payload.atividades_json;

  if (!workStartEvent) return { ...payload, atividades_json };

  const newStartDate = recalculatedStartDate(payload, workStartEvent);

  return {
    ...payload,
    atividades_json,
    obra_json: [
      {
        ...payload.obra_json[0],
        dataInicio: newStartDate,
        data_inicio: newStartDate,
        startDate: newStartDate
      },
      ...payload.obra_json.slice(1)
    ]
  };
}

function recordDateOnly(record: Record<string, unknown>): string {
  const date = stringValue(field(record, "dataInicioPrevista", "dataFimPrevista", "data_programada", "data", "date"));
  return date ? eventDateOnly(date) : "";
}

function externalActivityParts(externalId: string): { activityId: string; cloneIndex: number } | null {
  const current = externalId.match(/^(.*)\|[^|]*\|(\d+)$/);
  if (current) {
    return {
      activityId: current[1],
      cloneIndex: Number(current[2])
    };
  }
  const match = externalId.match(/^(.*)_\d{4}-\d{2}-\d{2}_(\d+)$/);
  if (!match) return null;
  return {
    activityId: match[1],
    cloneIndex: Number(match[2])
  };
}

function externalActivityDate(externalId: string): string {
  const match = externalId.match(/^.*_(\d{4}-\d{2}-\d{2})_\d+$/);
  return match?.[1] || "";
}

function activityRecordId(record: Record<string, unknown>): string {
  const direct = stringValue(field(record, "atividade", "atividade_id", "activity_id", "atividadeId"));
  if (direct) return direct;
  const external = stringValue(field(record, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  return externalActivityParts(external)?.activityId || "";
}

function activityRecordCloneIndex(record: Record<string, unknown>): number {
  const raw = field(record, "indice_clone", "clone_index", "cloneIndex");
  const explicit = typeof raw === "number" ? raw : Number(stringValue(raw));
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const external = stringValue(field(record, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  /* v8 ignore next -- legacy records without clone data default to the first clone. */
  return externalActivityParts(external)?.cloneIndex || 1;
}

function activityLineKey(activityId: string, cloneIndex: number): string {
  return `${activityId}:${cloneIndex}`;
}

function atividadeObraSnapshot(payload: SchedulePayload): Record<string, unknown>[] {
  if (isSnapshotRecalculate(payload)) return payload.atividade_obra_snapshot || [];
  return payload.atividade_obra_snapshot?.length ? payload.atividade_obra_snapshot : payload.atividade_obra_json;
}

function snapshotRecordExternalId(record: Record<string, unknown>): string {
  return stringValue(field(record, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
}

function snapshotRecordActivityId(record: Record<string, unknown>): string {
  return stringValue(field(record, "atividade", "atividade_id", "activity_id", "atividadeId"));
}

function snapshotRecordDate(record: Record<string, unknown>): string {
  return recordDateOnly(record);
}

function snapshotRecordCloneIndex(record: Record<string, unknown>): number {
  const external = snapshotRecordExternalId(record);
  return externalActivityParts(external)?.cloneIndex || 1;
}

function movableSnapshotStatus(status: unknown): boolean {
  const normalized = normalizeText(status);
  return !normalized || normalized === "nao iniciada" || normalized === "recalculada";
}

function scopeType(payload: SchedulePayload): string {
  return normalizeText(field(payload.scope || {}, "tipo", "type"));
}

function isDeltaScope(payload: SchedulePayload): boolean {
  return scopeType(payload) === "delta";
}

function snapshotScopeRole(record: Record<string, unknown>): string {
  return normalizeText(field(record, "scopeRole", "scope_role", "scope role"));
}

function isSnapshotAnchor(record: Record<string, unknown>): boolean {
  return snapshotScopeRole(record) === "anchor";
}

function lineCanMove(payload: SchedulePayload, line: ScheduleLine): boolean {
  if (!isSnapshotRecalculate(payload)) return true;
  if (isDeltaScope(payload) && isSnapshotAnchor(line.raw)) return false;
  return movableSnapshotStatus(field(line.raw, "status"));
}

function masterDependencyEntries(payload: SchedulePayload): Array<{ activityId: string; deps: string[] }> {
  return (payload.master_dependencies || []).flatMap((record) => {
    const activityId = stringValue(field(record, "atividade", "atividade_id", "activity_id", "id"));
    const rawDeps = field(record, "deps", "dependencias", "dependencies", "interdependenciasMasterIds");
    const deps = Array.isArray(rawDeps) ? rawDeps.map(String).filter(Boolean) : [];
    return activityId ? [{ activityId, deps }] : [];
  });
}

function dependencyIdsByActivity(payload: SchedulePayload): Map<string, string[]> {
  const dependenciesByActivity = new Map<string, string[]>();
  for (const activity of payload.atividades_json) {
    const activityId = stringValue(field(activity, "id", "unique_id", "unique id"));
    const dependencyIds = Array.isArray(activity.interdependenciasMasterIds) ? activity.interdependenciasMasterIds.map(String) : [];
    if (activityId) dependenciesByActivity.set(activityId, dependencyIds);
  }
  for (const entry of masterDependencyEntries(payload)) {
    dependenciesByActivity.set(entry.activityId, entry.deps);
  }
  return dependenciesByActivity;
}

function activityTypesById(payload: SchedulePayload): Map<string, NormalizedActivityType> {
  const typesByActivity = new Map<string, NormalizedActivityType>();
  for (const activity of payload.atividades_json) {
    const activityId = stringValue(field(activity, "id", "unique_id", "unique id"));
    if (activityId) typesByActivity.set(activityId, snapshotActivityType(activity.tipo));
  }
  for (const record of atividadeObraSnapshot(payload)) {
    const activityId = snapshotRecordActivityId(record);
    if (activityId) typesByActivity.set(activityId, snapshotActivityType(field(record, "tipo")));
  }
  for (const anchor of payload.master_anchors || []) {
    const activityId = stringValue(field(anchor, "atividade", "atividade_id", "activity_id", "id"));
    if (activityId) typesByActivity.set(activityId, snapshotActivityType(field(anchor, "tipo")));
  }
  return typesByActivity;
}

function masterAnchorsByActivity(payload: SchedulePayload): Map<string, Record<string, unknown>> {
  const anchorsByActivity = new Map<string, Record<string, unknown>>();
  for (const anchor of payload.master_anchors || []) {
    const activityId = stringValue(field(anchor, "atividade", "atividade_id", "activity_id", "id"));
    if (activityId) anchorsByActivity.set(activityId, anchor);
  }
  return anchorsByActivity;
}

function eventActivityLineKey(event: Record<string, unknown>): string {
  return activityLineKey(activityStartEventActivityId(event), activityRecordCloneIndex(event));
}

function previousActivityDates(payload: SchedulePayload): Map<string, string> {
  const datesByActivity = new Map<string, string>();

  for (const record of atividadeObraSnapshot(payload)) {
    const external = stringValue(field(record, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
    const date = recordDateOnly(record) || externalActivityDate(external);
    if (!date) continue;
    const activityId = activityRecordId(record);
    if (!activityId) continue;
    datesByActivity.set(activityLineKey(activityId, activityRecordCloneIndex(record)), date);
  }

  return datesByActivity;
}

function previousActivityDatesBefore(payload: SchedulePayload, fromDate: string): Map<string, string> {
  const datesByActivity = new Map<string, string>();

  for (const record of atividadeObraSnapshot(payload)) {
    const date = recordDateOnly(record);
    if (!date || date >= fromDate) continue;
    const activityId = activityRecordId(record);
    if (!activityId) continue;
    datesByActivity.set(activityLineKey(activityId, activityRecordCloneIndex(record)), date);
  }

  return datesByActivity;
}

function obraStartDate(payload: SchedulePayload): Date | null {
  const obra = payload.obra_json[0];
  const date = obra ? stringValue(field(obra, "dataInicio", "data_inicio", "startDate")) : "";
  if (date) return parseDateOnly(eventDateOnly(date, payload));

  const snapshotStart = atividadeObraSnapshot(payload)
    .map(recordDateOnly)
    .filter(Boolean)
    .sort()[0];
  return snapshotStart ? parseDateOnly(snapshotStart) : null;
}

function formatCodigoD(daysFromStart: number): string {
  if (daysFromStart > 0) return `D+${daysFromStart}`;
  if (daysFromStart === 0) return "D-0";
  return `D${daysFromStart}`;
}

function withLineDate(line: ScheduleLine, date: string, payload: SchedulePayload): ScheduleLine {
  const parsedDate = parseDateOnly(date);
  const startDate = obraStartDate(payload)!;
  return {
    ...line,
    data_programada: date,
    codigo_d: formatCodigoD(differenceInCalendarDays(startDate, parsedDate) + 1),
    dia_semana: weekdayName(parsedDate)
  };
}

function refreshLineDependencies(payload: SchedulePayload, lines: ScheduleLine[]): ScheduleLine[] {
  const lineIdsByActivity = new Map<string, string[]>();
  for (const line of lines) {
    lineIdsByActivity.set(line.atividadeId, [...(lineIdsByActivity.get(line.atividadeId) || []), line.atividade_obra_id_externo]);
  }

  const dependenciesByActivity = dependencyIdsByActivity(payload);

  return lines.map((line) => ({
    ...line,
    /* v8 ignore next -- generated lines are produced from payload activities. */
    interdependenciasMasterIds: (dependenciesByActivity.get(line.atividadeId) || [])
      /* v8 ignore next -- dependencies point to generated activities in normalized payloads. */
      .flatMap((dependencyId) => lineIdsByActivity.get(dependencyId) || [])
  }));
}

function applyFromDateDelayedRecalculation(payload: SchedulePayload, result: EngineResult): EngineResult {
  const events = activeRecalculateEvents(payload);
  /* v8 ignore next -- non-recalculate and empty-event paths are covered before event-specific post-processing. */
  if (payload.mode !== "recalculate" || !events.length) return result;

  const scheduleStartEvent = lastEventOfType(events, "work_start_delayed", "from_date_delayed");
  if (!scheduleStartEvent || eventType(scheduleStartEvent) !== "from_date_delayed") return result;

  const fromDate = recalculatedStartDate(payload, scheduleStartEvent);
  /* v8 ignore next -- validation requires a date for from_date_delayed before this point. */
  if (!fromDate) return result;

  const previousDates = previousActivityDatesBefore(payload, fromDate);
  const days = eventDays(scheduleStartEvent);
  const lines = result.lines
    .map((line) => {
      if (!lineCanMove(payload, line)) return line;
      const previousDate = previousDates.get(activityLineKey(line.atividadeId, line.clone_index));
      if (previousDate) return withLineDate(line, previousDate, payload);
      if (line.data_programada < fromDate || days === 0) return line;
      const delayedDate = addDays(parseDateOnly(line.data_programada), days);
      return withLineDate(line, formatDateOnly(nextBusinessDay(delayedDate, payload.dias_trabalho_semana)), payload);
    })
    /* v8 ignore next -- deterministic tie-breaker fallback for equal generated dates and orders. */
    .sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);

  return { ...result, lines: refreshLineDependencies(payload, lines) };
}

function purchaseStageRank(stage: string | null): number {
  const ranks: Record<string, number> = {
    AVISO_ORCAMENTO: 1,
    LIMITE_ORCAMENTO: 2,
    LIMITE_COMPRA: 3,
    RECEBIMENTO: 4
  };
  return stage ? ranks[stage] || 99 : 99;
}

function originalLineDate(line: ScheduleLine, previousDates: Map<string, string>): string {
  return previousDates.get(activityLineKey(line.atividadeId, line.clone_index))
    || externalActivityDate(line.atividade_obra_id_externo)
    || line.data_programada;
}

function serviceDependencyClosure(payload: SchedulePayload, rootServiceId: string): Set<string> {
  const dependents = new Set<string>([rootServiceId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const activity of payload.atividades_json) {
      const activityId = stringValue(field(activity, "id", "unique_id", "unique id"));
      if (!activityId || dependents.has(activityId)) continue;
      if (stringValue(activity.tipo) !== "Serviço" && stringValue(activity.tipo) !== "Servico") continue;
      const dependencies = Array.isArray(activity.interdependenciasMasterIds) ? activity.interdependenciasMasterIds : [];
      if (!dependencies.some((dependencyId) => dependents.has(String(dependencyId)))) continue;
      dependents.add(activityId);
      changed = true;
    }
  }

  return dependents;
}

function activityDependencyClosure(payload: SchedulePayload, rootActivityId: string): Set<string> {
  const dependents = new Set<string>([rootActivityId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const activity of payload.atividades_json) {
      const activityId = stringValue(field(activity, "id", "unique_id", "unique id"));
      if (!activityId || dependents.has(activityId)) continue;
      const dependencies = Array.isArray(activity.interdependenciasMasterIds) ? activity.interdependenciasMasterIds : [];
      if (!dependencies.some((dependencyId) => dependents.has(String(dependencyId)))) continue;
      dependents.add(activityId);
      changed = true;
    }
  }

  return dependents;
}

function serviceDependencyClosureForRecalculate(payload: SchedulePayload, rootServiceId: string): Set<string> {
  if (!isSnapshotRecalculate(payload)) return serviceDependencyClosure(payload, rootServiceId);
  const dependents = new Set<string>([rootServiceId]);
  const dependenciesByActivity = dependencyIdsByActivity(payload);
  const typesByActivity = activityTypesById(payload);
  let changed = true;

  while (changed) {
    changed = false;
    for (const activityId of dependenciesByActivity.keys()) {
      if (!activityId || dependents.has(activityId)) continue;
      if (typesByActivity.get(activityId) !== "Servi\u00e7o") continue;
      const dependencies = dependenciesByActivity.get(activityId) || [];
      if (!dependencies.some((dependencyId) => dependents.has(String(dependencyId)))) continue;
      dependents.add(activityId);
      changed = true;
    }
  }

  return dependents;
}

function activityDependencyClosureForRecalculate(payload: SchedulePayload, rootActivityId: string): Set<string> {
  if (!isSnapshotRecalculate(payload)) return activityDependencyClosure(payload, rootActivityId);
  const dependents = new Set<string>([rootActivityId]);
  const dependenciesByActivity = dependencyIdsByActivity(payload);
  let changed = true;

  while (changed) {
    changed = false;
    for (const activityId of dependenciesByActivity.keys()) {
      if (!activityId || dependents.has(activityId)) continue;
      const dependencies = dependenciesByActivity.get(activityId) || [];
      if (!dependencies.some((dependencyId) => dependents.has(String(dependencyId)))) continue;
      dependents.add(activityId);
      changed = true;
    }
  }

  return dependents;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function validateDeltaScope(payload: SchedulePayload): void {
  if (!isDeltaScope(payload)) return;

  const details: ScopeInsufficientDetails = {
    missingActivityIds: [],
    missingExternalIds: [],
    anchorWouldMoveIds: []
  };
  const unsupportedEventTypes = new Set<string>();

  if (!isSnapshotRecalculate(payload)) {
    throw new ScopeInsufficientError({
      ...details,
      unsupportedEventTypes: ["delta scope requires recalculate with estrutura_inalterada=true"]
    });
  }

  const snapshot = atividadeObraSnapshot(payload);
  const recordsByExternalId = new Map<string, Record<string, unknown>>();
  const recordsByActivity = new Map<string, Record<string, unknown>[]>();
  const editableActivityIds = new Set<string>();
  const snapshotActivityIds = new Set<string>();
  const snapshotExternalIds = new Set<string>();

  for (const record of snapshot) {
    const externalId = snapshotRecordExternalId(record);
    const activityId = snapshotRecordActivityId(record);
    if (externalId) {
      recordsByExternalId.set(externalId, record);
      snapshotExternalIds.add(externalId);
    }
    if (activityId) {
      snapshotActivityIds.add(activityId);
      recordsByActivity.set(activityId, [...(recordsByActivity.get(activityId) || []), record]);
      if (!isSnapshotAnchor(record)) editableActivityIds.add(activityId);
    }
  }

  const dependenciesByActivity = dependencyIdsByActivity(payload);

  for (const event of payload.events_json) {
    const type = eventType(event);
    if (type !== "activity_date_changed_cascade" && type !== "activity_date_changed_only") {
      if (type) unsupportedEventTypes.add(type);
      continue;
    }

    const activityId = activityStartEventActivityId(event);
    const externalId = stringValue(field(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
    const targetRecord = externalId ? recordsByExternalId.get(externalId) : undefined;
    const targetIsEditable = targetRecord ? !isSnapshotAnchor(targetRecord) : false;

    if (externalId && (!snapshotExternalIds.has(externalId) || !targetIsEditable)) details.missingExternalIds.push(externalId);
    if (!activityId || !editableActivityIds.has(activityId)) details.missingActivityIds.push(activityId);

    const affectedActivityIds = type === "activity_date_changed_cascade"
      ? activityDependencyClosureForRecalculate(payload, activityId)
      : new Set<string>([activityId]);

    for (const affectedActivityId of affectedActivityIds) {
      if (!affectedActivityId) continue;
      if (!editableActivityIds.has(affectedActivityId)) details.missingActivityIds.push(affectedActivityId);

      for (const record of recordsByActivity.get(affectedActivityId) || []) {
        if (isSnapshotAnchor(record)) details.anchorWouldMoveIds.push(snapshotRecordExternalId(record));
      }

      for (const dependencyId of dependenciesByActivity.get(affectedActivityId) || []) {
        if (!snapshotActivityIds.has(String(dependencyId))) details.missingActivityIds.push(String(dependencyId));
      }
    }
  }

  const normalizedDetails: ScopeInsufficientDetails = {
    missingActivityIds: uniqueSorted(details.missingActivityIds),
    missingExternalIds: uniqueSorted(details.missingExternalIds),
    anchorWouldMoveIds: uniqueSorted(details.anchorWouldMoveIds)
  };
  if (unsupportedEventTypes.size) normalizedDetails.unsupportedEventTypes = uniqueSorted(unsupportedEventTypes);

  if (
    normalizedDetails.missingActivityIds.length
    || normalizedDetails.missingExternalIds.length
    || normalizedDetails.anchorWouldMoveIds.length
    || normalizedDetails.unsupportedEventTypes?.length
  ) {
    throw new ScopeInsufficientError(normalizedDetails);
  }
}

function applyActivityDateChangeRecalculation(payload: SchedulePayload, result: EngineResult): EngineResult {
  if (payload.mode !== "recalculate") return result;

  const events = activeRecalculateEvents(payload).filter((event) => {
    const type = eventType(event);
    return type === "activity_date_changed_cascade" || type === "activity_date_changed_only";
  });
  if (!events.length) return result;

  const previousDates = previousActivityDates(payload);
  let lines = result.lines;

  for (const event of events) {
    const type = eventType(event);
    const activityId = activityStartEventActivityId(event);
    const targetKey = eventActivityLineKey(event);
    const newDate = recalculatedStartDate(payload, event);
    if (!activityId || !newDate) continue;

    const targetLine = lines.find((line) => activityLineKey(line.atividadeId, line.clone_index) === targetKey)
      || lines.find((line) => line.atividadeId === activityId);
    if (!targetLine) continue;

    const originalTargetDate = previousDates.get(activityLineKey(targetLine.atividadeId, targetLine.clone_index))
      || externalActivityDate(stringValue(field(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id")))
      || targetLine.data_programada;
    if (!originalTargetDate) continue;

    const deltaDays = differenceInCalendarDays(parseDateOnly(originalTargetDate), parseDateOnly(newDate));
    const affectedActivityIds = type === "activity_date_changed_cascade"
      ? activityDependencyClosureForRecalculate(payload, targetLine.atividadeId)
      : new Set<string>([targetLine.atividadeId]);
    if (type === "activity_date_changed_cascade" && targetLine.tipo === "Compra" && targetLine.atividadeServicoAncoraId) {
      for (const serviceId of serviceDependencyClosureForRecalculate(payload, targetLine.atividadeServicoAncoraId)) {
        affectedActivityIds.add(serviceId);
      }
    }

    lines = lines.map((line) => {
      if (!lineCanMove(payload, line)) return line;
      const lineKey = activityLineKey(line.atividadeId, line.clone_index);
      if (type === "activity_date_changed_only") {
        return lineKey === targetKey ? withLineDate(line, newDate, payload) : line;
      }

      if (line.atividadeId === targetLine.atividadeId && line.clone_index < targetLine.clone_index) return line;
      if (!affectedActivityIds.has(line.atividadeId)) return line;

      const lineOriginalDate = originalLineDate(line, previousDates);
      if (!lineOriginalDate) return line;
      return withLineDate(line, formatDateOnly(addDays(parseDateOnly(lineOriginalDate), deltaDays)), payload);
    });
  }

  lines = lines
    .sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);

  return { ...result, lines: refreshLineDependencies(payload, lines) };
}

function applyPurchaseChainRecalculation(payload: SchedulePayload, result: EngineResult): EngineResult {
  const cutoffDate = payloadEventDate(payload);
  if (payload.mode !== "recalculate" || !cutoffDate) return result;

  const events = activeRecalculateEvents(payload).filter((event) => eventType(event) === "activity_start_delayed");
  if (!events.length) return result;

  const previousDates = previousActivityDates(payload);
  let lines = result.lines;

  for (const event of events) {
    const activityId = activityStartEventActivityId(event);
    const newDate = recalculatedStartDate(payload, event);
    if (!activityId || !newDate) continue;

    const changedLine = lines.find((line) => line.atividadeId === activityId && line.tipo === "Compra");
    if (!changedLine?.produtoId || !changedLine.atividadeServicoAncoraId) continue;

    const originalChangedDate = previousDates.get(activityLineKey(activityId, changedLine.clone_index))
      || externalActivityDate(stringValue(field(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id")))
      || changedLine.data_programada;
    if (!originalChangedDate) continue;

    const deltaDays = differenceInCalendarDays(parseDateOnly(originalChangedDate), parseDateOnly(newDate));
    if (deltaDays === 0) continue;

    const anchorServiceId = changedLine.atividadeServicoAncoraId;
    const affectedServiceIds = serviceDependencyClosureForRecalculate(payload, anchorServiceId);
    const purchaseChain = lines.filter((line) => (
      line.tipo === "Compra"
      && line.produtoId === changedLine.produtoId
      && line.atividadeServicoAncoraId === anchorServiceId
    ));
    const shiftedPurchaseIds = new Set(
      purchaseChain
        .filter((line) => originalLineDate(line, previousDates) >= cutoffDate)
        .map((line) => line.atividadeId)
    );

    lines = lines.map((line) => {
      if (!lineCanMove(payload, line)) return line;
      const lineOriginalDate = originalLineDate(line, previousDates);
      if (!lineOriginalDate) return line;

      if (line.tipo === "Compra" && line.produtoId === changedLine.produtoId && line.atividadeServicoAncoraId === anchorServiceId) {
        if (lineOriginalDate < cutoffDate) return withLineDate(line, lineOriginalDate, payload);
        return withLineDate(line, formatDateOnly(addDays(parseDateOnly(lineOriginalDate), deltaDays)), payload);
      }

      if (line.tipo === "Serviço" && affectedServiceIds.has(line.atividadeId) && lineOriginalDate >= cutoffDate) {
        return withLineDate(line, formatDateOnly(addDays(parseDateOnly(lineOriginalDate), deltaDays)), payload);
      }

      return line;
    });

    const shiftedPurchaseLines = lines
      .filter((line) => shiftedPurchaseIds.has(line.atividadeId))
      .sort((a, b) => purchaseStageRank(a.subtipo_compra) - purchaseStageRank(b.subtipo_compra));
    for (let index = 1; index < shiftedPurchaseLines.length; index += 1) {
      const previous = shiftedPurchaseLines[index - 1]!;
      const current = shiftedPurchaseLines[index]!;
      if (current.data_programada > previous.data_programada) continue;
      const nextDate = formatDateOnly(addDays(parseDateOnly(previous.data_programada), 1));
      lines = lines.map((line) => line === current ? withLineDate(line, nextDate, payload) : line);
    }
  }

  lines = lines
    .sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);

  return { ...result, lines: refreshLineDependencies(payload, lines) };
}

function snapshotAnchorValue(anchor: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  return anchor ? stringValue(field(anchor, ...keys)) || null : null;
}

function snapshotLineFromRecord(
  record: Record<string, unknown>,
  payload: SchedulePayload,
  anchorsByActivity: Map<string, Record<string, unknown>>
): ScheduleLine | null {
  const externalId = snapshotRecordExternalId(record);
  const activityId = snapshotRecordActivityId(record);
  const date = snapshotRecordDate(record);
  if (!externalId || !activityId || !date) return null;

  const anchor = anchorsByActivity.get(activityId);
  const tipo = snapshotActivityType(field(record, "tipo") || field(anchor || {}, "tipo"));
  const anchorServiceId = snapshotAnchorValue(anchor, "atividadeServicoAncoraId", "atividade_servico_ancora_id", "servico_ancora");
  const produtoId = snapshotAnchorValue(anchor, "produtoId", "produto_id", "produto", "chainId", "purchaseChainId")
    || (tipo === "Compra" ? anchorServiceId : null);
  const cloneIndex = snapshotRecordCloneIndex(record);

  return {
    atividade_obra_id_externo: externalId,
    atividadeId: activityId,
    atividadeNome: activityId,
    atividadeTipo: tipo,
    atividadeServicoAncoraId: anchorServiceId,
    atividadeServicoAncoraNome: null,
    atividadeServicoAncoraExternoId: null,
    obraAmbienteProdutoId: null,
    produtoId,
    ambienteId: stringValue(field(record, "ambiente_id", "ambiente", "ambienteId")) || null,
    ambienteItemComposicaoId: null,
    external_index: cloneIndex,
    data_programada: date,
    codigo_d: formatCodigoD(differenceInCalendarDays(obraStartDate(payload)!, parseDateOnly(date)) + 1),
    dia_semana: weekdayName(parseDateOnly(date)),
    tipo,
    subtipo_compra: tipo === "Compra" ? purchaseStage(field(anchor || {}, "etapaCompra", "etapa_compra")) : null,
    nome_atividade: activityId,
    equipe: stringValue(field(record, "equipe")) || null,
    familia: null,
    nomeFamilia: null,
    projetoId: null,
    tipoProjeto: null,
    localAtuacao: null,
    diasAntecedencia: nullableNumber(field(record, "diasAntecedencia", "dias_antecedencia"))
      ?? nullableNumber(field(anchor || {}, "diasAntecedencia", "dias_antecedencia")),
    projetoResponsavel: null,
    projetoStatus: null,
    peso: numberValue(field(record, "peso"), 1),
    ambiente: stringValue(field(record, "ambiente_id", "ambiente", "ambienteId")) || null,
    produto: null,
    ordem: numberValue(field(record, "ordem"), 0),
    ordemCronograma: numberValue(field(record, "ordemCronograma", "ordem_cronograma", "ordem"), 0),
    clone_index: cloneIndex,
    anchor_service_name: null,
    interdependenciasMasterIds: [],
    raw: record
  };
}

function snapshotEngineResult(payload: SchedulePayload): EngineResult {
  const anchorsByActivity = masterAnchorsByActivity(payload);
  const lines = atividadeObraSnapshot(payload)
    .map((record) => snapshotLineFromRecord(record, payload, anchorsByActivity))
    .filter((line): line is ScheduleLine => Boolean(line));

  return {
    lines: refreshLineDependencies(payload, lines),
    validations: {
      warnings: [],
      errors: []
    }
  };
}

function applyWorkStartSnapshotRecalculation(payload: SchedulePayload, result: EngineResult): EngineResult {
  if (!isSnapshotRecalculate(payload)) return result;
  const event = lastEventOfType(activeRecalculateEvents(payload), "work_start_delayed");
  if (!event) return result;

  const startDate = obraStartDate(payload);
  const newStartDate = recalculatedStartDate(payload, event);
  if (!startDate || !newStartDate) return result;

  const deltaDays = differenceInCalendarDays(startDate, parseDateOnly(newStartDate));
  if (deltaDays === 0) return result;

  const lines = result.lines
    .map((line) => lineCanMove(payload, line)
      ? withLineDate(line, formatDateOnly(addDays(parseDateOnly(line.data_programada), deltaDays)), payload)
      : line)
    .sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index);

  return { ...result, lines: refreshLineDependencies(payload, lines) };
}

function eventTargetExternalId(event: Record<string, unknown>, lines: ScheduleLine[]): string {
  const externalId = stringValue(field(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  if (externalId) return externalId;

  const activityId = activityStartEventActivityId(event);
  if (!activityId) return "";
  return lines.find((line) => line.atividadeId === activityId)?.atividade_obra_id_externo || "";
}

function inputNormalizedDates(payload: SchedulePayload, result: EngineResult): NormalizedDate[] {
  if (payload.mode !== "recalculate") return [];

  return activeRecalculateEvents(payload).flatMap((event) => {
    const requested = requestedRecalculateDate(payload, event);
    const applied = businessDateOnly(requested, payload);
    if (!requested || requested === applied) return [];

    return [{
      id_atividade_obra_externo: eventTargetExternalId(event, result.lines),
      requested,
      applied,
      reason: "non_working_day" as const
    }];
  });
}

function uniqueNormalizedDates(dates: NormalizedDate[]): NormalizedDate[] {
  const byKey = new Map<string, NormalizedDate>();
  for (const date of dates) {
    const key = [
      date.id_atividade_obra_externo,
      date.requested,
      date.applied,
      date.reason
    ].join("|");
    byKey.set(key, date);
  }
  return [...byKey.values()];
}

function normalizeCalculatedLineDates(payload: SchedulePayload, result: EngineResult): EngineResult {
  const normalizedDates: NormalizedDate[] = [];
  const lines = result.lines.map((line) => {
    if (!lineCanMove(payload, line)) return line;

    const parsedDate = parseDateOnly(line.data_programada);
    if (isBusinessDay(parsedDate, payload.dias_trabalho_semana)) return line;

    const applied = formatDateOnly(nextBusinessDay(parsedDate, payload.dias_trabalho_semana));
    normalizedDates.push({
      id_atividade_obra_externo: line.atividade_obra_id_externo,
      requested: line.data_programada,
      applied,
      reason: "non_working_day"
    });
    return withLineDate(line, applied, payload);
  });

  if (!normalizedDates.length) return result;

  return {
    ...result,
    lines: refreshLineDependencies(
      payload,
      lines.sort((a, b) => a.data_programada.localeCompare(b.data_programada) || a.ordem - b.ordem || a.clone_index - b.clone_index)
    ),
    normalizedDates: uniqueNormalizedDates([...(result.normalizedDates || []), ...normalizedDates])
  };
}

function calculateScheduleResult(payload: NormalizedSchedulePayload): EngineResult {
  if (isSnapshotRecalculate(payload) && payload.events_json.length > 1) {
    let currentPayload = payload;
    let result = snapshotEngineResult(payload);
    const normalizedDates: NormalizedDate[] = [];
    for (const event of payload.events_json) {
      const eventPayload = { ...currentPayload, events_old: [], events_json: [event] };
      result = calculateScheduleResult(eventPayload);
      normalizedDates.push(...(result.normalizedDates || []));
      const snapshot = result.lines.map((line) => ({
        ...line.raw,
        dataInicioPrevista: line.data_programada,
        dataFimPrevista: line.data_programada
      }));
      currentPayload = {
        ...currentPayload,
        obra_json: eventType(event) === "work_start_delayed"
          ? applyRecalculateEvents(eventPayload).obra_json
          : currentPayload.obra_json,
        atividade_obra_snapshot: snapshot,
        atividade_obra_json: snapshot
      };
    }
    return { ...result, normalizedDates: uniqueNormalizedDates(normalizedDates) };
  }
  validateDeltaScope(payload);

  const initialResult = isSnapshotRecalculate(payload)
    ? snapshotEngineResult(payload)
    : runScheduleEngine(payload);

  const recalculatedResult = applyFromDateDelayedRecalculation(
    payload,
    applyActivityDateChangeRecalculation(
      payload,
      applyPurchaseChainRecalculation(
        payload,
        applyWorkStartSnapshotRecalculation(payload, initialResult)
      )
    )
  );

  const normalizedInputDates = inputNormalizedDates(payload, recalculatedResult);
  return normalizeCalculatedLineDates(payload, {
    ...recalculatedResult,
    normalizedDates: uniqueNormalizedDates([...(recalculatedResult.normalizedDates || []), ...normalizedInputDates])
  });
}

interface DeltaMotorResult {
  current: EngineResult;
  next: EngineResult;
}

function parseDeltaMotorBasePayload(payload: SchedulePayload): SchedulePayload {
  const rawPayload = payload.base?.payload;
  if (!rawPayload) throw new BaseStateInvalidError("base.payload is required for payload_version 3 delta_motor");

  let parsedRaw: unknown = rawPayload;
  if (typeof rawPayload === "string") {
    try {
      parsedRaw = JSON.parse(rawPayload);
    } catch {
      throw new BaseStateInvalidError("base.payload must be valid JSON");
    }
  }

  const baseMode = typeof payload.base?.mode === "string" && payload.base.mode.trim()
    ? payload.base.mode
    : (typeof (parsedRaw as Record<string, unknown>)?.mode === "string" ? String((parsedRaw as Record<string, unknown>).mode) : "generate");
  return parseSchedulePayload(parsedRaw, baseMode);
}

function eventOrderValue(event: Record<string, unknown>, ...keys: string[]): string {
  const value = stringValue(field(event, ...keys));
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString();
  return eventDateOnly(value);
}

function compareReplayEvents(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return eventOrderValue(a, "requisicao_data", "request_date", "event_date", "data_requisicao")
    .localeCompare(eventOrderValue(b, "requisicao_data", "request_date", "event_date", "data_requisicao"))
    || eventOrderValue(a, "criado_em", "created_at", "Created Date")
      .localeCompare(eventOrderValue(b, "criado_em", "created_at", "Created Date"))
    || stringValue(field(a, "evento_id", "_id", "id", "unique id"))
      .localeCompare(stringValue(field(b, "evento_id", "_id", "id", "unique id")));
}

function replayEvent(event: Record<string, unknown>): Record<string, unknown> {
  return eventType(event) === "activity_start_delayed"
    ? { ...event, type: "activity_date_changed_cascade", tipo: "activity_date_changed_cascade" }
    : event;
}

function lineSnapshotRecord(line: ScheduleLine): Record<string, unknown> {
  return {
    "unique id": line.atividade_obra_id_externo,
    id_atividade_obra_externo: line.atividade_obra_id_externo,
    atividade: line.atividadeId,
    ambiente_id: line.ambienteId || "",
    tipo: line.tipo,
    ordem: line.ordem,
    peso: line.peso,
    equipe: line.equipe || "",
    diasAntecedencia: line.diasAntecedencia ?? 0,
    duracao: 1,
    dataInicioPrevista: line.data_programada,
    dataFimPrevista: line.data_programada,
    status: "Nao iniciada",
    scopeRole: "editable"
  };
}

function snapshotPayloadForReplay(basePayload: NormalizedSchedulePayload, requestPayload: NormalizedSchedulePayload, lines: ScheduleLine[], event: Record<string, unknown>): NormalizedSchedulePayload {
  return normalizePayload({
    ...basePayload,
    payload_version: 2,
    mode: "recalculate",
    estrutura_inalterada: true,
    cronograma_unique_id: requestPayload.cronograma_unique_id,
    versao_cronograma_unique_id: requestPayload.versao_cronograma_unique_id,
    previous_version_id: requestPayload.previous_version_id,
    bubble_api_version: requestPayload.bubble_api_version,
    bubble_version: requestPayload.bubble_version,
    version: requestPayload.version,
    timezone: requestPayload.timezone,
    dias_trabalho_semana: requestPayload.dias_trabalho_semana,
    event_date: requestPayload.event_date,
    request_date: requestPayload.request_date,
    requisicao_data: requestPayload.requisicao_data,
    data_requisicao: requestPayload.data_requisicao,
    obra_json: requestPayload.obra_json.length ? requestPayload.obra_json : basePayload.obra_json,
    atividade_obra_snapshot: lines.map(lineSnapshotRecord),
    atividade_obra_json: lines.map(lineSnapshotRecord),
    events_old: [],
    events_json: [replayEvent(event)]
  });
}

function applyReplayEventToLines(basePayload: NormalizedSchedulePayload, requestPayload: NormalizedSchedulePayload, lines: ScheduleLine[], event: Record<string, unknown>): EngineResult {
  return calculateScheduleResult(snapshotPayloadForReplay(basePayload, requestPayload, lines, event));
}

function calculateDeltaMotorBaseResult(basePayload: NormalizedSchedulePayload): EngineResult {
  return calculateScheduleResult({
    ...basePayload,
    events_old: [],
    events_json: []
  });
}

function calculateDeltaMotorResult(payload: NormalizedSchedulePayload): DeltaMotorResult {
  const basePayloadInput = parseDeltaMotorBasePayload(payload);
  const baseMode = basePayloadInput.mode || "generate";
  const baseForGeneration = normalizePayload(baseMode === "recalculate" && !isSnapshotRecalculate(basePayloadInput)
    ? applyRecalculateEvents(basePayloadInput)
    : basePayloadInput);
  const baseResult = calculateDeltaMotorBaseResult(baseForGeneration);
  const expectedLines = Number(payload.linhas_esperadas);
  if (!Number.isFinite(expectedLines) || expectedLines <= 0) {
    throw new BaseStateInvalidError("linhas_esperadas is required for payload_version 3 delta_motor");
  }
  if (baseResult.lines.length !== Math.trunc(expectedLines)) {
    throw new BaseStateInvalidError(`Base line count mismatch: rebuilt ${baseResult.lines.length}, expected ${Math.trunc(expectedLines)}`);
  }

  const targetExternalId = stringValue(field(payload.scope || {}, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"));
  if (!targetExternalId || !baseResult.lines.some((line) => line.atividade_obra_id_externo === targetExternalId)) {
    throw new BaseStateInvalidError(`Target line not found in rebuilt base: ${targetExternalId || "empty"}`);
  }

  let current = baseResult;
  for (const event of [...payload.events_old].sort(compareReplayEvents)) {
    current = applyReplayEventToLines(baseForGeneration, payload, current.lines, event);
  }

  const currentTarget = current.lines.find((line) => line.atividade_obra_id_externo === targetExternalId);
  const expectedCurrentStart = eventDateOnly(stringValue(field(payload.scope || {}, "data_atual_inicio", "current_start_date")), payload);
  if (expectedCurrentStart && currentTarget?.data_programada !== expectedCurrentStart) {
    throw new StateDriftError(`State drift for ${targetExternalId}: Bubble target has ${expectedCurrentStart}, reconstructed has ${currentTarget?.data_programada || "missing"}`);
  }

  let next = current;
  for (const event of payload.events_json) {
    next = applyReplayEventToLines(baseForGeneration, payload, next.lines, event);
  }

  return { current, next };
}

async function processScheduleJob(
  jobId: string,
  payload: NormalizedSchedulePayload,
  options: { requestId?: string | number | object; log?: Logger } = {}
): Promise<void> {
  const startedAt = new Date();
  let failedStep = "calculate";
  let lastProgress: { progress: 1 | 2 | 3 | 4; progress_percent: number } = { progress: 1, progress_percent: 0 };
  const closedProgressStages = new Set<1 | 2 | 3 | 4>();
  const pendingProcessingWebhooks = new Set<Promise<void>>();
  const baseFields = webhookBaseFields(jobId, payload);
  const webhookOptions = { ...options, bubbleApiVersion: webhookBubbleApiVersion(payload) };
  const processingPayload = (progress: 1 | 2 | 3 | 4, progressPercent: number, message: string) => {
    lastProgress = {
      progress,
      progress_percent: progressPercent
    };
    if (progressPercent === 100) closedProgressStages.add(progress);
    return {
      ...baseFields,
      status: "processing",
      progress,
      progress_percent: progressPercent,
      message
    } as const;
  };
  const sendProcessingProgress = async (progress: 1 | 2 | 3 | 4, progressPercent: number, message: string): Promise<void> => {
    await sendScheduleWebhook(processingPayload(progress, progressPercent, message), webhookOptions);
  };
  const sendProcessingProgressDetached = (progress: 1 | 2 | 3 | 4, progressPercent: number, message: string): void => {
    const sendPromise = sendScheduleWebhook(processingPayload(progress, progressPercent, message), webhookOptions).catch((webhookError) => {
      options.log?.warn({
        requestId: options.requestId,
        jobId,
        ...errorLogFields(webhookError)
      }, "schedule processing webhook failed");
    });
    pendingProcessingWebhooks.add(sendPromise);
    sendPromise.finally(() => pendingProcessingWebhooks.delete(sendPromise));
  };
  const drainProcessingWebhooks = async (): Promise<void> => {
    if (!pendingProcessingWebhooks.size) return;
    await Promise.allSettled([...pendingProcessingWebhooks]);
  };
  const closeProgressStage = async (progress: 1 | 2 | 3 | 4, message: string): Promise<void> => {
    if (closedProgressStages.has(progress)) return;
    await sendProcessingProgress(progress, 100, message);
  };

  try {
    await sendProcessingProgress(1, 0, "Calculando cronograma");
    const deltaMotorResult = isDeltaMotorRecalculate(payload) ? calculateDeltaMotorResult(payload) : null;
    const result = deltaMotorResult?.next || calculateScheduleResult(payload);
    await closeProgressStage(1, "Calculando cronograma");

    options.log?.info({
      requestId: options.requestId,
      jobId,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      linesCount: result.lines.length,
      warningsCount: result.validations.warnings.length,
      errorsCount: result.validations.errors.length
    }, "schedule job calculation finished");

    failedStep = isSnapshotRecalculate(payload) ? "patch_dates" : "bulk_create";
    const stage2Message = isSnapshotRecalculate(payload) ? "Atualizando datas recalculadas" : "Criando registros em bulk";
    const stage3Message = "Atualizando vínculos/dependências";
    await sendProcessingProgress(2, 0, stage2Message);

    const persistenceOptions = {
      requestId: options.requestId,
      log: options.log,
      onStep: (step: "bulk_create" | "patch_dependencies" | "patch_dates") => {
        failedStep = step;
      },
      onProgress: (progress: { progress: 1 | 2 | 3 | 4; progress_percent: number; message: string }) => {
        if (progress.progress_percent === 100) return sendProcessingProgress(progress.progress, progress.progress_percent, progress.message);
        sendProcessingProgressDetached(progress.progress, progress.progress_percent, progress.message);
      }
    };
    const persistenceSummary = deltaMotorResult
      ? await persistScheduleDeltaMotorPatches(payload, deltaMotorResult.current.lines, deltaMotorResult.next.lines, persistenceOptions)
      : isSnapshotRecalculate(payload)
        ? await persistScheduleDatePatches(payload, result.lines, persistenceOptions)
        : await persistScheduleBulks(payload, result.lines, persistenceOptions);

    failedStep = "finalizing";
    await drainProcessingWebhooks();
    await closeProgressStage(2, stage2Message);
    await closeProgressStage(3, stage3Message);
    await sendProcessingProgress(4, 0, "Finalizando cronograma");
    const durationMs = new Date().getTime() - startedAt.getTime();
    await sendScheduleWebhook({
      ...baseFields,
      status: "done",
      progress: 4,
      progress_percent: 100,
      metrics: {
        linesCount: result.lines.length,
        patchedCount: persistenceSummary.patchedCount,
        patchRequestCount: persistenceSummary.patchRequestCount,
        patchBatchCount: persistenceSummary.patchBatchCount,
        eventCount: persistenceSummary.eventCount,
        dependencyPatchCount: persistenceSummary.dependencyPatchCount,
        createdCount: persistenceSummary.createdCount,
        bulkBatchCount: persistenceSummary.bulkBatchCount,
        bulkRetryCount: persistenceSummary.bulkRetryCount,
        dedupDroppedCount: persistenceSummary.dedupDroppedCount,
        durationMs
      },
      normalizedDates: result.normalizedDates || []
    }, webhookOptions);

    options.log?.info({
      requestId: options.requestId,
      jobId,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      linesCount: result.lines.length,
      patchedCount: persistenceSummary.patchedCount,
      patchRequestCount: persistenceSummary.patchRequestCount,
      patchBatchCount: persistenceSummary.patchBatchCount,
      eventCount: persistenceSummary.eventCount,
      dependencyPatchCount: persistenceSummary.dependencyPatchCount,
      createdCount: persistenceSummary.createdCount,
      bulkBatchCount: persistenceSummary.bulkBatchCount,
      bulkRetryCount: persistenceSummary.bulkRetryCount,
      dedupDroppedCount: persistenceSummary.dedupDroppedCount,
      durationMs
    }, "schedule job finished");
  } catch (error) {
    const message = publicScheduleErrorMessage(error);
    options.log?.error({ requestId: options.requestId, jobId, failedStep, ...errorLogFields(error) }, "schedule job failed");
    try {
      await drainProcessingWebhooks();
      await sendScheduleWebhook({
        ...baseFields,
        status: "error",
        progress: lastProgress.progress,
        progress_percent: lastProgress.progress_percent,
        error_code: scheduleErrorCode(error),
        error_message: message,
        error_details: error instanceof ScopeInsufficientError ? error.details : undefined,
        failed_step: failedStep
      }, webhookOptions);
    } catch (webhookError) {
      options.log?.error({ requestId: options.requestId, jobId, ...errorLogFields(webhookError) }, "schedule error webhook failed");
    }
  }
}

async function handleSchedule(req: ObservedRequest, res: Response, mode: ScheduleMode) {
  const log = requestLog(req);

  try {
    const requestMode = modeFromRequest(req, mode);
    const parsedPayload = parseSchedulePayload(req.body, requestMode);
    validateRecalculateEvents(requestMode, parsedPayload.events_json);
    validateRecalculateEvents(requestMode, parsedPayload.events_old, "events_old");
    validateRecalculateEventTypes(requestMode, parsedPayload.events_json);
    validateRecalculateEventTypes(requestMode, parsedPayload.events_old, "events_old");
    validateRecalculateEventFields(requestMode, parsedPayload.events_json);
    validateRecalculateEventFields(requestMode, parsedPayload.events_old, "events_old");
    validateRecalculateContract(requestMode, parsedPayload);
    const payloadInput = { ...parsedPayload, mode: requestMode };
    const payload = normalizePayload(isSnapshotRecalculate(payloadInput) ? payloadInput : applyRecalculateEvents(payloadInput));
    const jobId = makeId("schedule_job");
    const acceptedResponse = buildScheduleAcceptedResponse(jobId, payload.cronograma_unique_id, versionId(payload));

    log?.info({
      requestId: req.id,
      jobId,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      activitiesCount: payload.atividades_json.length,
      eventsCount: payload.events_json.length,
      oldEventsCount: payload.events_old.length
    }, "schedule job accepted");

    res.status(202).json(acceptedResponse);
    setImmediate(() => {
      void processScheduleJob(jobId, payload, { requestId: req.id, log });
    });
  } catch (error) {
    if (error instanceof ZodError) {
      log?.warn({ requestId: req.id, issues: error.issues, ...errorLogFields(error) }, "schedule payload validation failed");
      res.status(400).json(buildScheduleErrorResponse("Invalid payload", "INVALID_PAYLOAD", zodErrorDetails(error), error.issues.map(zodIssueMessage)));
      return;
    }

    if (error instanceof BubbleBulkPayloadError) {
      log?.warn({ requestId: req.id, invalidFields: error.invalidFields, ...errorLogFields(error) }, "schedule bulk payload validation failed");
      res.status(400).json(buildScheduleErrorResponse(error.message, "BUBBLE_BULK_PAYLOAD_ERROR"));
      return;
    }

    if (error instanceof BubbleBulkConfigError || error instanceof BubbleBulkRequestError) {
      const message = publicScheduleErrorMessage(error);
      const statusCode = error instanceof BubbleBulkRequestError ? 502 : 500;
      log?.error({ requestId: req.id, ...errorLogFields(error) }, "schedule bulk persistence failed");
      res.status(statusCode).json(buildScheduleErrorResponse(message, error instanceof BubbleBulkRequestError ? "BUBBLE_BULK_REQUEST_ERROR" : "BUBBLE_BULK_CONFIG_ERROR"));
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected error";
    log?.error({ requestId: req.id, ...errorLogFields(error) }, "schedule calculation failed");
    res.status(500).json(buildScheduleErrorResponse(message, "SCHEDULE_ENGINE_ERROR"));
  }
}

export function generateSchedule(req: Request, res: Response) {
  return handleSchedule(req, res, "generate");
}

export function recalculateSchedule(req: Request, res: Response) {
  return handleSchedule(req, res, "recalculate");
}
