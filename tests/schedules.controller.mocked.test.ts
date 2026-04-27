import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { basePayload } from "./test-helpers.js";

describe("schedule controller non-Error failures", () => {
  it("serializes thrown non-Error values", async () => {
    vi.resetModules();
    vi.doMock("../src/services/schedule-engine.service.js", () => ({
      runScheduleEngine: () => {
        throw "plain failure";
      }
    }));

    const { app } = await import("../src/app.js");
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({ atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }] }));

    expect(response.status).toBe(500);
    expect(response.body.error.message).toBe("Unexpected error");
    vi.doUnmock("../src/services/schedule-engine.service.js");
  });
});