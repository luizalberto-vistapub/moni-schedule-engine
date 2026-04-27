import type { ScheduleLine } from "./schedule.types.js";

export interface ScheduleSuccessResponse {
  ok: true;
  serverVersionId: string;
  version: { id: string };
  metrics: {
    linesCount: number;
    servicesCount: number;
    purchasesCount: number;
    projectsCount: number;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  validations: {
    warnings: string[];
    errors: string[];
  };
  cronograma: ScheduleLine[];
  lines: ScheduleLine[];
  scheduleLines: ScheduleLine[];
  cronogramaLinhas: ScheduleLine[];
  activityObras: ScheduleLine[];
}