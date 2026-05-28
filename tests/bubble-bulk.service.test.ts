import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAtividadeObraRecords, buildCronogramaLinhaRecords, persistScheduleBulks } from "../src/services/bubble-bulk.service.js";
import { normalizePayload } from "../src/services/normalize-payload.service.js";
import { runScheduleEngine } from "../src/services/schedule-engine.service.js";
import { basePayload } from "./test-helpers.js";

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

  it("posts both Bubble bulk payloads as NDJSON", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => "{\"status\":\"success\"}\n"
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, lines);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://bubble.test/version-test/api/1.1/obj/cronogramalinha/bulk");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://bubble.test/version-test/api/1.1/obj/atividadexobra/bulk");
    expect(String(fetchMock.mock.calls[0]![1]?.body)).not.toContain("[");
  });

  it("uses Bubble API version from the request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine({ bubble_api_version: "version-739n8" });

    await persistScheduleBulks(payload, lines);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://bubble.test/version-739n8/api/1.1/obj/cronogramalinha/bulk");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://bubble.test/version-739n8/api/1.1/obj/atividadexobra/bulk");
  });

  it("adds Bubble version prefix when request body sends only the branch id", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine({ bubble_api_version: "739n8" });

    await persistScheduleBulks(payload, lines);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://bubble.test/version-739n8/api/1.1/obj/cronogramalinha/bulk");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://bubble.test/version-739n8/api/1.1/obj/atividadexobra/bulk");
  });

  it("allows overriding Bubble Data API type names", async () => {
    process.env.BUBBLE_CRONOGRAMA_LINHA_TYPE = "custom_cronograma_linha";
    process.env.BUBBLE_ATIVIDADE_OBRA_TYPE = "custom_atividade_obra";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, lines);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://bubble.test/version-test/api/1.1/obj/custom_cronograma_linha/bulk");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://bubble.test/version-test/api/1.1/obj/custom_atividade_obra/bulk");
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
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 2) {
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

    await persistScheduleBulks(payload, lines);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![1]?.body)).toContain("\"ambiente x obra\"");
    expect(String(fetchMock.mock.calls[2]![1]?.body)).not.toContain("\"ambiente x obra\"");
  });

  it("ignores non-NDJSON response bodies after a successful bulk status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => "Created"
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

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      equipe: "",
      nomeProduto: "",
      ambiente: "",
      "ambiente x item composicao": "",
      "ambiente x obra": "amb_1",
      icon: ""
    });

    const atividadeObraRecordsWithoutAmbienteId = buildAtividadeObraRecords(payload, [{ ...lineWithoutOptionalValues, ambienteId: null }]);
    expect(atividadeObraRecordsWithoutAmbienteId[0]["ambiente x obra"]).toBe("");
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
      "ambiente x item composicao": "amb_item_1",
      "ambiente x obra": ""
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

  it("maps legacy Atividade x Obra typename env to Bubble API typename", async () => {
    process.env.BUBBLE_ATIVIDADE_OBRA_TYPE = "atividade_x_obra";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { payload, lines } = payloadWithOneLine();

    await persistScheduleBulks(payload, lines);

    expect(fetchMock.mock.calls[1]![0]).toBe("https://bubble.test/version-test/api/1.1/obj/atividadexobra/bulk");
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
