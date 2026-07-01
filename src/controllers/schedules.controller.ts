import type { Request, Response } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { BubbleBulkConfigError, BubbleBulkPayloadError, BubbleBulkRequestError, persistScheduleBulks } from "../services/bubble-bulk.service.js";
import { addBusinessDays } from "../services/business-days.service.js";
import { normalizePayload, payloadSchema } from "../services/normalize-payload.service.js";
import { buildScheduleErrorResponse, buildScheduleResponse } from "../services/response-builder.service.js";
import { runScheduleEngine } from "../services/schedule-engine.service.js";
import type { ScheduleMode, SchedulePayload } from "../types/payload.types.js";
import type { EngineResult, ScheduleLine } from "../types/schedule.types.js";
import { stableLineId } from "../utils/ids.js";
import { addDays, differenceInCalendarDays, formatDateOnly, parseDateOnly, weekdayName } from "../utils/dates.js";

const RECALCULATE_EVENT_TYPES = new Set([
  "work_start_delayed",
  "activity_start_delayed",
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

function versionId(payload: SchedulePayload): string {
  return stringValue(field(payload as unknown as Record<string, unknown>, "versao_cronograma_unique_id", "versao_cronograma_id", "versaoCronograma", "version_id"));
}

function validateRecalculateContract(mode: ScheduleMode, payload: SchedulePayload): void {
  if (mode !== "recalculate") return;

  const newVersionId = versionId(payload);
  const previousVersionId = stringValue(payload.previous_version_id);
  const issues = [];

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
  return stringValue(field(event, "id_atividade_obra_externo", "atividade_obra_external_id", "line_id"))
    .replace(/_\d{4}-\d{2}-\d{2}_\d+$/, "");
}

function validateRecalculateEventFields(mode: ScheduleMode, events: Record<string, unknown>[], pathRoot = "events_json"): void {
  if (mode !== "recalculate") return;
  const missingWorkStartDateIndex = events.findIndex((event) => {
    const type = eventType(event);
    return (type === "work_start_delayed" || type === "from_date_delayed" || type === "activity_start_delayed") && !eventDate(event);
  });
  if (missingWorkStartDateIndex !== -1) {
    throw new ZodError([{
      code: "custom",
      path: [pathRoot, missingWorkStartDateIndex, "new_start_date"],
      message: `${eventType(events[missingWorkStartDateIndex]!)} events must include new_start_date`
    }]);
  }

  const missingActivityIdIndex = events.findIndex((event) => eventType(event) === "activity_start_delayed" && !activityStartEventActivityId(event));
  if (missingActivityIdIndex !== -1) {
    throw new ZodError([{
      code: "custom",
      path: [pathRoot, missingActivityIdIndex, "atividade_id"],
      message: "activity_start_delayed events must include atividade_id"
    }]);
  }
}

function activeRecalculateEvents(payload: SchedulePayload): Record<string, unknown>[] {
  return [...payload.events_old, ...payload.events_json];
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

function previousActivityDates(payload: SchedulePayload): Map<string, string> {
  const datesByActivity = new Map<string, string>();

  for (const record of payload.atividade_obra_json) {
    const date = recordDateOnly(record);
    if (!date) continue;
    const activityId = activityRecordId(record);
    if (!activityId) continue;
    datesByActivity.set(activityLineKey(activityId, activityRecordCloneIndex(record)), date);
  }

  return datesByActivity;
}

function previousActivityDatesBefore(payload: SchedulePayload, fromDate: string): Map<string, string> {
  const datesByActivity = new Map<string, string>();

  for (const record of payload.atividade_obra_json) {
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
  const date = stringValue(field(obra, "dataInicio", "data_inicio", "startDate"));
  /* v8 ignore next -- payload validation requires obra_json[0].dataInicio before scheduling. */
  return date ? parseDateOnly(eventDateOnly(date)) : null;
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
    atividade_obra_id_externo: stableLineId(line.atividadeId, date, line.clone_index),
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

  const dependenciesByActivity = new Map(
    payload.atividades_json.map((activity) => {
      const activityId = stringValue(field(activity, "id", "unique_id", "unique id"));
      /* v8 ignore next -- normalized activities always carry dependency arrays. */
      const dependencyIds = Array.isArray(activity.interdependenciasMasterIds) ? activity.interdependenciasMasterIds : [];
      return [activityId, dependencyIds] as const;
    })
  );

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
    const affectedServiceIds = serviceDependencyClosure(payload, anchorServiceId);
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

async function handleSchedule(req: ObservedRequest, res: Response, mode: ScheduleMode) {
  const log = requestLog(req);
  const startedAt = new Date();

  try {
    const parsedPayload = payloadSchema.parse(req.body);
    const requestMode = modeFromRequest(req, mode);
    validateRecalculateEvents(requestMode, parsedPayload.events_json);
    validateRecalculateEvents(requestMode, parsedPayload.events_old, "events_old");
    validateRecalculateEventTypes(requestMode, parsedPayload.events_json);
    validateRecalculateEventTypes(requestMode, parsedPayload.events_old, "events_old");
    validateRecalculateEventFields(requestMode, parsedPayload.events_json);
    validateRecalculateEventFields(requestMode, parsedPayload.events_old, "events_old");
    validateRecalculateContract(requestMode, parsedPayload);
    const payload = normalizePayload(applyRecalculateEvents({ ...parsedPayload, mode: requestMode }));

    log?.info({
      requestId: req.id,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      activitiesCount: payload.atividades_json.length,
      eventsCount: payload.events_json.length,
      oldEventsCount: payload.events_old.length
    }, "schedule calculation started");

    const result = applyPurchaseChainRecalculation(payload, applyFromDateDelayedRecalculation(payload, runScheduleEngine(payload)));
    const response = buildScheduleResponse(result, startedAt, payload.previous_version_id || null);

    log?.info({
      requestId: req.id,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      linesCount: response.metrics.linesCount,
      durationMs: response.metrics.durationMs,
      warningsCount: response.validations.warnings.length,
      errorsCount: response.validations.errors.length
    }, "schedule calculation finished");

    await persistScheduleBulks(payload, result.lines, { requestId: req.id, log });

    log?.info({
      requestId: req.id,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      linesCount: result.lines.length
    }, "schedule bulk persistence finished");

    res.status(201).json(response);
  } catch (error) {
    if (error instanceof ZodError) {
      log?.warn({ requestId: req.id, issues: error.issues, ...errorLogFields(error) }, "schedule payload validation failed");
      res.status(400).json(buildScheduleErrorResponse("Invalid payload", "INVALID_PAYLOAD", error.flatten(), error.issues.map((issue) => issue.message)));
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
