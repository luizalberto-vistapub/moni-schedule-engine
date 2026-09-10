import type { Logger } from "pino";
import type { NormalizedSchedulePayload } from "../types/payload.types.js";

const DEFAULT_BUBBLE_WEBHOOK_URL = "https://moni-29694.bubbleapps.io/version-test/api/1.1/wf/api_cronograma__webhook_v1";

export type ScheduleJobStatus = "processing" | "done" | "error";
export type ScheduleJobProgress = 2 | 3 | 4;

export interface ScheduleWebhookPayload {
  job_id: string;
  status: ScheduleJobStatus;
  progress?: ScheduleJobProgress;
  progress_percent?: number;
  message?: string;
  cronograma_unique_id?: string;
  versao_cronograma_unique_id?: string;
  previous_version_id?: string | null;
  metrics?: {
    linesCount: number;
    durationMs: number;
  };
  error_code?: string;
  error_message?: string;
  failed_step?: string;
}

interface SendScheduleWebhookOptions {
  log?: Logger;
  requestId?: string | number | object;
}

export function scheduleWebhookUrl(): string {
  return process.env.BUBBLE_SCHEDULE_WEBHOOK_URL || DEFAULT_BUBBLE_WEBHOOK_URL;
}

export async function sendScheduleWebhook(
  payload: ScheduleWebhookPayload,
  options: SendScheduleWebhookOptions = {}
): Promise<void> {
  const apiToken = process.env.BUBBLE_API_TOKEN;
  const url = scheduleWebhookUrl();

  let response: Response;
  let responseText = "";
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    responseText = await response.text();
  } catch (error) {
    options.log?.warn({
      requestId: options.requestId,
      jobId: payload.job_id,
      url,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    }, "schedule webhook request failed");
    return;
  }

  if (!response.ok) {
    options.log?.warn({
      requestId: options.requestId,
      jobId: payload.job_id,
      url,
      statusCode: response.status,
      responseText
    }, "schedule webhook failed");
    return;
  }

  options.log?.info({
    requestId: options.requestId,
    jobId: payload.job_id,
    url,
    status: payload.status,
    progress: payload.progress,
    progressPercent: payload.progress_percent
  }, "schedule webhook sent");
}

export function webhookBaseFields(jobId: string, payload: NormalizedSchedulePayload): Pick<
ScheduleWebhookPayload,
"job_id" | "cronograma_unique_id" | "versao_cronograma_unique_id" | "previous_version_id"
> {
  return {
    job_id: jobId,
    cronograma_unique_id: payload.cronograma_unique_id,
    versao_cronograma_unique_id: payload.versao_cronograma_unique_id
      || payload.versao_cronograma_id
      || payload.versaoCronograma
      || payload.version_id
      || "",
    previous_version_id: payload.previous_version_id || null
  };
}
