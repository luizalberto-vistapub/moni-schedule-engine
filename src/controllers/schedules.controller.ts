import type { Request, Response } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { BubbleBulkConfigError, BubbleBulkPayloadError, BubbleBulkRequestError, persistScheduleBulks } from "../services/bubble-bulk.service.js";
import { normalizePayload, payloadSchema } from "../services/normalize-payload.service.js";
import { buildScheduleErrorResponse, buildScheduleResponse } from "../services/response-builder.service.js";
import { runScheduleEngine } from "../services/schedule-engine.service.js";
import type { ScheduleMode, SchedulePayload } from "../types/payload.types.js";

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
  return req.log;
}

function modeFromRequest(req: ObservedRequest, fallback: ScheduleMode): ScheduleMode {
  return typeof req.body?.mode === "string" && req.body.mode.trim() ? req.body.mode : fallback;
}

function eventType(event: Record<string, unknown>): string {
  return typeof event.type === "string" ? event.type.trim() : "";
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

function validateRecalculateEvents(mode: ScheduleMode, events: Record<string, unknown>[]): void {
  if (mode !== "recalculate") return;
  const invalidEventIndex = events.findIndex((event) => !eventType(event));
  if (invalidEventIndex === -1) return;

  throw new ZodError([{
    code: "custom",
    path: ["events_json", invalidEventIndex, "type"],
    message: "events_json items must include a non-empty type when mode is recalculate"
  }]);
}

function validateRecalculateEventTypes(mode: ScheduleMode, events: Record<string, unknown>[]): void {
  if (mode !== "recalculate") return;
  const unsupportedEventIndex = events.findIndex((event) => {
    const type = eventType(event);
    return type && !RECALCULATE_EVENT_TYPES.has(type);
  });
  if (unsupportedEventIndex === -1) return;

  throw new ZodError([{
    code: "custom",
    path: ["events_json", unsupportedEventIndex, "type"],
    message: `Unsupported recalculate event type: ${eventType(events[unsupportedEventIndex]!)}`
  }]);
}

function eventDate(event: Record<string, unknown>): string {
  return stringValue(field(event, "new_start_date", "dataInicio", "data_inicio", "startDate", "date", "to"));
}

function validateRecalculateEventFields(mode: ScheduleMode, events: Record<string, unknown>[]): void {
  if (mode !== "recalculate") return;
  const missingWorkStartDateIndex = events.findIndex((event) => eventType(event) === "work_start_delayed" && !eventDate(event));
  if (missingWorkStartDateIndex === -1) return;

  throw new ZodError([{
    code: "custom",
    path: ["events_json", missingWorkStartDateIndex, "new_start_date"],
    message: "work_start_delayed events must include new_start_date"
  }]);
}

function applyRecalculateEvents(payload: SchedulePayload): SchedulePayload {
  if (payload.mode !== "recalculate" || !payload.events_json.length) return payload;

  const workStartEvent = payload.events_json.find((event) => eventType(event) === "work_start_delayed");
  if (!workStartEvent) return payload;

  const newStartDate = eventDate(workStartEvent);
  if (!newStartDate || !payload.obra_json[0]) return payload;

  return {
    ...payload,
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

async function handleSchedule(req: ObservedRequest, res: Response, mode: ScheduleMode) {
  const log = requestLog(req);
  const startedAt = new Date();

  try {
    const parsedPayload = payloadSchema.parse(req.body);
    const requestMode = modeFromRequest(req, mode);
    validateRecalculateEvents(requestMode, parsedPayload.events_json);
    validateRecalculateEventTypes(requestMode, parsedPayload.events_json);
    validateRecalculateEventFields(requestMode, parsedPayload.events_json);
    validateRecalculateContract(requestMode, parsedPayload);
    const payload = normalizePayload(applyRecalculateEvents({ ...parsedPayload, mode: requestMode }));

    log?.info({
      requestId: req.id,
      cronogramaUniqueId: payload.cronograma_unique_id,
      mode: payload.mode,
      activitiesCount: payload.atividades_json.length,
      eventsCount: payload.events_json.length
    }, "schedule calculation started");

    const result = runScheduleEngine(payload);
    const response = buildScheduleResponse(result, startedAt);

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
