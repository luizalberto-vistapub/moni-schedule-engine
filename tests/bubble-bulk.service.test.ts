import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAtividadeObraRecords, buildCronogramaLinhaRecords, buildEventoCronogramaRecords, persistScheduleBulks } from "../src/services/bubble-bulk.service.js";
import { normalizePayload } from "../src/services/normalize-payload.service.js";
import { runScheduleEngine } from "../src/services/schedule-engine.service.js";
import { basePayload } from "./test-helpers.js";

type MockFetchCall = [unknown, RequestInit | undefined];
type MockFetchResponse = { ok: boolean; status: number; text: () => Promise<string> };

describe("Bubble bulk persistence", () => {
  beforeEach(() => {
    process.env.BUBBLE_API_TOKEN = "test_token";
    process.env.BUBBLE_API_BASE_URL = "https://bubble.test/";
    process.env.BUBBLE_API_VERSION = "version-test";
    process.env.BUBBLE_BULK_BATCH_SIZE = "1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BUBBLE_API_TOKEN;
    delete process.env.BUBBLE_API_BASE_URL;
    delete process.env.BUBBLE_API_VERSION;
    delete process.env.BUBBLE_BULK_BATCH_SIZE;
    delete process.env.BUBBLE_CRONOGRAMA_LINHA_TYPE;
    delete process.env.BUBBLE_ATIVIDADE_OBRA_TYPE;
    delete process.env.BUBBLE_EVENTO_CRONOGRAMA_TYPE;
  });

  function payloadWithOneLine(overrides: Record<string, unknown> = {}) {
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ "unique id": "obra_1", dataInicio: "2026-05-04", name: "Obra por name" }],
      obra_ambiente_json: [{ "unique id": "amb_1", name: "Sala", icon_image: "//s3.amazonaws.com/icon.png" }],
      obra_ambiente_produto_json: [{ "unique id": "oap_1", "ambiente x obra": "amb_1", produto: "prod_1", "nome produto": "Piso", quantidade: 1 }],
      atividades_json: [{ "unique id": "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, equipe: "Equipe", peso: 1 }],
      ...overrides
    }));
    const result = runScheduleEngine(payload);

    return { payload, lines: result.lines };
  }

  function atividadeObraLookupResponse(results: Record<string, unknown>[] = []): MockFetchResponse {
    return {
      ok: true,
      status: 200,
      text: async (): Promise<string> => JSON.stringify({
        response: {
          cursor: 0,
          count: results.length,
          remaining: 0,
          results
        }
      })
    };
  }

  function findFetchCall(fetchMock: { mock: { calls: unknown[][] } }, path: string, method: string): MockFetchCall | undefined {
    return fetchMock.mock.calls.find((call) => {
      const init = call[1] as RequestInit | undefined;
      return String(call[0]).includes(path) && init?.method === method;
    }) as MockFetchCall | undefined;
  }

  function findFetchCalls(fetchMock: { mock: { calls: unknown[][] } }, path: string, method: string): MockFetchCall[] {
    return fetchMock.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return String(call[0]).includes(path) && init?.method === method;
    }) as MockFetchCall[];
  }

  it("posts Atividade x Obra bulk payload as NDJSON while cronogramaLinha is paused", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => "{\"status\":\"success\"}\n"
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, lines);

    const bulkCall = findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/bulk", "POST");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bulkCall?.[0]).toBe("https://bubble.test/version-test/api/1.1/obj/atividadexobra/bulk");
    expect(() => JSON.parse(String(bulkCall?.[1]?.body))).not.toThrow();
    expect(Array.isArray(JSON.parse(String(bulkCall?.[1]?.body)))).toBe(false);
  });

  it("uses Bubble API version from the request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine({ bubble_api_version: "version-739n8" });

    await persistScheduleBulks(payload, lines);

    expect(findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/bulk", "POST")?.[0]).toBe("https://bubble.test/version-739n8/api/1.1/obj/atividadexobra/bulk");
  });

  it("adds Bubble version prefix when request body sends only the branch id", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine({ bubble_api_version: "739n8" });

    await persistScheduleBulks(payload, lines);

    expect(findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/bulk", "POST")?.[0]).toBe("https://bubble.test/version-739n8/api/1.1/obj/atividadexobra/bulk");
  });

  it("allows overriding Bubble Data API type names", async () => {
    process.env.BUBBLE_CRONOGRAMA_LINHA_TYPE = "custom_cronograma_linha";
    process.env.BUBBLE_ATIVIDADE_OBRA_TYPE = "custom_atividade_obra";
    process.env.BUBBLE_EVENTO_CRONOGRAMA_TYPE = "custom_evento_cronograma";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, lines);

    expect(findFetchCall(fetchMock, "/api/1.1/obj/custom_atividade_obra/bulk", "POST")?.[0]).toBe("https://bubble.test/version-test/api/1.1/obj/custom_atividade_obra/bulk");
  });

  it("builds active EventoCronograma records from old and new events", () => {
    const { payload } = payloadWithOneLine({
      event_date: "2026-05-07",
      events_old: [{
        tipo: "Adiar início da atividade",
        atividade: "atividade_1",
        id_atividade_obra_externo: "atividade_1_2026-05-04_1",
        data: "2026-05-08"
      }],
      events_json: [{
        type: "activity_start_delayed",
        atividade_id: "atividade_2",
        id_atividade_obra_externo: "atividade_2_2026-05-04_1",
        new_start_date: "2026-05-11"
      }]
    });

    expect(buildEventoCronogramaRecords(payload)).toEqual([
      {
        atividade: "atividade_1",
        cronograma: "cronograma_1",
        data: "2026-05-08T12:00:00.000Z",
        dias: 0,
        id_atividade_obra_externo: "atividade_1_2026-05-04_1",
        tipo: "Adiar início da atividade",
        obra: "obra_1",
        requisicao_data: "2026-05-07T12:00:00.000Z",
        versaoCronograma: "versao_1"
      },
      {
        atividade: "atividade_2",
        cronograma: "cronograma_1",
        data: "2026-05-11T12:00:00.000Z",
        dias: 0,
        id_atividade_obra_externo: "atividade_2_2026-05-04_1",
        tipo: "Adiar início da atividade",
        obra: "obra_1",
        requisicao_data: "2026-05-07T12:00:00.000Z",
        versaoCronograma: "versao_1"
      }
    ]);
  });

  it("posts EventoCronograma bulk when active events exist", async () => {
    process.env.BUBBLE_BULK_BATCH_SIZE = "500";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine({
      event_date: "2026-05-06",
      events_json: [{ type: "work_start_delayed", new_start_date: "2026-05-08" }]
    });

    await persistScheduleBulks(payload, lines);

    const eventCall = findFetchCall(fetchMock, "/api/1.1/obj/eventocronograma/bulk", "POST");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(eventCall?.[0]).toBe("https://bubble.test/version-test/api/1.1/obj/eventocronograma/bulk");
    expect(JSON.parse(String(eventCall?.[1]?.body))).toMatchObject({
      cronograma: "cronograma_1",
      data: "2026-05-08T12:00:00.000Z",
      tipo: "Adiar início da obra",
      obra: "obra_1",
      requisicao_data: "2026-05-06T12:00:00.000Z",
      versaoCronograma: "versao_1"
    });
  });

  it("maps EventoCronograma event types to Bubble option set display values", () => {
    const { payload } = payloadWithOneLine({
      events_json: [
        { type: "work_start_delayed", new_start_date: "2026-05-08" },
        { type: "activity_start_delayed", atividade_id: "atividade_1", new_start_date: "2026-05-09" },
        { type: "from_date_delayed", from: "2026-05-10", days: 2 },
        { type: "activity_inserted", atividade_id: "atividade_2" }
      ]
    });

    expect(buildEventoCronogramaRecords(payload).map((record) => record.tipo)).toEqual([
      "Adiar início da obra",
      "Adiar início da atividade",
      "Paralisar a obra",
      "Inserida nova atividade"
    ]);
  });

  it("handles sparse EventoCronograma events defensively", () => {
    const { payload } = payloadWithOneLine({
      events_json: [
        { ignored: true },
        { type: "activity_start_delayed" },
        { type: "activity_inserted", _id: "event_1" },
        { type: "activity_inserted" },
        { type: "custom_event", dias: "3" },
        { type: "custom_event_invalid_days", dias: "abc" }
      ]
    });

    expect(buildEventoCronogramaRecords(payload)).toEqual([
      expect.objectContaining({ atividade: "", tipo: "Adiar início da atividade" }),
      expect.objectContaining({ tipo: "Inserida nova atividade" }),
      expect.objectContaining({ tipo: "Inserida nova atividade" }),
      expect.objectContaining({ data: "", dias: 3, tipo: "custom_event" }),
      expect.objectContaining({ dias: 0, tipo: "custom_event_invalid_days" })
    ]);
  });

  it("throws when Bubble returns a row-level status error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => "{\"status\":\"error\",\"message\":\"bad row\"}\n"
    })));
    const { payload, lines } = payloadWithOneLine();

    await expect(persistScheduleBulks(payload, lines)).rejects.toThrow("row error");
  });

  it("throws when Bubble returns a row-level success false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => "{\"success\":false,\"message\":\"bad row\"}\n"
    })));
    const { payload, lines } = payloadWithOneLine();

    await expect(persistScheduleBulks(payload, lines)).rejects.toThrow("row error");
  });

  it("retries Atividade x Obra without ambiente x obra when Bubble rejects the reference", async () => {
    const log = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
    let atividadeObraPostAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      if (_init?.method === "GET") return atividadeObraLookupResponse();
      atividadeObraPostAttempts += 1;
      if (atividadeObraPostAttempts === 1) {
        return {
          ok: false,
          status: 400,
          text: async (): Promise<string> => "{\"status\":\"error\",\"message\":\"Invalid data for field ambiente x obra: object with this id does not exist\",\"body\":{\"statusCode\":400,\"body\":{\"status\":\"MISSING_DATA\"}}}\n"
        };
      }

      return {
        ok: true,
        text: async (): Promise<string> => ""
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, lines, { requestId: "req_retry", log });

    const atividadeObraPostCalls = findFetchCalls(fetchMock, "/api/1.1/obj/atividadexobra/bulk", "POST");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(atividadeObraPostCalls[0]?.[1]?.body)).toContain("\"ambiente x obra\"");
    expect(String(atividadeObraPostCalls[1]?.[1]?.body)).not.toContain("\"ambiente x obra\"");
    expect((log as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req_retry",
      statusCode: 400
    }), "retrying atividade obra bulk without ambiente x obra reference");
  });

  it("updates existing Atividade x Obra records by external id instead of creating duplicates", async () => {
    const { payload, lines } = payloadWithOneLine();
    const externalId = lines[0]!.atividade_obra_id_externo;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return atividadeObraLookupResponse([{ _id: "existing_axo_1", id_atividade_obra_externo: externalId }]);
      }
      return {
        ok: true,
        status: 204,
        text: async (): Promise<string> => ""
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await persistScheduleBulks(payload, lines);

    const patchCall = findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/existing_axo_1", "PATCH");
    expect(findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/bulk", "POST")).toBeUndefined();
    expect(patchCall?.[0]).toBe("https://bubble.test/version-test/api/1.1/obj/atividadexobra/existing_axo_1");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      id_atividade_obra_externo: externalId,
      versaoCronograma: "versao_1"
    });
  });

  it("creates only missing Atividade x Obra records when some external ids already exist", async () => {
    process.env.BUBBLE_BULK_BATCH_SIZE = "500";
    const { payload, lines } = payloadWithOneLine();
    const existingLine = lines[0]!;
    const missingLine = {
      ...existingLine,
      atividadeId: "serv_2",
      atividade_obra_id_externo: "serv_2_2026-05-05_1",
      data_programada: "2026-05-05"
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return atividadeObraLookupResponse([{ _id: "existing_axo_1", id_atividade_obra_externo: existingLine.atividade_obra_id_externo }]);
      }
      return {
        ok: true,
        status: init?.method === "PATCH" ? 204 : 200,
        text: async (): Promise<string> => init?.method === "PATCH" ? "" : "{\"status\":\"success\",\"id\":\"created_axo_1\"}\n"
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await persistScheduleBulks(payload, [existingLine, missingLine]);

    const postCall = findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/bulk", "POST");
    const postedRows = String(postCall?.[1]?.body).split(/\r?\n/).filter(Boolean).map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/existing_axo_1", "PATCH")).toBeDefined();
    expect(postedRows).toHaveLength(1);
    expect(postedRows[0]).toMatchObject({ id_atividade_obra_externo: "serv_2_2026-05-05_1" });
  });

  it("ignores non-NDJSON response bodies after a successful bulk status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "GET" ? atividadeObraLookupResponse() : ({
      ok: true,
      text: async (): Promise<string> => "Created"
    })));
    const { payload, lines } = payloadWithOneLine();

    await expect(persistScheduleBulks(payload, lines)).resolves.toBeUndefined();
  });

  it("uses defaults for invalid batch size and accepts numeric id fallbacks", async () => {
    process.env.BUBBLE_BULK_BATCH_SIZE = "0";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine({
      versao_cronograma_unique_id: undefined,
      versaoCronograma: 123,
      obra_json: [{ _id: 456, dataInicio: "2026-05-04" }]
    });

    await persistScheduleBulks(payload, lines);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("accepts partial bulk created id responses", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const rows = String(init?.body || "").split(/\r?\n/).filter(Boolean);
      return {
        ok: true,
        text: async () => rows.length > 1 ? "{\"id\":\"only_one\"}" : ""
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, [lines[0]!, { ...lines[0]!, atividade_obra_id_externo: "atividade_2_2026-05-05_1" }]);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty records when required ids are absent", () => {
    const { payload, lines } = payloadWithOneLine({
      versao_cronograma_unique_id: undefined,
      obra_json: [{ dataInicio: "2026-05-04" }]
    });

    expect(buildCronogramaLinhaRecords(payload, lines)).toEqual([]);
    expect(buildAtividadeObraRecords(payload, lines)).toEqual([]);
  });

  it("formats date-only values at noon UTC and keeps invalid dates unchanged when building records", () => {
    const { payload, lines } = payloadWithOneLine();
    const [line] = lines;

    const dateOnlyRecords = buildCronogramaLinhaRecords(payload, [{ ...line, data_programada: "2026-05-04" }]);
    const isoRecords = buildCronogramaLinhaRecords(payload, [{ ...line, data_programada: "2026-05-04T03:00:00.000Z" }]);
    const invalidRecords = buildCronogramaLinhaRecords(payload, [{ ...line, data_programada: "not-a-date" }]);

    expect(dateOnlyRecords[0].data_programada).toBe("2026-05-04T12:00:00.000Z");
    expect(isoRecords[0].data_programada).toBe("2026-05-04T03:00:00.000Z");
    expect(invalidRecords[0].data_programada).toBe("not-a-date");
  });

  it("requires Bubble API version in the request body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => ""
    })));
    const { payload, lines } = payloadWithOneLine({ bubble_api_version: undefined });

    await expect(persistScheduleBulks(payload, lines)).rejects.toThrow("bubble_api_version");
  });

  it("logs invalid required Bubble field values before rejecting persistence", async () => {
    const log = { warn: vi.fn() } as unknown as Logger;
    const { payload, lines } = payloadWithOneLine({
      bubble_api_version: { branch: "version-test" },
      versao_cronograma_unique_id: ["versao_1"],
      obra_json: [{ id: null, dataInicio: "2026-05-04" }]
    });

    await expect(persistScheduleBulks(payload, lines, { requestId: "req_1", log })).rejects.toThrow("bubble_api_version");

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req_1",
      missingFields: ["bubble_api_version", "versao_cronograma_unique_id", "obra_json[0].unique id"],
      invalidFields: [
        {
          field: "bubble_api_version",
          receivedValue: { branch: "version-test" },
          receivedType: "object",
          normalizedValue: null,
          reason: "invalid"
        },
        {
          field: "versao_cronograma_unique_id",
          receivedValue: ["versao_1"],
          receivedType: "array",
          normalizedValue: null,
          reason: "invalid"
        },
        {
          field: "obra_json[0].unique id",
          receivedValue: null,
          receivedType: "null",
          normalizedValue: null,
          reason: "missing_or_blank"
        }
      ]
    }), "missing required Bubble ids");
  });

  it("logs undefined received value when the obra record itself is missing", async () => {
    const log = { warn: vi.fn() } as unknown as Logger;
    const { payload, lines } = payloadWithOneLine();
    const payloadWithoutObra = { ...payload, obra_json: [] };

    await expect(persistScheduleBulks(payloadWithoutObra, lines, { log })).rejects.toThrow("obra_json[0].unique id");

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      invalidFields: [
        {
          field: "obra_json[0].unique id",
          receivedValue: undefined,
          receivedType: "undefined",
          normalizedValue: null,
          reason: "missing_or_blank"
        }
      ]
    }), "missing required Bubble ids");
  });

  it("uses empty strings for optional line values when building records", () => {
    const { payload, lines } = payloadWithOneLine();
    const [line] = lines;
    const lineWithoutOptionalValues = {
      ...line,
      ambiente: null,
      produto: null,
      subtipo_compra: null,
      equipe: null,
      anchor_service_name: null
    };

    const cronogramaLinhaRecords = buildCronogramaLinhaRecords(payload, [lineWithoutOptionalValues]);
    const atividadeObraRecords = buildAtividadeObraRecords(payload, [lineWithoutOptionalValues]);

    expect(cronogramaLinhaRecords[0]).toMatchObject({
      subtipo_compra: "",
      equipe: "",
      ambiente: "",
      produto: "",
      nome_servico_ancora: ""
    });
    expect(atividadeObraRecords[0]).toMatchObject({
      atividade: line.atividadeId,
      id_atividade_obra_externo: line.atividade_obra_id_externo,
      versaoCronograma: "versao_1",
      equipe: "",
      nomeProduto: "",
      "Produto (raiz)": line.produtoId,
      ambiente: "",
      "ambiente x item composicao": "",
      "ambiente x obra": "amb_1",
      icon: "",
      valorRaiz: 0
    });
    expect(atividadeObraRecords[0]).not.toHaveProperty("interdependencias MASTER (Atividade x Obra)");

    const atividadeObraRecordsWithoutAmbienteId = buildAtividadeObraRecords(payload, [{ ...lineWithoutOptionalValues, ambienteId: null }]);
    expect(atividadeObraRecordsWithoutAmbienteId[0]["ambiente x obra"]).toBe("");
  });

  it("sends activity responsible to Atividade x Obra bulk records", () => {
    const { payload, lines } = payloadWithOneLine({
      atividades_json: [{ "unique id": "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, "responsável": "user_responsavel_1" }]
    });

    const [record] = buildAtividadeObraRecords(payload, lines);

    expect(record).toMatchObject({
      atividade: "serv_1",
      responsavel: "user_responsavel_1"
    });
  });

  it("uses activity responsible when previous Atividade x Obra record has blank responsible", () => {
    const { payload, lines } = payloadWithOneLine({
      atividades_json: [{ "unique id": "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, responsavel: "Loja Moní" }],
      atividade_obra_json: [{
        atividade: "serv_1",
        indice_clone: 1,
        id_atividade_obra_externo: "serv_1_2026-05-04_1",
        responsavel: ""
      }]
    });

    const [record] = buildAtividadeObraRecords(payload, lines);

    expect(record.responsavel).toBe("Loja Moní");
  });

  it("preserves hydrated Atividade x Obra fields from the previous schedule records", () => {
    const { payload, lines } = payloadWithOneLine({
      atividade_obra_json: [{
        atividade: "serv_1",
        indice_clone: 1,
        id_atividade_obra_externo: "serv_1_2026-05-04_1",
        responsavel: "Franqueado",
        responsavelFranqueado: "user_1",
        sortOcorrencia: "2026-05-04|serv_1",
        sortTipo: "Servico|001",
        status: "Em andamento",
        statusCompra: "Compra aprovada",
        statusProjeto: "Projeto recebido",
        statusOcorrencia: "Sem ocorrencia"
      }]
    });

    const [record] = buildAtividadeObraRecords(payload, [{ ...lines[0]!, data_programada: "2026-05-06", atividade_obra_id_externo: "serv_1_2026-05-06_1" }]);

    expect(record).toMatchObject({
      id_atividade_obra_externo: "serv_1_2026-05-06_1",
      dataInicioPrevista: "2026-05-06T12:00:00.000Z",
      responsavel: "Franqueado",
      responsavelFranqueado: "user_1",
      sortOcorrencia: "2026-05-04|serv_1",
      sortTipo: "Servico|001",
      status: "Em andamento",
      statusCompra: "Compra aprovada",
      statusProjeto: "Projeto recebido",
      statusOcorrencia: "Sem ocorrencia"
    });
  });

  it("sends composition ambiente reference to the Bubble ambiente x item composicao field", () => {
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ "unique id": "obra_1", dataInicio: "2026-05-04" }],
      obra_ambiente_json: [{ "unique id": "amb_item_1", name: "Sala" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [{
        "unique id": "item_servico_1",
        "id ambiente item composicao": "amb_item_1",
        "id produto composto": "composto_1",
        "id produto simples": "prod_servico",
        "nome produto simples": "Mao de obra"
      }],
      atividades_json: [{ "unique id": "serv_1", nome: "Servico", tipo: "Servico", produto: "prod_servico", ordem: 1, duracao: 1 }]
    }));
    const result = runScheduleEngine(payload);

    const [record] = buildAtividadeObraRecords(payload, result.lines);

    expect(record).toMatchObject({
      atividade: "serv_1",
      id_atividade_obra_externo: result.lines[0]!.atividade_obra_id_externo,
      versaoCronograma: "versao_1",
      "ambiente x item composicao": "amb_item_1",
      "ambiente x obra": ""
    });
  });

  it("calculates Atividade x Obra valorRaiz from composition value and activity percentage", () => {
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ "unique id": "obra_1", dataInicio: "2026-05-04" }],
      obra_ambiente_json: [{ "unique id": "amb_item_1", name: "Sala" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        {
          "unique id": "item_servico_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "id produto simples": "prod_servico",
          "nome produto simples": "Mao de obra",
          valor: 1000
        },
        {
          "unique id": "item_compra_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "id produto simples": "prod_compra",
          "nome produto simples": "Material compra",
          valor: 600
        }
      ],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", produto: "prod_servico", ordem: 1, duracao: 3, percentual: 0.3 },
        { id: "comp_aviso", nome: "Aviso", tipo: "Compra", produto: "prod_compra", ordem: 1, atividadeServicoAncoraId: "composto_1", etapaCompra: "Aviso de orcamento", diasAntecedencia: 30, percentual: 0.25 },
        { id: "comp_lim_orc", nome: "Limite orcamento", tipo: "Compra", produto: "prod_compra", ordem: 1, atividadeServicoAncoraId: "composto_1", etapaCompra: "Limite de orcamento", diasAntecedencia: 28, percentual: 0.25 },
        { id: "comp_lim_compra", nome: "Limite compra", tipo: "Compra", produto: "prod_compra", ordem: 1, atividadeServicoAncoraId: "composto_1", etapaCompra: "Limite de compra", diasAntecedencia: 14, percentual: 0.25 },
        { id: "comp_receb", nome: "Recebimento", tipo: "Compra", produto: "prod_compra", ordem: 1, atividadeServicoAncoraId: "composto_1", etapaCompra: "Recebimento", diasAntecedencia: 2, percentual: 0.25 }
      ]
    }));
    const result = runScheduleEngine(payload);

    const records = buildAtividadeObraRecords(payload, result.lines);
    const serviceValorRaiz = records
      .filter((record) => record.atividade === "serv_1")
      .map((record) => record.valorRaiz);
    const purchaseValorRaiz = records
      .filter((record) => String(record.atividade).startsWith("comp_"))
      .map((record) => record.valorRaiz);

    expect(serviceValorRaiz).toEqual([100, 100, 100]);
    expect(purchaseValorRaiz).toEqual([150, 150, 150, 150]);
  });

  it("includes the contextual product in Projeto Atividade x Obra names", () => {
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ "unique id": "obra_1", dataInicio: "2026-05-04" }],
      obra_ambiente_produto_json: [
        { id: "oap_1", ambienteId: "amb_1", produtoId: "prod_1", produtoNome: "Produto simples Vivi 1 - Serviço", quantidade: 1 }
      ],
      atividades_json: [
        {
          id: "serv_1",
          nome: "Servico 1",
          tipo: "Servico",
          produto: "prod_1",
          ordem: 1,
          duracao: 1,
          atividadeProjeto: [{ idAtividadeProjeto: "proj_1", nomeAtividadeProjeto: "pj 2p1 - 03/06", diasAntecedencia: 2 }]
        },
        { id: "compra_1", nome: "Compra", tipo: "Compra", produto: "prod_1", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "serv_1" },
        { id: "proj_1", nome: "pj 2p1 - 03/06 - ", tipo: "Projeto", ordem: 1, duracao: 1, produto: "", atividadeServicoAncoraId: "" }
      ]
    }));
    const result = runScheduleEngine(payload);
    const projectLine = result.lines.find((line) => line.tipo === "Projeto")!;

    const [record] = buildAtividadeObraRecords(payload, [projectLine]);
    const [cronogramaRecord] = buildCronogramaLinhaRecords(payload, [projectLine]);

    expect(record).toMatchObject({
      nomeAtividade: "pj 2p1 - 03/06 - Produto simples Vivi 1 - Serviço",
      nomeProduto: "Produto simples Vivi 1 - Serviço",
      "Produto (raiz)": "prod_1",
      tipo: "Projeto"
    });
    expect(cronogramaRecord).toMatchObject({
      nome_atividade: "pj 2p1 - 03/06 - ",
      produto: "Produto simples Vivi 1 - Serviço"
    });
  });

  it("marks Atividade x Obra cloned duration after the first clone", () => {
    const { payload, lines } = payloadWithOneLine();
    const [line] = lines;

    const records = buildAtividadeObraRecords(payload, [
      { ...line, clone_index: 1 },
      { ...line, clone_index: 2 }
    ]);

    expect(records.map((record) => record.copyDuracao)).toEqual([false, true]);
    expect(records[0]).not.toHaveProperty("copyduracao");
    expect(records[0]).not.toHaveProperty("copyduracao_boolean");
  });

  it("patches atividade obra dependency relations after resolving created Bubble ids", async () => {
    process.env.BUBBLE_BULK_BATCH_SIZE = "500";
    let postCallIndex = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
      const method = init?.method || "POST";
      if (method === "GET") return atividadeObraLookupResponse();
      if (method === "PATCH") {
        return { ok: true, status: 204, text: async () => "" };
      }

      postCallIndex += 1;
      const body = String(init?.body || "");
      const rows = body.split(/\r?\n/).filter(Boolean);
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => rows.map((_row, index) => JSON.stringify({ status: "success", id: `bubble_${postCallIndex}_${index + 1}` })).join("\n")
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ "unique id": "obra_1", dataInicio: "2026-05-04" }],
      atividades_json: [
        { id: "base", nome: "Base", tipo: "Servico", ordem: 1, duracao: 2 },
        { id: "dependente", nome: "Dependente", tipo: "Servico", ordem: 2, duracao: 1, interdependenciasMasterIds: ["base"] }
      ]
    }));
    const result = runScheduleEngine(payload);

    await persistScheduleBulks(payload, result.lines);

    const patchCall = fetchMock.mock.calls.find((call) => call[1]?.method === "PATCH");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(patchCall?.[0])).toContain("/api/1.1/obj/atividadexobra/bubble_1_3");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      "interdependencias MASTER (Atividade x Obra)": ["bubble_1_1", "bubble_1_2"]
    });
  });

  it("throws when atividade obra dependency ids cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: { cursor: 0, count: 0, remaining: 0, results: [] } })
    })));
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ "unique id": "obra_1", dataInicio: "2026-05-04" }],
      atividades_json: [
        { id: "base", nome: "Base", tipo: "Servico", ordem: 1, duracao: 1 },
        { id: "dependente", nome: "Dependente", tipo: "Servico", ordem: 2, duracao: 1, interdependenciasMasterIds: ["base"] }
      ]
    }));
    const result = runScheduleEngine(payload);

    await expect(persistScheduleBulks(payload, result.lines)).rejects.toThrow("Could not resolve Bubble atividade x obra dependency ids");
  });

  it("throws when atividade obra dependency patch fails", async () => {
    const log = { error: vi.fn(), info: vi.fn() } as unknown as Logger;
    let postCallIndex = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
      const method = init?.method || "POST";
      if (method === "GET") return atividadeObraLookupResponse();
      if (method === "PATCH") {
        return { ok: false, status: 400, text: async () => "bad patch" };
      }

      postCallIndex += 1;
      const body = String(init?.body || "");
      const rows = body.split(/\r?\n/).filter(Boolean);
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => rows.map((_row, index) => JSON.stringify({ status: "success", id: `bubble_${postCallIndex}_${index + 1}` })).join("\n")
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const payload = normalizePayload(basePayload({
      versao_cronograma_unique_id: "versao_1",
      cronograma_unique_id: "cronograma_1",
      obra_json: [{ "unique id": "obra_1", dataInicio: "2026-05-04" }],
      atividades_json: [
        { id: "base", nome: "Base", tipo: "Servico", ordem: 1, duracao: 1 },
        { id: "dependente", nome: "Dependente", tipo: "Servico", ordem: 2, duracao: 1, interdependenciasMasterIds: ["base"] }
      ]
    }));
    const result = runScheduleEngine(payload);

    await expect(persistScheduleBulks(payload, result.lines, { requestId: "req_patch", log })).rejects.toThrow("Bubble atividade obra dependency patch failed with 400: bad patch");
    expect((log as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req_patch",
      statusCode: 400,
      responseText: "bad patch"
    }), "atividade obra dependency patch failed");
  });

  it("maps legacy Atividade x Obra typename env to Bubble API typename", async () => {
    process.env.BUBBLE_ATIVIDADE_OBRA_TYPE = "atividade_x_obra";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, lines);

    expect(findFetchCall(fetchMock, "/api/1.1/obj/atividadexobra/bulk", "POST")?.[0]).toBe("https://bubble.test/version-test/api/1.1/obj/atividadexobra/bulk");
  });

  it("reports missing obra id when version id is present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => ""
    })));
    const { payload, lines } = payloadWithOneLine({
      obra_json: [{ dataInicio: "2026-05-04" }]
    });

    await expect(persistScheduleBulks(payload, lines)).rejects.toThrow("obra_json[0].unique id");
  });
});
