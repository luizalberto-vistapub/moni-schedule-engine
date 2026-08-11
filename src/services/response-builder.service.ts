import type { ScheduleErrorResponse, ScheduleSuccessResponse } from "../types/response.types.js";
import type { EngineResult } from "../types/schedule.types.js";
import { makeId } from "../utils/ids.js";

export function buildScheduleResponse(result: EngineResult, startedAt: Date, previousVersionId: string | null = null): ScheduleSuccessResponse {
  const finishedAt = new Date();
  const lines = result.lines;
  const serverVersionId = makeId("schedule_version");

  return {
    ok: true,
    serverVersionId,
    previous_version_id: previousVersionId,
    version: { id: serverVersionId },
    metrics: {
      linesCount: lines.length,
      servicesCount: lines.filter((line) => line.tipo === "Servi\u00e7o").length,
      purchasesCount: lines.filter((line) => line.tipo === "Compra").length,
      projectsCount: lines.filter((line) => line.tipo === "Projeto").length,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime()
    },
    validations: result.validations
  };
}

export function buildScheduleErrorResponse(message: string, code: string, details: unknown = {}, errors: string[] = [message]): ScheduleErrorResponse {
  const errorMessage = errors[0] || message;

  return {
    ok: false,
    serverVersionId: null,
    version: null,
    metrics: null,
    message,
    error_message: errorMessage,
    error: {
      message,
      code,
      details
    },
    validations: {
      warnings: [],
      errors
    }
  };
}
