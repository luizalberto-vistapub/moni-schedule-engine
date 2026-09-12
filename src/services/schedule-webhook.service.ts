import type { Logger } from "pino";
import type { NormalizedSchedulePayload } from "../types/payload.types.js";
import type { NormalizedDate } from "../types/schedule.types.js";

const DEFAULT_BUBBLE_API_BASE_URL = "https://moni-29694.bubbleapps.io";
const DEFAULT_BUBBLE_API_VERSION = "version-test";
const BUBBLE_WEBHOOK_PATH = "/api/1.1/wf/api_cronograma__webhook_v1";
const DEFAULT_TERMINAL_WEBHOOK_MAX_RETRIES = 4;
const DEFAULT_TERMINAL_WEBHOOK_RETRY_BASE_MS = 5000;

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
    patchedCount?: number;
    patchRequestCount?: number;
    patchBatchCount?: number;
    eventCount?: number;
    dependencyPatchCount?: number;
  };
  normalizedDates?: NormalizedDate[];
  error_code?: string;
  error_message?: string;
  error_details?: unknown;
  failed_step?: string;
}

interface SendScheduleWebhookOptions {
  log?: Logger;
  requestId?: string | number | object;
  bubbleApiVersion?: string | null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeBubbleVersion(value: string): string {
  const version = value.replace(/^\/+|\/+$/g, "");
  if (version === "version-live" || version === "version-test" || version.startsWith("version-")) return version;
  if (version === "live") return "version-live";
  return `version-${version}`;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(stringValue(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function retryableWebhookStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function terminalWebhookRetryDelayMs(attempt: number): number {
  const retryBaseMs = boundedInteger(
    process.env.BUBBLE_SCHEDULE_WEBHOOK_RETRY_BASE_MS,
    DEFAULT_TERMINAL_WEBHOOK_RETRY_BASE_MS,
    0,
    60000
  );
  return Math.min(30000, retryBaseMs * (2 ** attempt));
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function webhookBubbleApiVersion(payload: NormalizedSchedulePayload): string | null {
  const version = stringValue(payload.bubble_api_version || payload.bubble_version || payload.version);
  return version ? normalizeBubbleVersion(version) : null;
}

export function scheduleWebhookUrl(version?: string | null): string {
  if (process.env.BUBBLE_SCHEDULE_WEBHOOK_URL) return process.env.BUBBLE_SCHEDULE_WEBHOOK_URL;

  const baseUrl = (process.env.BUBBLE_API_BASE_URL || DEFAULT_BUBBLE_API_BASE_URL).replace(/\/+$/g, "");
  const bubbleVersion = normalizeBubbleVersion(version || process.env.BUBBLE_API_VERSION || DEFAULT_BUBBLE_API_VERSION);
  const versionPath = bubbleVersion === "version-live" ? "" : `/${bubbleVersion}`;
  return `${baseUrl}${versionPath}${BUBBLE_WEBHOOK_PATH}`;
}

export async function sendScheduleWebhook(
  payload: ScheduleWebhookPayload,
  options: SendScheduleWebhookOptions = {}
): Promise<void> {
  const apiToken = process.env.BUBBLE_API_TOKEN;
  const url = scheduleWebhookUrl(options.bubbleApiVersion);
  const maxRetries = payload.status === "processing"
    ? 0
    : boundedInteger(
      process.env.BUBBLE_SCHEDULE_WEBHOOK_MAX_RETRIES,
      DEFAULT_TERMINAL_WEBHOOK_MAX_RETRIES,
      0,
      10
    );

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
      if (attempt < maxRetries) {
        const retryInMs = terminalWebhookRetryDelayMs(attempt);
        options.log?.warn({
          requestId: options.requestId,
          jobId: payload.job_id,
          url,
          status: payload.status,
          attempt: attempt + 1,
          retryInMs,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        }, "schedule webhook request failed; retrying");
        await delay(retryInMs);
        continue;
      }

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
      if (attempt < maxRetries && retryableWebhookStatus(response.status)) {
        const retryInMs = terminalWebhookRetryDelayMs(attempt);
        options.log?.warn({
          requestId: options.requestId,
          jobId: payload.job_id,
          url,
          status: payload.status,
          statusCode: response.status,
          attempt: attempt + 1,
          retryInMs,
          responseText
        }, "schedule webhook failed; retrying");
        await delay(retryInMs);
        continue;
      }

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
    return;
  }
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
