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
    let idIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => JSON.stringify({ response: { cursor: 0, count: 0, remaining: 0, results: [] } })
        };
      }
      if (init?.method === "PATCH") {
        return {
          ok: true,
          status: 204,
          text: async (): Promise<string> => ""
        };
      }

      const rows = String(init?.body || "").split(/\r?\n/).filter(Boolean);
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => rows.map(() => JSON.stringify({ id: `bubble_${idIndex += 1}` })).join("\n")
      };
    }));
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

  function fetchCalls(path: string, method: string): unknown[][] {
    return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return String(call[0]).includes(path) && init?.method === method;
    });
  }

  async function waitForDoneWebhook(): Promise<void> {
    await waitForFetchCall((call) => {
      if (!String(call[0]).includes("/api/1.1/wf/api_cronograma__webhook_v1")) return false;
      try {
        return JSON.parse(String((call[1] as RequestInit | undefined)?.body || "{}")).status === "done";
      } catch {
        return false;
      }
    });
  }

  async function waitForFetchCall(predicate: (call: unknown[]) => boolean): Promise<unknown[]> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const call = calls.find(predicate);
      if (call) return call;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Expected fetch call was not made");
  }

  async function waitForWebhookCall(status: string): Promise<unknown[]> {
    return waitForFetchCall(([url, init]) => {
      const body = String((init as RequestInit | undefined)?.body || "");
      return String(url).includes("/api/1.1/wf/api_cronograma__webhook_v1")
        && body.includes(`"status":"${status}"`);
    });
  }

  async function waitForWebhookBody(status: string): Promise<Record<string, unknown>> {
    const call = await waitForWebhookCall(status);
    return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
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

  it("accepts a schedule job immediately", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        atividades_json: [
          { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, atividadeProjeto: [{ idAtividadeProjeto: "proj_1", nomeAtividadeProjeto: "Projeto" }] },
          { id: "proj_1", nome: "Projeto", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "" },
          { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 3, atividadeServicoAncoraId: "serv_1", etapaCompra: "limite de compra" }
        ]
      }));

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);
    expect(response.body).toMatchObject({
      status: "accepted",
      cronograma_unique_id: "cronograma_test",
      versao_cronograma_unique_id: "versao_1",
      message: "Schedule recalculation accepted"
    });
    expect(response.body.job_id).toMatch(/^schedule_job_/);
    expect(response.body.metrics).toBeUndefined();
    expect(response.body.validations).toBeUndefined();

    const processingBody = await waitForWebhookBody("processing");
    expect(processingBody).toMatchObject({
      job_id: response.body.job_id,
      status: "processing",
      progress: 2,
      progress_percent: 0,
      message: "Criando registros em bulk"
    });

    const webhookCall = await waitForWebhookCall("done");
    expect(webhookCall[0]).toBe("https://moni-29694.bubbleapps.io/version-test/api/1.1/wf/api_cronograma__webhook_v1");
    expect((webhookCall[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test_token",
      "Content-Type": "application/json"
    });
    const webhookBody = JSON.parse(String((webhookCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(webhookBody).toMatchObject({
      job_id: response.body.job_id,
      status: "done",
      progress: 4,
      progress_percent: 100,
      cronograma_unique_id: "cronograma_test",
      versao_cronograma_unique_id: "versao_1",
      previous_version_id: null
    });
    expect(webhookBody.metrics).toMatchObject({ linesCount: 3 });
    expect(typeof (webhookBody.metrics as { durationMs?: unknown }).durationMs).toBe("number");
  });

  it("sends schedule webhooks to the Bubble API version from the payload", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        bubble_api_version: "version-63jmi",
        versao_cronograma_unique_id: "versao_63jmi",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(202);

    const webhookCall = await waitForWebhookCall("done");
    expect(webhookCall[0]).toBe("https://moni-29694.bubbleapps.io/version-63jmi/api/1.1/wf/api_cronograma__webhook_v1");
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

    expect(response.status).toBe(202);

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

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);
    expect(response.body.status).toBe("accepted");
    expect(response.body.versao_cronograma_unique_id).toBe("versao_2");

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

    expect(response.status).toBe(202);
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
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          text: async (): Promise<string> => JSON.stringify({ response: { cursor: 0, count: 0, remaining: 0, results: [] } })
        };
      }
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

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.dataInicioPrevista)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z"
    ]);
    expect(records.find((record) => record.nomeAtividade === "Servico 1")).toMatchObject({
      id_atividade_obra_externo: "serv_1|amb_1|1",
      dataInicioPrevista: "2026-08-10T12:00:00.000Z"
    });

    expect(records.find((record) => record.atividade === "serv_2")).toMatchObject({
      id_atividade_obra_externo: "serv_2|amb_1|1"
    });
    expect(records.find((record) => record.atividade === "serv_3")).toMatchObject({
      id_atividade_obra_externo: "serv_3|amb_1|1"
    });
  });

  it("changes only the selected atividade obra date without dependents", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const rows = String((init as { body?: string })?.body || "").split("\n").filter(Boolean);
      return {
        ok: true,
        text: async () => rows.map((_, index) => JSON.stringify({ id: `bulk_${index + 1}` })).join("\n")
      };
    }));

    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        obra_json: [{ id: "obra_1", dataInicio: "2026-05-04" }],
        atividade_obra_json: [
          { atividade: "serv_1", indice_clone: 1, dataInicioPrevista: "2026-05-04" },
          { atividade: "serv_2", indice_clone: 1, dataInicioPrevista: "2026-05-05" },
          { atividade: "serv_3", indice_clone: 1, dataInicioPrevista: "2026-05-06" }
        ],
        events_json: [{
          type: "activity_date_changed_only",
          id_atividade_obra_externo: "serv_2_2026-05-05_1",
          new_start_date: "2026-05-10"
        }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1, interdependenciasMasterIds: ["serv_1"] },
          { id: "serv_3", nome: "Servico 3", tipo: "Servico", ordem: 3, duracao: 1, interdependenciasMasterIds: ["serv_2"] }
        ]
      }));

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const records = persistedBulkBody("atividadexobra").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.atividade === "serv_1")).toMatchObject({ dataInicioPrevista: "2026-05-04T12:00:00.000Z" });
    expect(records.find((record) => record.atividade === "serv_2")).toMatchObject({ dataInicioPrevista: "2026-05-10T12:00:00.000Z" });
    expect(records.find((record) => record.atividade === "serv_3")).toMatchObject({ dataInicioPrevista: "2026-05-06T12:00:00.000Z" });

    const eventRecords = persistedBulkBody("eventocronograma").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(eventRecords.find((record) => record.tipo === "Alterar somente data da atividade")).toMatchObject({
      atividade: "serv_2",
      data: "2026-05-10T12:00:00.000Z"
    });
  });

  it("uses snapshot-driven recalculation to patch only changed dates when estrutura is unchanged", async () => {
    const payload = basePayload({
      payload_version: 2,
      estrutura_inalterada: true,
      estrutura_id: "estrutura_1",
      versao_cronograma_unique_id: "versao_2",
      previous_version_id: "versao_1",
      mode: "recalculate",
      obra_ambiente_json: [],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [],
      atividades_json: [],
      atividade_obra_snapshot: [
        {
          "unique id": "axo_1",
          id_atividade_obra_externo: "serv_1|amb_1|1",
          atividade: "serv_1",
          ambiente_id: "amb_1",
          tipo: "Servico",
          ordem: 1,
          peso: 1,
          equipe: "",
          diasAntecedencia: 0,
          duracao: 1,
          duracaoVariavel: false,
          quantidadeBase: null,
          dataInicioPrevista: "2026-05-04",
          dataFimPrevista: "2026-05-04",
          status: "N\u00e3o iniciada"
        },
        {
          "unique id": "axo_2",
          id_atividade_obra_externo: "serv_2|amb_1|1",
          atividade: "serv_2",
          ambiente_id: "amb_1",
          tipo: "Servico",
          ordem: 2,
          peso: 1,
          equipe: "",
          diasAntecedencia: 0,
          duracao: 1,
          duracaoVariavel: false,
          quantidadeBase: null,
          dataInicioPrevista: "2026-05-05",
          dataFimPrevista: "2026-05-05",
          status: ""
        }
      ],
      master_dependencies: [{ atividade: "serv_2", deps: ["serv_1"] }],
      events_json: [{
        type: "activity_date_changed_cascade",
        atividade_id: "serv_1",
        id_atividade_obra_externo: "serv_1|amb_1|1",
        new_start_date: "2026-05-06"
      }]
    });
    delete (payload as unknown as Record<string, unknown>).obra_json;
    delete (payload as unknown as Record<string, unknown>).obra_ambiente_json;
    delete (payload as unknown as Record<string, unknown>).obra_ambiente_produto_json;
    delete (payload as unknown as Record<string, unknown>).obra_ambiente_item_composicao_json;
    delete (payload as unknown as Record<string, unknown>).atividades_json;
    delete (payload as unknown as Record<string, unknown>).atividade_obra_json;

    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");

    await waitForDoneWebhook();

    const patchCalls = fetchCalls("/api/1.1/obj/atividadexobra/", "PATCH");
    expect(fetchCalls("/api/1.1/obj/atividadexobra/bulk", "POST")).toHaveLength(0);
    expect(patchCalls).toHaveLength(2);
    expect(JSON.parse(String((patchCalls[0]![1] as RequestInit).body))).toEqual({
      dataInicioPrevista: "2026-05-06T12:00:00.000Z",
      dataFimPrevista: "2026-05-06T12:00:00.000Z"
    });
    expect(JSON.parse(String((patchCalls[1]![1] as RequestInit).body))).toEqual({
      dataInicioPrevista: "2026-05-07T12:00:00.000Z",
      dataFimPrevista: "2026-05-07T12:00:00.000Z"
    });
  });

  it("accepts v2 snapshot recalculation probes without obra_json when there are no events", async () => {
    const payload = basePayload({
      payload_version: 2,
      estrutura_inalterada: true,
      estrutura_id: "1-1-20260911000000",
      versao_cronograma_unique_id: "versao_2",
      previous_version_id: "versao_1",
      mode: "recalculate",
      atividade_obra_snapshot: [],
      master_dependencies: [],
      master_anchors: [],
      events_json: [],
      events_old: []
    });
    delete (payload as unknown as Record<string, unknown>).obra_json;
    delete (payload as unknown as Record<string, unknown>).atividades_json;
    delete (payload as unknown as Record<string, unknown>).atividade_obra_json;

    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");
  });

  it("does not move snapshot lines with started status", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        payload_version: 2,
        estrutura_inalterada: true,
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        obra_json: [{ id: "obra_1", dataInicio: "2026-05-04" }],
        atividades_json: [],
        atividade_obra_snapshot: [
          {
            "unique id": "axo_started",
            id_atividade_obra_externo: "serv_started|amb_1|1",
            atividade: "serv_started",
            ambiente_id: "amb_1",
            tipo: "Servico",
            ordem: 1,
            peso: 1,
            equipe: "",
            diasAntecedencia: 0,
            duracao: 1,
            duracaoVariavel: false,
            quantidadeBase: null,
            dataInicioPrevista: "2026-05-04",
            dataFimPrevista: "2026-05-04",
            status: "Iniciada"
          }
        ],
        events_json: [{
          type: "activity_date_changed_only",
          atividade_id: "serv_started",
          id_atividade_obra_externo: "serv_started|amb_1|1",
          new_start_date: "2026-05-10"
        }]
      }));

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");

    await waitForDoneWebhook();

    expect(fetchCalls("/api/1.1/obj/atividadexobra/", "PATCH")).toHaveLength(0);
    expect(fetchCalls("/api/1.1/obj/atividadexobra/bulk", "POST")).toHaveLength(0);
  });

  it("changes selected atividade obra date and dependent activities without event date cutoff", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const rows = String((init as { body?: string })?.body || "").split("\n").filter(Boolean);
      return {
        ok: true,
        text: async () => rows.map((_, index) => JSON.stringify({ id: `bulk_${index + 1}` })).join("\n")
      };
    }));

    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        event_date: "2026-05-20",
        obra_json: [{ id: "obra_1", dataInicio: "2026-05-04" }],
        atividade_obra_json: [
          { atividade: "serv_1", indice_clone: 1, dataInicioPrevista: "2026-05-04" },
          { atividade: "serv_2", indice_clone: 1, dataInicioPrevista: "2026-05-05" },
          { atividade: "serv_2", indice_clone: 2, dataInicioPrevista: "2026-05-06" },
          { atividade: "serv_3", indice_clone: 1, dataInicioPrevista: "2026-05-07" },
          { atividade: "serv_4", indice_clone: 1, dataInicioPrevista: "2026-05-08" }
        ],
        events_json: [{
          type: "Alterar data da atividade com dependentes",
          id_atividade_obra_externo: "serv_2_2026-05-06_2",
          new_start_date: "2026-05-10"
        }],
        atividades_json: [
          { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
          { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 2, interdependenciasMasterIds: ["serv_1"] },
          { id: "serv_3", nome: "Servico 3", tipo: "Servico", ordem: 3, duracao: 1, interdependenciasMasterIds: ["serv_2"] },
          { id: "serv_4", nome: "Servico 4", tipo: "Servico", ordem: 4, duracao: 1 }
        ]
      }));

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const records = persistedBulkBody("atividadexobra").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const datesByExternalId = new Map(records.map((record) => [record.id_atividade_obra_externo, record.dataInicioPrevista]));
    expect(datesByExternalId.get("serv_1|amb_1|1")).toBe("2026-05-04T12:00:00.000Z");
    expect(datesByExternalId.get("serv_2|amb_1|1")).toBe("2026-05-05T12:00:00.000Z");
    expect(datesByExternalId.get("serv_2|amb_1|2")).toBe("2026-05-10T12:00:00.000Z");
    expect(datesByExternalId.get("serv_3|amb_1|1")).toBe("2026-05-11T12:00:00.000Z");
    expect(datesByExternalId.get("serv_4|amb_1|1")).toBe("2026-05-08T12:00:00.000Z");
  });

  it("changes selected purchase date and cascades to its anchor service dependents without event date cutoff", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const rows = String((init as { body?: string })?.body || "").split("\n").filter(Boolean);
      return {
        ok: true,
        text: async () => rows.map((_, index) => JSON.stringify({ id: `bulk_${index + 1}` })).join("\n")
      };
    }));

    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        event_date: "2026-05-20",
        obra_json: [{ id: "obra_1", dataInicio: "2026-05-04" }],
        obra_ambiente_produto_json: [
          {
            id: "oap_service",
            ambienteId: "amb_1",
            produtoId: "prod_service",
            produtoNome: "Produto servico",
            "id produto composto": "composto_1",
            quantidade: 1
          },
          {
            id: "oap_purchase",
            ambienteId: "amb_1",
            produtoId: "prod_purchase",
            produtoNome: "Produto compra",
            "id produto composto": "composto_1",
            quantidade: 1
          },
          {
            id: "oap_independent",
            ambienteId: "amb_1",
            produtoId: "prod_independent",
            produtoNome: "Produto independente",
            "id produto composto": "composto_2",
            quantidade: 1
          }
        ],
        atividade_obra_json: [
          { atividade: "compra_1", indice_clone: 1, dataInicioPrevista: "2026-05-01" },
          { atividade: "serv_anchor", indice_clone: 1, dataInicioPrevista: "2026-05-04" },
          { atividade: "serv_dep", indice_clone: 1, dataInicioPrevista: "2026-05-05" },
          { atividade: "serv_independent", indice_clone: 1, dataInicioPrevista: "2026-05-06" }
        ],
        events_json: [{
          type: "activity_date_changed_cascade",
          id_atividade_obra_externo: "compra_1_2026-05-01_1",
          new_start_date: "2026-05-03"
        }],
        atividades_json: [
          { id: "serv_anchor", nome: "Servico ancora", tipo: "Servico", ordem: 1, duracao: 1, produto: "prod_service" },
          { id: "serv_dep", nome: "Servico dependente", tipo: "Servico", ordem: 2, duracao: 1, produto: "prod_service", interdependenciasMasterIds: ["serv_anchor"] },
          { id: "serv_independent", nome: "Servico independente", tipo: "Servico", ordem: 3, duracao: 1, produto: "prod_independent" },
          { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 4, produto: "prod_purchase", etapaCompra: "Limite de compra", atividadeServicoAncoraId: "prod_purchase" }
        ]
      }));

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const records = persistedBulkBody("atividadexobra").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const datesByActivity = new Map(records.map((record) => [record.atividade, record.dataInicioPrevista]));
    expect(datesByActivity.get("compra_1")).toBe("2026-05-03T12:00:00.000Z");
    expect(datesByActivity.get("serv_anchor")).toBe("2026-05-06T12:00:00.000Z");
    expect(datesByActivity.get("serv_dep")).toBe("2026-05-07T12:00:00.000Z");
    expect(datesByActivity.get("serv_independent")).toBe("2026-05-06T12:00:00.000Z");
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

    expect(response.status).toBe(202);

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

    expect(response.status).toBe(202);

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

    expect(response.status).toBe(202);

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

    expect(response.status).toBe(202);
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

    expect(response.status).toBe(202);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.id_atividade_obra_externo)).toEqual([
      "serv_1|amb_1|1",
      "serv_1|amb_1|2"
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

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        id_atividade_obra_externo: "serv_2|amb_1|1",
        dataInicioPrevista: "2026-08-08T12:00:00.000Z"
      }),
      expect.objectContaining({
        id_atividade_obra_externo: "serv_1|amb_1|1",
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

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_1|"))).toMatchObject({
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

    expect(response.status).toBe(202);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_1|"))).toMatchObject({
      dataInicioPrevista: "2026-08-11T12:00:00.000Z"
    });
  });

  it("recalculates future purchase chain lines and dependent services from the request event date", async () => {
    let fetchCallIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          text: async (): Promise<string> => JSON.stringify({ response: { cursor: 0, count: 0, remaining: 0, results: [] } })
        };
      }
      const currentCall = fetchCallIndex;
      fetchCallIndex += 1;
      const rows = String(init?.body || "").split(/\r?\n/).filter(Boolean);
      return {
        ok: true,
        text: async () => currentCall === 0 ? rows.map((_, index) => `{"id":"ao_${index + 1}"}`).join("\n") : ""
      };
    }));

    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "",
        dias_trabalho_semana: 6,
        event_date: "2026-07-12",
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-01T03:00:00.000Z" }],
        obra_ambiente_produto_json: [],
        obra_ambiente_item_composicao_json: [
          {
            "unique id": "item_compra",
            "id produto composto": "composto_ps1",
            "id produto simples": "ps1_compra",
            "nome produto simples": "PS1 compra"
          },
          {
            "unique id": "item_servico",
            "id produto composto": "composto_ps1",
            "id produto simples": "ps1_servico",
            "nome produto simples": "PS1 serviço"
          }
        ],
        atividade_obra_json: [
          { id_atividade_obra_externo: "comp_aviso_2026-07-10_1" },
          { id_atividade_obra_externo: "comp_lim_orc_2026-07-15_1" },
          { id_atividade_obra_externo: "comp_lim_compra_2026-07-20_1" },
          { id_atividade_obra_externo: "comp_receb_2026-07-25_1" },
          { id_atividade_obra_externo: "serv_ps1_2026-08-01_1" },
          { id_atividade_obra_externo: "serv_dep_2026-08-05_1" }
        ],
        events_json: [{
          type: "activity_start_delayed",
          atividade_id: "comp_lim_orc",
          id_atividade_obra_externo: "comp_lim_orc_2026-07-15_1",
          new_start_date: "2026-07-17"
        }],
        atividades_json: [
          { id: "comp_aviso", nome: "Aviso de orçamento PS1", tipo: "Compra", produto: "ps1_compra", ordem: 1, atividadeServicoAncoraId: "ps1_compra", etapaCompra: "Aviso de orçamento", diasAntecedencia: 22 },
          { id: "comp_lim_orc", nome: "Limite de orçamento PS1", tipo: "Compra", produto: "ps1_compra", ordem: 1, atividadeServicoAncoraId: "ps1_compra", etapaCompra: "Limite de orçamento", diasAntecedencia: 17 },
          { id: "comp_lim_compra", nome: "Limite de compra PS1", tipo: "Compra", produto: "ps1_compra", ordem: 1, atividadeServicoAncoraId: "ps1_compra", etapaCompra: "Limite de compra", diasAntecedencia: 12 },
          { id: "comp_receb", nome: "Recebimento PS1", tipo: "Compra", produto: "ps1_compra", ordem: 1, atividadeServicoAncoraId: "ps1_compra", etapaCompra: "Recebimento", diasAntecedencia: 7 },
          { id: "serv_ps1", nome: "Atividade de Serviço PS1", tipo: "Servico", produto: "ps1_servico", ordem: 1, duracao: 1 },
          { id: "serv_dep", nome: "Serviço dependente PS1", tipo: "Servico", produto: "ps1_servico", ordem: 2, duracao: 1, interdependenciasMasterIds: ["serv_ps1"] }
        ]
      }));

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const dateByActivity = new Map(records.map((record) => [record.atividade, record.dataInicioPrevista]));

    expect(dateByActivity.get("comp_aviso")).toBe("2026-07-10T12:00:00.000Z");
    expect(dateByActivity.get("comp_lim_orc")).toBe("2026-07-17T12:00:00.000Z");
    expect(dateByActivity.get("comp_lim_compra")).toBe("2026-07-22T12:00:00.000Z");
    expect(dateByActivity.get("comp_receb")).toBe("2026-07-27T12:00:00.000Z");
    expect(dateByActivity.get("serv_ps1")).toBe("2026-08-03T12:00:00.000Z");
    expect(dateByActivity.get("serv_dep")).toBe("2026-08-07T12:00:00.000Z");
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

  it("lets events_json override previous events_old for the same activity", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_3",
        previous_version_id: "versao_2",
        mode: "",
        dias_trabalho_semana: 6,
        obra_json: [{ id: "obra_1", dataInicio: "2026-08-01T03:00:00.000Z" }],
        events_old: [{
          tipo: "activity_date_changed_only",
          atividade: "serv_1",
          id_atividade_obra_externo: "serv_1_2026-08-10_1",
          data: "2026-08-15"
        }],
        events_json: [{
          type: "activity_start_delayed",
          atividade_id: "serv_1",
          id_atividade_obra_externo: "serv_1_2026-08-10_1",
          new_start_date: "2026-08-12"
        }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.atividade === "serv_1")).toMatchObject({
      dataInicioPrevista: "2026-08-12T12:00:00.000Z"
    });

    const eventoCronogramaBody = persistedBulkBody("eventocronograma");
    const eventRecords = eventoCronogramaBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(eventRecords).toHaveLength(1);
    expect(eventRecords[0]).toMatchObject({
      atividade: "serv_1",
      data: "2026-08-12T12:00:00.000Z",
      tipo: "Adiar início da atividade"
    });
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

    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);

    const atividadeObraBody = persistedBulkBody("atividadexobra");
    const records = atividadeObraBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_1|"))).toMatchObject({
      dataInicioPrevista: "2026-08-11T12:00:00.000Z"
    });
    expect(records.find((record) => record.id_atividade_obra_externo.startsWith("compra_2|"))).toMatchObject({
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

    expect(response.status).toBe(202);

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
    expect(response.body.job_id).toBeUndefined();
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
    expect(response.body.job_id).toBeUndefined();
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
    expect(response.body.job_id).toBeUndefined();
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
    expect(response.body.job_id).toBeUndefined();
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
    expect(response.body.job_id).toBeUndefined();
    expect(response.body.validations.errors).toContain("Unsupported recalculate event type: activity_duration_changed");
  });

  it("requires a new start date for work start recalculation", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_2",
        previous_version_id: "versao_1",
        mode: "recalculate",
        events_json: [{ type: "work_start_delayed", new_start_date: "" }],
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.job_id).toBeUndefined();
    expect(response.body.error.message).toBe("work_start_delayed events must include new_start_date");
    expect(response.body.error_message).toBe("work_start_delayed events must include new_start_date");
    expect(response.body.message).toBe("work_start_delayed events must include new_start_date");
    expect(response.body.validations.errors).toContain("work_start_delayed events must include new_start_date");
  });

  it("returns 400 for invalid payloads", async () => {
    const response = await request(app).post("/api/v1/schedules/generate").send({});

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(response.body.job_id).toBeUndefined();
    expect(response.body.validations.errors.length).toBeGreaterThan(0);
  });

  it("includes Zod issue paths in validation error responses", async () => {
    const payload = basePayload({
      cronograma_unique_id: "cronograma_test",
      mode: "generate",
      atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
    });
    delete (payload as unknown as Record<string, unknown>).obra_json;

    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(payload);

    expect(response.status).toBe(400);
    expect(response.body.validations.errors).toContain("obra_json: Required");
    expect(response.body.error.details.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["obra_json"], message: "Required" })
    ]));
  });

  it("returns structured JSON when the request body is malformed JSON", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/recalculate")
      .set("Content-Type", "application/json")
      .send("{\"mode\":\"recalculate\"}{");

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.metrics).toBeNull();
    expect(response.body.error.code).toBe("INVALID_JSON_BODY");
    expect(response.body.job_id).toBeUndefined();
    expect(response.body.error.message).toBe("Invalid JSON request body");
    expect(response.body.validations.errors).toEqual(["Invalid JSON request body"]);
  });

  it("accepts and sends an error webhook when schedule calculation fails", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({ obra_json: [{}], atividades_json: [] }));

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");

    const webhookBody = await waitForWebhookBody("error");
    expect(webhookBody).toMatchObject({
      job_id: response.body.job_id,
      status: "error",
      error_code: "SCHEDULE_ENGINE_ERROR",
      error_message: "obra_json[0].dataInicio e obrigatorio",
      failed_step: "calculate"
    });
  });

  it("uses route mode when request mode is empty", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        mode: "",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(202);
  });

  it("accepts and sends an error webhook when Bubble ids required for bulk persistence are missing", async () => {
    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");

    const webhookBody = await waitForWebhookBody("error");
    expect(webhookBody).toMatchObject({
      job_id: response.body.job_id,
      status: "error",
      error_code: "BUBBLE_BULK_PAYLOAD_ERROR",
      error_message: "Missing required Bubble id(s): versao_cronograma_unique_id",
      failed_step: "bulk_create"
    });
    expect(String(webhookBody.error_message)).toContain("versao_cronograma_unique_id");
  });

  it("accepts and sends an error webhook when Bubble bulk persistence fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/wf/api_cronograma__webhook_v1")) {
        return { ok: true, status: 200, text: async () => "" };
      }
      if (init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => JSON.stringify({ response: { cursor: 0, count: 0, remaining: 0, results: [] } })
        };
      }
      return {
        ok: false,
        status: 401,
        text: async () => "Unauthorized"
      };
    }));

    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");

    const webhookBody = await waitForWebhookBody("error");
    expect(webhookBody).toMatchObject({
      job_id: response.body.job_id,
      status: "error",
      error_code: "BUBBLE_BULK_REQUEST_ERROR",
      error_message: "Bubble bulk atividadexobra failed with 401: Unauthorized",
      failed_step: "bulk_create"
    });
  });

  it("accepts and sends an error webhook when Bubble API token is not configured", async () => {
    delete process.env.BUBBLE_API_TOKEN;

    const response = await request(app)
      .post("/api/v1/schedules/generate")
      .send(basePayload({
        versao_cronograma_unique_id: "versao_1",
        atividades_json: [{ id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }]
      }));

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("accepted");

    const webhookBody = await waitForWebhookBody("error");
    expect(webhookBody).toMatchObject({
      job_id: response.body.job_id,
      status: "error",
      error_code: "BUBBLE_BULK_CONFIG_ERROR",
      error_message: "BUBBLE_API_TOKEN is required to persist schedule bulks",
      failed_step: "bulk_create"
    });
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
      "Produto (raiz)": "prod_1",
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

