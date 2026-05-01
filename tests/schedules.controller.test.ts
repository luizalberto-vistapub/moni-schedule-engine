import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { basePayload } from "./test-helpers.js";
import { buildAtividadeObraRecords, buildCronogramaLinhaRecords } from "../src/services/bubble-bulk.service.js";
import { normalizePayload } from "../src/services/normalize-payload.service.js";
import { runScheduleEngine } from "../src/services/schedule-engine.service.js";

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

    expect(response.status).toBe(201);
  });

  it("recalculates using the same engine path", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        mode: "",
        events_json: [{ type: "noop" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(201);
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

    expect(response.status).toBe(201);
  });

  it("builds Bubble bulk records for cronograma lines and atividade x obra", () => {
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ id: "obra_1", nome: "Obra Vila Mariana", dataInicio: "2026-05-04" }],
      obra_ambiente_json: [{ id: "amb_1", nome: "Sala", icon: { icon: "//s3.amazonaws.com/sala.png" } }],
      atividades_json: [{ id: "serv_1", nome: "Assentar piso", tipo: "Servico", ordem: 1, duracao: 1, equipe: "Pedreiro", peso: 2 }]
    }));
    const result = runScheduleEngine(payload);

    const cronogramaLinhaRecords = buildCronogramaLinhaRecords(payload, result.lines);
    const atividadeObraRecords = buildAtividadeObraRecords(payload, result.lines);

    expect(cronogramaLinhaRecords[0]).toMatchObject({
      bpjkdb: "versao_1",
      bpjkdc: "obra_1",
      bpjkdd: result.lines[0].atividade_obra_id_externo,
      bpjkde: "2026-05-04T00:00:00.000Z",
      bpjkdh: "Servi\u00e7o",
      bpjkdj: "Assentar piso",
      bpjkdk: "Pedreiro",
      bpjkdl: 2,
      bpjkdm: "Sala",
      bpjkdn: "Piso",
      bpjkdo: 1,
      bpjkdp: 1
    });
    expect(JSON.parse(String(cronogramaLinhaRecords[0].bpjkdr))).toMatchObject({ nome_atividade: "Assentar piso" });

    expect(atividadeObraRecords[0]).toMatchObject({
      copyduracao_boolean: false,
      cronograma_custom_cronograma: "cronograma_1",
      datafimprevista_date: "2026-05-04T00:00:00.000Z",
      datainicioprevista_date: "2026-05-04T00:00:00.000Z",
      duracao_number: 1,
      equipe_option_os_tipoequipe: "Pedreiro",
      nomeatividade_text: "Assentar piso",
      nomeobra_text: "Obra Vila Mariana",
      nomeproduto_text: "Piso",
      obra_custom_obra: "obra_1",
      ordem_number: 1,
      peso_number: 2,
      status_option_os_statusatividade0: "n_o_iniciada",
      tipo_option_os_tipoatividade: "Servi\u00e7o",
      ambiente_text: "Sala",
      icon_image: "//s3.amazonaws.com/sala.png"
    });
  });
});
