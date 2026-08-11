export interface ScheduleMetrics {
  linesCount: number;
  servicesCount: number;
  purchasesCount: number;
  projectsCount: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ScheduleValidations {
  warnings: string[];
  errors: string[];
}

export interface ScheduleSuccessResponse {
  ok: true;
  serverVersionId: string;
  previous_version_id: string | null;
  version: { id: string };
  metrics: ScheduleMetrics;
  validations: ScheduleValidations;
}

export interface ScheduleErrorResponse {
  ok: false;
  serverVersionId: null;
  version: null;
  metrics: null;
  message: string;
  error_message: string;
  error: {
    message: string;
    code: string;
    details: unknown;
  };
  validations: ScheduleValidations;
}
