import type { Request, Response } from "express";
import type { Logger } from "pino";
import { ZodError, type ZodIssue } from "zod";
import { BubbleBulkConfigError, BubbleBulkPayloadError, BubbleBulkRequestError, persistScheduleBulks, persistScheduleDatePatches } from "../services/bubble-bulk.service.js";
import { addBusinessDays } from "../services/business-days.service.js";
import { normalizePayload, parseSchedulePayload } from "../services/normalize-payload.service.js";
import { buildScheduleAcceptedResponse, buildScheduleErrorResponse } from "../services/response-builder.service.js";
import { sendScheduleWebhook, webhookBaseFields, webhookBubbleApiVersion } from "../services/schedule-webhook.service.js";
import { runScheduleEngine } from "../services/schedule-engine.service.js";
import type { NormalizedActivityType, NormalizedSchedulePayload, ScheduleMode, SchedulePayload } from "../types/payload.types.js";
import type { EngineResult, ScheduleLine } from "../types/schedule.types.js";
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
  if (error instanceof BubbleBulkPayloadError) return "BUBBLE_BULK_PAYLOAD_ERROR";
  if (error instanceof BubbleBulkConfigError) return "BUBBLE_BULK_CONFIG_ERROR";
  if (error instanceof BubbleBulkRequestError) return "BUBBLE_BULK_REQUEST_ERROR";
  if (error instanceof ZodError) return "INVALID_PAYLOAD";
  return "SCHEDULE_ENGINE_ERROR";
}

function requestLog(req: ObservedRequest): Logger | undefined {
  /* v8 ignore next -- Express request logs are optional in production wiring. */
  return req.log;
}

function modeFromRequest(req: ObservedRequest, fallback: ScheduleMode): ScheduleMode {
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

function versionId(payload: SchedulePayload): string {
  return stringValue(field(payload as unknown as Record<string, unknown>, "versao_cronograma_unique_id", "versao_cronograma_id", "versaoCronograma", "version_id"));
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

  if (newVersionId && previousVersionId && newVersionId === previousVersionId) {
    issues.push({
      code: "custom" as const,
      path: ["versao_cronograma_unique_id"],
      message: "versao_cronograma_unique_id must be different from previous_version_id for recalculate"
    });
  }

  if (payload.estrutura_inalterada === true) {
    const insertedEventIndex = payload.events_json.findIndex((event) => eventType(event) === "activity_inserted");
    if (insertedEventIndex !== -1) {
      issues.push({
        code: "custom" as const,
        path: ["events_json", insertedEventIndex, "type"],
        message: "activity_inserted cannot use estrutura_inalterada=true"
      });
    }

    if (!snapshot.length) {
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

function eventDateOnly(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recalculatedStartDate(event: Record<string, unknown>): string {
  return eventDateOnly(eventDate(event));
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
  const currentEventKeys = new Set(
    payload.events_json
      .map(recalculateEventOverrideKey)
      .filter(Boolean)
  );
  const oldEvents = currentEventKeys.size
    ? payload.events_old.filter((event) => {
      const key = recalculateEventOverrideKey(event);
      return !key || !currentEventKeys.has(key);
    })
    : payload.events_old;

  return [...oldEvents, ...payload.events_json];
}

function payloadEventDate(payload: SchedulePayload): string {
  return eventDateOnly(stringValue(field(payload as unknown as Record<string, unknown>, "event_date", "request_date", "requisicao_data", "data_requisicao")));
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
        return [activityStartEventActivityId(event), eventDateOnly(eventDate(event))] as const;
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

  const newStartDate = recalculatedStartDate(workStartEvent);

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

function lineCanMove(payload: SchedulePayload, line: ScheduleLine): boolean {
  if (!isSnapshotRecalculate(payload)) return true;
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
  if (date) return parseDateOnly(eventDateOnly(date));

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

  const fromDate = eventDateOnly(eventDate(scheduleStartEvent));
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
      return withLineDate(line, formatDateOnly(addBusinessDays(parseDateOnly(line.data_programada), days, payload.dias_trabalho_semana)), payload);
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
    const newDate = recalculatedStartDate(event);
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
    const newDate = recalculatedStartDate(event);
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
  const newStartDate = recalculatedStartDate(event);
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

function calculateScheduleResult(payload: NormalizedSchedulePayload): EngineResult {
  const initialResult = isSnapshotRecalculate(payload)
    ? snapshotEngineResult(payload)
    : runScheduleEngine(payload);

  return applyActivityDateChangeRecalculation(
    payload,
    applyPurchaseChainRecalculation(
      payload,
      applyFromDateDelayedRecalculation(
        payload,
        applyWorkStartSnapshotRecalculation(payload, initialResult)
      )
    )
  );
}

async function processScheduleJob(
  jobId: string,
  payload: NormalizedSchedulePayload,
  options: { requestId?: string | number | object; log?: Logger } = {}
): Promise<void> {
  const startedAt = new Date();
  let failedStep = "calculate";
  let lastProgress: { progress: 2 | 3 | 4; progress_percent: number } = { progress: 2, progress_percent: 0 };
  const baseFields = webhookBaseFields(jobId, payload);
  const webhookOptions = { ...options, bubbleApiVersion: webhookBubbleApiVersion(payload) };

  try {
    const result = calculateScheduleResult(payload);

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
    await sendScheduleWebhook({
      ...baseFields,
      status: "processing",
      progress: 2,
      progress_percent: 0,
      message: isSnapshotRecalculate(payload) ? "Atualizando datas recalculadas" : "Criando registros em bulk"
    }, webhookOptions);

    const persist = isSnapshotRecalculate(payload) ? persistScheduleDatePatches : persistScheduleBulks;
    await persist(payload, result.lines, {
      requestId: options.requestId,
      log: options.log,
      onStep: (step) => {
        failedStep = step;
      },
      onProgress: async (progress) => {
        lastProgress = {
          progress: progress.progress,
          progress_percent: progress.progress_percent
        };
        await sendScheduleWebhook({
          ...baseFields,
          status: "processing",
          ...progress
        }, webhookOptions);
      }
    });

    failedStep = "finalizing";
    const durationMs = new Date().getTime() - startedAt.getTime();
    await sendScheduleWebhook({
      ...baseFields,
      status: "done",
      progress: 4,
      progress_percent: 100,
      metrics: {
        linesCount: result.lines.length,
        durationMs
      }
    }, webhookOptions);

    options.log?.info({
      requestId: options.requestId,
      jobId,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      linesCount: result.lines.length,
      durationMs
    }, "schedule job finished");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    options.log?.error({ requestId: options.requestId, jobId, failedStep, ...errorLogFields(error) }, "schedule job failed");
    try {
      await sendScheduleWebhook({
        ...baseFields,
        status: "error",
        progress: lastProgress.progress,
        progress_percent: lastProgress.progress_percent,
        error_code: scheduleErrorCode(error),
        error_message: message,
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
      const message = error.message;
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
