import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { basePayload } from "./test-helpers.js";

describe("schedule controllers", () => {
  it("returns health status", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.body.ok).toBe(true);
    expect(response.body.service).toBe("moni-schedule-engine");
    expect(response.body.version).toBe("0.1.0");
    expect(typeof response.body.uptime).toBe("number");
    expect(Date.parse(response.body.timestamp)).not.toBeNaN();
  });

  it("returns readiness status", async () => {
    const response = await request(app).get("/ready");
    const nestedResponse = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.ready).toBe(true);
    expect(Date.parse(response.body.timestamp)).not.toBeNaN();
    expect(nestedResponse.status).toBe(200);
    expect(nestedResponse.body.ready).toBe(true);
  });

  it("propagates x-request-id", async () => {
    const response = await request(app).get("/health").set("x-request-id", "req_test_123");

    expect(response.headers["x-request-id"]).toBe("req_test_123");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await request(app).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("generates a schedule response", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        atividades_json: [
          { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "proj_1", nome: "Projeto", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "serv_1" },
          { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 3, atividadeServicoAncoraId: "serv_1", etapaCompra: "limite de compra" }
        ]
      }));

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.cronograma).toHaveLength(3);
    expect(response.body.lines).toHaveLength(response.body.cronograma.length);
    expect(response.body.metrics.servicesCount).toBe(1);
    expect(response.body.metrics.projectsCount).toBe(1);
    expect(response.body.metrics.purchasesCount).toBe(1);
  });

  it("recalculates using the same engine path", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        mode: "",
        events_json: [{ type: "noop" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.cronograma).toHaveLength(1);
  });

  it("validates recalculate events", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        mode: "recalculate",
        events_json: [{ type: " " }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.validations.errors).toContain("events_json items must include a non-empty type when mode is recalculate");
  });

  it("validates recalculate events with non-string type", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        mode: "recalculate",
        events_json: [{ type: 123 }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 400 for invalid payloads", async () => {
    const response = await request(app).post("/api/v1/schedules/generate").send({});

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.validations.errors.length).toBeGreaterThan(0);
  });

  it("returns 500 when schedule calculation fails", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({ obra_json: [{}], atividades_json: [] }));

    expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("SCHEDULE_ENGINE_ERROR");
  });

  it("uses route mode when request mode is empty", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        mode: "",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});
