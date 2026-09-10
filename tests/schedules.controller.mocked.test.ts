import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { basePayload } from "./test-helpers.js";

describe("schedule controller non-Error failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../src/services/schedule-engine.service.js");
  });

  it("serializes thrown non-Error values", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ""
    })));
    vi.doMock("../src/services/schedule-engine.service.js", () => ({
      runScheduleEngine: () => {
        throw "plain failure";
      }
    }));

    const { app } = await import("../src/app.js");
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({ atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }] }));

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const webhookCall = calls.find(([url]) => String(url).includes("/api/1.1/wf/api_cronograma__webhook_v1"));
      if (webhookCall) {
        expect(JSON.parse(String((webhookCall[1] as RequestInit).body))).toMatchObject({
          job_id: response.body.job_id,
          status: "error",
          error_code: "SCHEDULE_ENGINE_ERROR",
          error_message: "Unexpected error",
          failed_step: "calculate"
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Expected webhook call was not made");
  });
});
