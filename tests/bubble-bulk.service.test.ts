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

  it("formats ISO dates and keeps invalid dates unchanged when building records", () => {
    const { payload, lines } = payloadWithOneLine();
    const [line] = lines;

    const isoRecords = buildCronogramaLinhaRecords(payload, [{ ...line, data_programada: "2026-05-04T03:00:00.000Z" }]);
    const invalidRecords = buildCronogramaLinhaRecords(payload, [{ ...line, data_programada: "not-a-date" }]);

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
      equipe: "",
      nomeProduto: "",
      ambiente: "",
      icon: ""
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
