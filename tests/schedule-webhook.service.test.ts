import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendScheduleWebhook } from "../src/services/schedule-webhook.service.js";

type MockFetchResponse = { ok: boolean; status: number; text: () => Promise<string> };

describe("schedule webhook service", () => {
  beforeEach(() => {
    process.env.BUBBLE_API_BASE_URL = "https://bubble.test/";
    process.env.BUBBLE_API_VERSION = "version-test";
    process.env.BUBBLE_SCHEDULE_WEBHOOK_MAX_RETRIES = "2";
    process.env.BUBBLE_SCHEDULE_WEBHOOK_RETRY_BASE_MS = "0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BUBBLE_API_BASE_URL;
    delete process.env.BUBBLE_API_VERSION;
    delete process.env.BUBBLE_SCHEDULE_WEBHOOK_MAX_RETRIES;
    delete process.env.BUBBLE_SCHEDULE_WEBHOOK_RETRY_BASE_MS;
  });

  it("retries terminal webhook failures", async () => {
    const fetchMock = vi.fn(async (): Promise<MockFetchResponse> => {
      if (fetchMock.mock.calls.length === 1) {
        return { ok: false, status: 429, text: async () => "rate limited" };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendScheduleWebhook({ job_id: "job_1", status: "error", error_message: "failed" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry processing progress webhooks", async () => {
    const fetchMock = vi.fn(async (): Promise<MockFetchResponse> => (
      { ok: false, status: 429, text: async () => "rate limited" }
    ));
    vi.stubGlobal("fetch", fetchMock);

    await sendScheduleWebhook({ job_id: "job_1", status: "processing", progress: 2, progress_percent: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
