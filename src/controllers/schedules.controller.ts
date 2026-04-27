import type { Request, Response } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { normalizePayload, payloadSchema } from "../services/normalize-payload.service.js";
import { buildScheduleResponse } from "../services/response-builder.service.js";
import { runScheduleEngine } from "../services/schedule-engine.service.js";
import type { ScheduleMode } from "../types/payload.types.js";

type ObservedRequest = Request & {
  id?: string | number | object;
  log?: Logger;
};

function requestLog(req: ObservedRequest): Logger | undefined {
  return req.log;
}

function modeFromRequest(req: ObservedRequest, fallback: ScheduleMode): ScheduleMode {
  return typeof req.body?.mode === "string" && req.body.mode.trim() ? req.body.mode : fallback;
}

function eventType(event: Record<string, unknown>): string {
  return typeof event.type === "string" ? event.type.trim() : "";
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

async function handleSchedule(req: ObservedRequest, res: Response, mode: ScheduleMode) {
  const startedAt = new Date();
  const log = requestLog(req);

  try {
    const parsedPayload = payloadSchema.parse(req.body);
    const requestMode = modeFromRequest(req, mode);
    validateRecalculateEvents(requestMode, parsedPayload.events_json);
    const payload = normalizePayload({ ...parsedPayload, mode: requestMode });

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

    res.json(response);
  } catch (error) {
    if (error instanceof ZodError) {
      log?.warn({ requestId: req.id, issues: error.issues }, "schedule payload validation failed");
      res.status(400).json({
        ok: false,
        error: {
          message: "Invalid payload",
          code: "INVALID_PAYLOAD",
          details: error.flatten()
        },
        validations: {
          warnings: [],
          errors: error.issues.map((issue) => issue.message)
        }
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected error";
    log?.error({ requestId: req.id, error }, "schedule calculation failed");
    res.status(500).json({
      ok: false,
      error: {
        message,
        code: "SCHEDULE_ENGINE_ERROR",
        details: {}
      },
      validations: {
        warnings: [],
        errors: [message]
      }
    });
  }
}

export function generateSchedule(req: Request, res: Response) {
  return handleSchedule(req, res, "generate");
}

export function recalculateSchedule(req: Request, res: Response) {
  return handleSchedule(req, res, "recalculate");
}
