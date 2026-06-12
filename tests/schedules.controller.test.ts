import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { basePayload } from "./test-helpers.js";
import { buildAtividadeObraRecords, buildCronogramaLinhaRecords } from "../src/services/bubble-bulk.service.js";
import { normalizePayload } from "../src/services/normalize-payload.service.js";
import { runScheduleEngine } from "../src/services/schedule-engine.service.js";

describe("schedule controllers", () => {
  beforeEach(() => {
    process.env.BUBBLE_API_TOKEN = "test_token";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => ""
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BUBBLE_API_TOKEN;
  });

  function persistedBulkBody(typeName: string): string {
    const calls = (fetch as unknown as { mock: { calls: Array<Array<{ body?: string } | string>> } }).mock.calls;
    const call = calls.find(([url]) => String(url).includes(`/obj/${typeName}/bulk`));
    expect(call).toBeTruthy();
    return String((call![1] as { body?: string }).body);
  }

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
        versao_cronograma_unique_id: "versao_1",
        atividades_json: [
          { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "proj_1", nome: "Projeto", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "serv_1" },
          { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 3, atividadeServicoAncoraId: "serv_1", etapaCompra: "limite de compra" }
        ]
      }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.serverVersionId).toMatch(/^schedule_version_/);
    expect(response.body.version.id).toBe(response.body.serverVersionId);
    expect(response.body.metrics).toMatchObject({
      linesCount: 3,
      servicesCount: 1,
      purchasesCount: 1,
      projectsCount: 1
    });
    expect(Date.parse(response.body.metrics.startedAt)).not.toBeNaN();
    expect(Date.parse(response.body.metrics.finishedAt)).not.toBeNaN();
    expect(typeof response.body.metrics.durationMs).toBe("number");
    expect(response.body.validations).toEqual({ warnings: [], errors: [] });
    expect(response.body.lines).toBeUndefined();
    expect(response.body.cronograma).toBeUndefined();
  });

  it("ignores recalculate events on generate mode", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        mode: "generate",
        events_json: [{ type: "from_date_delayed", from: "2026-05-04", days: 2 }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(201);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    expect(JSON.parse(atividadeObraBody.split("\n")[0]!)).toMatchObject({
      dataInicioPrevista: "2026-05-04T12:00:00.000Z"
    });
  });

  it("recalculates into a new Bubble schedule version", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        events_json: [{ type: "work_start_delayed", new_start_date: "2026-05-06" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.previous_version_id).toBe("versao_1");

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    expect(JSON.parse(atividadeObraBody.split("\n")[0]!)).toMatchObject({
      versaoCronograma: "versao_2",
      dataInicioPrevista: "2026-05-06T12:00:00.000Z"
    });
  });

  it("applies from date paralysis days during recalculation", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-11T03:00:00.000Z" }],
        events_json: [{ type: "from_date_delayed", from: "Aug 11, 2026 12:00 am", days: 2 }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1 },
          { id: "serv_3", nome: "Servico 3", tipo: "Servico", ordem: 3, duracao: 1 },
          { id: "serv_4", nome: "Servico 4", tipo: "Servico", ordem: 4, duracao: 1 }
        ]
      }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.dataInicioPrevista)).toEqual([
      "2026-08-13T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
      "2026-08-15T12:00:00.000Z",
      "2026-08-17T12:00:00.000Z"
    ]);
    expect(records.some((record) => record.dataInicioPrevista.startsWith("2026-08-11") || record.dataInicioPrevista.startsWith("2026-08-12"))).toBe(false);
  });

  it("preserves previous atividade obra dates before from date paralysis", async () => {
    let fetchCallIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const currentCall = fetchCallIndex;
      fetchCallIndex += 1;
      return {
        ok: true,
        text: async () => currentCall === 0 ? "{\"id\":\"ao_1\"}\n{\"id\":\"ao_2\"}\n{\"id\":\"ao_3\"}" : ""
      };
    }));

    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-10T03:00:00.000Z" }],
        atividade_obra_json: [
          { atividade: "serv_1", indice_clone: 1, dataInicioPrevista: "2026-08-10T12:00:00.000Z" },
          { atividade: "serv_2", indice_clone: 1, dataInicioPrevista: "2026-08-11T12:00:00.000Z" },
          { atividade: "serv_3", indice_clone: 1, dataInicioPrevista: "2026-08-12T12:00:00.000Z" }
        ],
        events_json: [{ type: "from_date_delayed", from: "2026-08-11", days: 2 }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1, interdependenciasMasterIds: ["serv_1"] },
          { id: "serv_3", nome: "Servico 3", tipo: "Servico", ordem: 3, duracao: 1, interdependenciasMasterIds: ["serv_2"] }
        ]
      }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.dataInicioPrevista)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z"
    ]);
    expect(records.find((record) => record.nomeAtividade === "Servico 1")).toMatchObject({
      id_atividade_obra_externo: "serv_1_2026-08-10_1",
      dataInicioPrevista: "2026-08-10T12:00:00.000Z"
    });

    expect(records.find((record) => record.atividade === "serv_2")).toMatchObject({
      id_atividade_obra_externo: "serv_2_2026-08-13_1"
    });
    expect(records.find((record) => record.atividade === "serv_3")).toMatchObject({
      id_atividade_obra_externo: "serv_3_2026-08-14_1"
    });
  });

  it("keeps generated dates when from date paralysis has zero days", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-10T03:00:00.000Z" }],
        events_json: [{ type: "from_date_delayed", from: "2026-08-11", days: 0 }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1 }
        ]
      }));

    expect(response.status).toBe(201);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.dataInicioPrevista)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-11T12:00:00.000Z"
    ]);
  });

  it("uses numeric dias aliases for from date paralysis events", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-10T03:00:00.000Z" }],
        events_json: [{ type: "from_date_delayed", from: "2026-08-11", dias: 2 }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1 }
        ]
      }));

    expect(response.status).toBe(201);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.dataInicioPrevista)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z"
    ]);
  });

  it("treats invalid paralysis days as zero", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-10T03:00:00.000Z" }],
        events_json: [{ type: "from_date_delayed", from: "2026-08-11", dias: "abc" }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1 }
        ]
      }));

    expect(response.status).toBe(201);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.dataInicioPrevista)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-11T12:00:00.000Z"
    ]);
  });

  it("keeps invalid activity delay dates on unmatched events", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{
          type: "activity_start_delayed",
          atividade_id: "atividade_inexistente",
          new_start_date: "not-a-date"
        }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(201);
  });

  it("sorts recalculated paralysis lines with date and order ties", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-10T03:00:00.000Z" }],
        atividade_obra_json: [
          { atividade: "serv_1", indice_clone: 2, dataInicioPrevista: "2026-08-10T12:00:00.000Z" },
          { atividade: "serv_1", indice_clone: 1, dataInicioPrevista: "2026-08-10T12:00:00.000Z" }
        ],
        events_json: [{ type: "from_date_delayed", from: "2026-08-11", days: 1 }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 2 }
        ]
      }));

    expect(response.status).toBe(201);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.id_atividade_obra_externo)).toEqual([
      "serv_1_2026-08-10_1",
      "serv_1_2026-08-10_2"
    ]);
  });

  it("preserves previous dates using atividade obra external ids", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-10T03:00:00.000Z" }],
        atividade_obra_json: [
          { atividade: "sem_data" },
          { id_atividade_obra_externo: "serv_1_2026-08-09_1", dataInicioPrevista: "2026-08-09T12:00:00.000Z" },
          { id_atividade_obra_externo: "serv_2_2026-08-08_1", dataInicioPrevista: "2026-08-08T12:00:00.000Z" },
          { id_atividade_obra_externo: "malformed", dataInicioPrevista: "2026-08-07T12:00:00.000Z" }
        ],
        events_json: [{ type: "from_date_delayed", from: "2026-08-11", days: 1 }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1 }
        ]
      }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        id_atividade_obra_externo: "serv_2_2026-08-08_1",
        dataInicioPrevista: "2026-08-08T12:00:00.000Z"
      }),
      expect.objectContaining({
        id_atividade_obra_externo: "serv_1_2026-08-09_1",
        dataInicioPrevista: "2026-08-09T12:00:00.000Z"
      })
    ]);
  });

  it("applies activity start delayed recalculation by activity id", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-01T03:00:00.000Z" }],
        events_json: [{
          type: "activity_start_delayed",
          id_atividade_obra_externo: "compra_1_2026-08-01_1",
          atividade_id: "compra_1",
          new_start_date: "Aug 11, 2026 12:00 am"
        }],
        atividades_json: [
          { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "compra_1", nome: "Limite de compra", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "Limite de compra" }
        ]
      }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_1_"))).toMatchObject({
      dataInicioPrevista: "2026-08-11T12:00:00.000Z"
    });
  });

  it("applies activity start delay using external atividade obra id fallback", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-01T03:00:00.000Z" }],
        events_json: [{
          type: "activity_start_delayed",
          id_atividade_obra_externo: "compra_1_2026-08-01_1",
          new_start_date: "2026-08-11"
        }],
        atividades_json: [
          { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "compra_1", nome: "Limite de compra", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "Limite de compra" }
        ]
      }));

    expect(response.status).toBe(201);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_1_"))).toMatchObject({
      dataInicioPrevista: "2026-08-11T12:00:00.000Z"
    });
  });

  it("requires an activity id for activity start delay events", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{ type: "activity_start_delayed", new_start_date: "2026-08-11" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.validations.errors).toContain("activity_start_delayed events must include atividade_id");
  });

  it("keeps previous activity start delays from events_old during recalculation", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_3",
        previous_version_id: "versao_2",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-01T03:00:00.000Z" }],
        events_old: [{
          tipo: "Adiar início da atividade",
          atividade: "compra_1",
          id_atividade_obra_externo: "compra_1_2026-08-01_1",
          data: "2026-08-11"
        }],
        events_json: [{
          type: "activity_start_delayed",
          atividade_id: "compra_2",
          id_atividade_obra_externo: "compra_2_2026-08-01_1",
          new_start_date: "2026-08-12"
        }],
        atividades_json: [
          { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "compra_1", nome: "Limite de compra 1", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "Limite de compra" },
          { id: "compra_2", nome: "Limite de compra 2", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "Limite de compra" }
        ]
      }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_1_"))).toMatchObject({
      dataInicioPrevista: "2026-08-11T12:00:00.000Z"
    });
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_2_"))).toMatchObject({
      dataInicioPrevista: "2026-08-12T12:00:00.000Z"
    });

    const eventoCronogramaBody = persistedBulkBody("eventocronograma");
    const eventRecords = eventoCronogramaBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(eventRecords.map((record) => record.atividade)).toEqual(["compra_1", "compra_2"]);
    expect(eventRecords.every((record) => record.versaoCronograma === "versao_3")).toBe(true);
    expect(eventRecords.every((record) => record.obra === "obra_1")).toBe(true);
  });

  it("accepts legacy Portuguese event type aliases from events_old", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_3",
        previous_version_id: "versao_2",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-01T03:00:00.000Z" }],
        events_old: [{
          tipo: "Adiar inicio da atividade",
          atividade: "compra_1",
          data: "2026-08-11"
        }],
        atividades_json: [
          { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "compra_1", nome: "Limite de compra", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "Limite de compra" }
        ]
      }));

    expect(response.status).toBe(201);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.atividade === "compra_1" || record.nome_atividade === "Limite de compra")).toMatchObject({
      dataInicioPrevista: "2026-08-11T12:00:00.000Z"
    });
  });

  it("requires a different previous version for recalculation", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{ type: "work_start_delayed", new_start_date: "2026-05-06" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.validations.errors).toContain("versao_cronograma_unique_id must be different from previous_version_id for recalculate");
  });

  it("requires new and previous schedule versions for recalculation", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: undefined,
        previous_version_id: null,
        mode: "recalculate",
        events_json: [{ type: "work_start_delayed", new_start_date: "2026-05-06" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.validations.errors).toEqual(expect.arrayContaining([
      "versao_cronograma_unique_id is required for recalculate and must be the new version id",
      "previous_version_id is required for recalculate"
    ]));
  });

  it("validates recalculate events", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{ type: " " }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.validations.errors).toContain("events_json items must include a non-empty type when mode is recalculate");
  });

  it("validates recalculate events with non-string type", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{ type: 123 }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("validates unsupported recalculate event types", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{ type: "activity_duration_changed" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.validations.errors).toContain("Unsupported recalculate event type: activity_duration_changed");
  });

  it("requires a new start date for work start recalculation", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{ type: "work_start_delayed" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.validations.errors).toContain("work_start_delayed events must include new_start_date");
  });

  it("returns 400 for invalid payloads", async () => {
    const response = await request(app).post("/api/v1/schedules/generate").send({});

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.validations.errors.length).toBeGreaterThan(0);
  });

  it("returns 500 when schedule calculation fails", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({ obra_json: [{}], atividades_json: [] }));

    expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("SCHEDULE_ENGINE_ERROR");
  });

  it("uses route mode when request mode is empty", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        mode: "",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(201);
  });

  it("returns 400 when Bubble ids required for bulk persistence are missing", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("BUBBLE_BULK_PAYLOAD_ERROR");
    expect(response.body.validations.errors[0]).toContain("versao_cronograma_unique_id");
  });

  it("returns 502 when Bubble bulk persistence fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized"
    })));

    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(502);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("BUBBLE_BULK_REQUEST_ERROR");
  });

  it("returns 500 when Bubble API token is not configured", async () => {
    delete process.env.BUBBLE_API_TOKEN;

    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("BUBBLE_BULK_CONFIG_ERROR");
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
      versao_cronograma: "versao_1",
      obra: "obra_1",
      id_atividade_obra_externo: result.lines[0].atividade_obra_id_externo,
      data_programada: "2026-05-04T12:00:00.000Z",
      tipo: "Servi\u00e7o",
      nome_atividade: "Assentar piso",
      equipe: "Pedreiro",
      peso: 2,
      ambiente: "Sala",
      produto: "Piso",
      ordem: 1,
      indice_clone: 1
    });
    expect(JSON.parse(String(cronogramaLinhaRecords[0].dados_brutos_json))).toMatchObject({ nome_atividade: "Assentar piso" });

    expect(atividadeObraRecords[0]).toMatchObject({
      copyDuracao: false,
      cronograma: "cronograma_1",
      dataFimPrevista: "2026-05-04T12:00:00.000Z",
      dataInicioPrevista: "2026-05-04T12:00:00.000Z",
      duracao: 1,
      equipe: "Pedreiro",
      atividade: "serv_1",
      id_atividade_obra_externo: result.lines[0].atividade_obra_id_externo,
      nomeAtividade: "Assentar piso",
      nomeObra: "Obra Vila Mariana",
      nomeProduto: "Piso",
      obra: "obra_1",
      ordemRaiz: 1,
      peso: 2,
      status: "Não iniciada",
      tipo: "Servi\u00e7o",
      versaoCronograma: "versao_1",
      ambiente: "Sala",
      icon: "//s3.amazonaws.com/sala.png"
    });
  });
});
