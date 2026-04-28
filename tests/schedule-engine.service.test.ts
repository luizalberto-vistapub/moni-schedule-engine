import { describe, expect, it } from "vitest";
import { addBusinessDays, isBusinessDay, nextBusinessDay, previousBusinessDay } from "../src/services/business-days.service.js";
import { normalizePayload } from "../src/services/normalize-payload.service.js";
import { buildScheduleResponse } from "../src/services/response-builder.service.js";
import { runScheduleEngine } from "../src/services/schedule-engine.service.js";
import { parseDateOnly, formatDateOnly } from "../src/utils/dates.js";
import { basePayload } from "./test-helpers.js";

describe("schedule engine", () => {
  it("duracao fixa gera N clones", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico fixo", tipo: "Servico", ordem: 1, duracao: 3, duracaoVariavel: false, peso: 2 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines).toHaveLength(3);
    expect(result.lines.map((line) => line.clone_index)).toEqual([1, 2, 3]);
  });

  it("duracao variavel calcula ceil(duracao * quantidade / quantidadeBase)", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [{ id: "oap_1", quantidade: 15 }],
      atividades_json: [
        { id: "serv_1", nome: "Servico variavel", tipo: "Servico", ordem: 1, duracao: 2, duracaoVariavel: true, quantidadeBase: 5, peso: 2 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines).toHaveLength(6);
  });

  it("associa cada atividade ao produto e ambiente correspondentes", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [
        { id: "amb_garagem", nome: "Garagem" },
        { id: "amb_social", nome: "Area Social" }
      ],
      obra_ambiente_produto_json: [
        { id: "oap_p2", ambienteId: "amb_social", produto: "prod_2", "nome produto": "PRODUTO 2", quantidade: 60 },
        { id: "oap_p1", ambienteId: "amb_garagem", produto: "prod_1", "nome produto": "PRODUTO 1", quantidade: 150 },
        { id: "oap_p3", ambienteId: "amb_garagem", produto: "prod_3", "nome produto": "PRODUTO 3", quantidade: 1 }
      ],
      atividades_json: [
        {
          id: "serv_p1",
          nome: "Servico P1",
          tipo: "Servico",
          produto: "prod_1",
          ordem: 1,
          duracao: 4,
          duracaoVariavel: true,
          quantidadeBase: 50,
          peso: 3,
          equipe: "Paisagismo"
        },
        {
          id: "serv_p2",
          nome: "Servico P2",
          tipo: "Servico",
          produto: "prod_2",
          ordem: 1,
          duracao: 1,
          peso: 1,
          equipe: "Civil"
        },
        {
          id: "compra_p1",
          nome: "Compra P1",
          tipo: "Compra",
          produto: "prod_1",
          ordem: 1,
          atividadeServicoAncoraId: "serv_p1",
          etapaCompra: "Recebimento",
          diasAntecedencia: 1
        }
      ]
    }));

    const result = runScheduleEngine(payload);
    const p1ServiceLines = result.lines.filter((line) => line.atividadeId === "serv_p1");
    const p2Service = result.lines.find((line) => line.atividadeId === "serv_p2");
    const p1Purchase = result.lines.find((line) => line.atividadeId === "compra_p1");

    expect(p1ServiceLines).toHaveLength(12);
    expect(p1ServiceLines[0]).toMatchObject({
      obraAmbienteProdutoId: "oap_p1",
      produtoId: "prod_1",
      produto: "PRODUTO 1",
      ambiente: "Garagem"
    });
    expect(p2Service).toMatchObject({
      obraAmbienteProdutoId: "oap_p2",
      produtoId: "prod_2",
      produto: "PRODUTO 2",
      ambiente: "Area Social"
    });
    expect(p1Purchase).toMatchObject({
      obraAmbienteProdutoId: "oap_p1",
      produtoId: "prod_1",
      produto: "PRODUTO 1",
      ambiente: "Garagem"
    });
  });

  it("payload com quantidadeBase vazia normaliza para null", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", quantidadeBase: "", duracao: 1 }
      ]
    }));

    expect(payload.atividades_json[0].quantidadeBase).toBeNull();
  });

  it("resposta contem cronograma e lines com o mesmo tamanho", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico fixo", tipo: "Servico", ordem: 1, duracao: 2, duracaoVariavel: false }
      ]
    }));
    const result = runScheduleEngine(payload);
    const response = buildScheduleResponse(result, new Date());

    expect(response.cronograma).toHaveLength(response.lines.length);
    expect(response.scheduleLines).toHaveLength(response.lines.length);
    expect(response.cronogramaLinhas).toHaveLength(response.lines.length);
    expect(response.activityObras).toHaveLength(response.lines.length);
  });

  it("normaliza aliases, ids fallback, etapaCompra e interdependencias", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { unique_id: "serv_unique", name: "Servico por name", tipo: "Servico", quantidadeBase: "0", etapaCompra: "aviso de orcamento", interdependenciasMasterIds: "bad" as never },
        { tipo: "Compra", atividadeServicoAncoraId: "serv_unique", etapaCompra: "recebimento" }
      ]
    }));

    expect(payload.atividades_json[0].id).toBe("serv_unique");
    expect(payload.atividades_json[0].nome).toBe("Servico por name");
    expect(payload.atividades_json[0].quantidadeBase).toBeNull();
    expect(payload.atividades_json[0].interdependenciasMasterIds).toEqual([]);
    expect(payload.atividades_json[1].id).toBe("atividade_2");
    expect(payload.atividades_json[1].etapaCompra).toBe("RECEBIMENTO");
  });

  it("rejeita tipo de atividade invalido", () => {
    expect(() => normalizePayload(basePayload({
      atividades_json: [{ id: "x", nome: "X", tipo: "Outra" as never }]
    }))).toThrow("Tipo de atividade invalido");
  });

  it("respeita dias uteis, sabado opcional, dependencia e peso diario", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 5,
      obra_json: [{ id: "obra_1", dataInicio: "2026-05-03" }],
      atividades_json: [
        { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1, peso: 6 },
        { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1, peso: 6 },
        { id: "serv_3", nome: "Servico 3", tipo: "Servico", ordem: 3, duracao: 1, interdependenciasMasterIds: ["serv_2"] }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.data_programada)).toEqual(["2026-05-04", "2026-05-05", "2026-05-06"]);
    expect(isBusinessDay(parseDateOnly("2026-05-09"), 5)).toBe(false);
    expect(isBusinessDay(parseDateOnly("2026-05-09"), 6)).toBe(true);
    expect(formatDateOnly(nextBusinessDay(parseDateOnly("2026-05-03"), 5))).toBe("2026-05-04");
    expect(formatDateOnly(previousBusinessDay(parseDateOnly("2026-05-03"), 5))).toBe("2026-05-01");
    expect(formatDateOnly(addBusinessDays(parseDateOnly("2026-05-08"), 1, 6))).toBe("2026-05-09");
  });

  it("inicia dependente apos o ultimo clone da dependencia", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "base", nome: "Base", tipo: "Servico", ordem: 1, duracao: 3, peso: 2 },
        { id: "dependente", nome: "Dependente", tipo: "Servico", ordem: 1, duracao: 1, peso: 2, interdependenciasMasterIds: ["base"] }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => [line.atividadeId, line.data_programada])).toEqual([
      ["base", "2026-05-04"],
      ["base", "2026-05-05"],
      ["base", "2026-05-06"],
      ["dependente", "2026-05-07"]
    ]);
  });

  it("inicia uma ordem somente apos a ordem anterior terminar", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "ordem_1_a", nome: "Ordem 1 A", tipo: "Servico", ordem: 1, duracao: 2, peso: 5, equipe: "Civil" },
        { id: "ordem_1_b", nome: "Ordem 1 B", tipo: "Servico", ordem: 1, duracao: 3, peso: 5, equipe: "Paisagismo" },
        { id: "ordem_2", nome: "Ordem 2", tipo: "Servico", ordem: 2, duracao: 1, peso: 1, equipe: "Civil" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const ordem2 = result.lines.find((line) => line.atividadeId === "ordem_2");

    expect(result.lines.filter((line) => line.atividadeId === "ordem_1_a").map((line) => line.data_programada)).toEqual(["2026-05-04", "2026-05-05"]);
    expect(result.lines.filter((line) => line.atividadeId === "ordem_1_b").map((line) => line.data_programada)).toEqual(["2026-05-04", "2026-05-05", "2026-05-06"]);
    expect(ordem2?.data_programada).toBe("2026-05-07");
  });

  it("mantem progresso quando ha ciclo de dependencia na mesma ordem", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "ciclo_a", nome: "Ciclo A", tipo: "Servico", ordem: 1, duracao: 1, peso: 1, interdependenciasMasterIds: ["ciclo_b"] },
        { id: "ciclo_b", nome: "Ciclo B", tipo: "Servico", ordem: 1, duracao: 1, peso: 1, interdependenciasMasterIds: ["ciclo_a"] }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((line) => line.atividadeId)).toEqual(["ciclo_a", "ciclo_b"]);
    expect(result.lines.map((line) => line.data_programada)).toEqual(["2026-05-04", "2026-05-05"]);
  });

  it("calcula limite de peso por equipe no mesmo dia", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "civil_1", nome: "Civil 1", tipo: "Servico", ordem: 1, duracao: 1, peso: 7, equipe: "Civil" },
        { id: "paisagismo_1", nome: "Paisagismo 1", tipo: "Servico", ordem: 1, duracao: 1, peso: 7, equipe: "Paisagismo" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.data_programada)).toEqual(["2026-05-04", "2026-05-04"]);
  });

  it("usa createdAt como desempate quando mesma ordem e mesma equipe passam de peso 10", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "nova", nome: "Nova", tipo: "Servico", ordem: 1, duracao: 1, peso: 6, equipe: "Civil", createdAt: "2026-04-12T00:00:00.000Z" },
        { id: "antiga", nome: "Antiga", tipo: "Servico", ordem: 1, duracao: 1, peso: 7, equipe: "Civil", createdAt: "2026-04-10T00:00:00.000Z" },
        { id: "outra_equipe", nome: "Outra equipe", tipo: "Servico", ordem: 1, duracao: 1, peso: 8, equipe: "Paisagismo", createdAt: "2026-04-11T00:00:00.000Z" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => [line.atividadeId, line.data_programada])).toEqual([
      ["antiga", "2026-05-04"],
      ["outra_equipe", "2026-05-04"],
      ["nova", "2026-05-05"]
    ]);
  });

  it("posiciona projeto antes de compra e ambos antes do servico ancora", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 10, duracao: 1 },
        { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "limite de compra" },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "serv_1" },
        { id: "solta_1", nome: "Compra solta", tipo: "Compra", ordem: 3 },
        { id: "compra_sem_ancora", nome: "Compra sem ancora existente", tipo: "Compra", ordem: 4, atividadeServicoAncoraId: "missing" },
        { id: "sem_ancora", nome: "Projeto sem ancora existente", tipo: "Projeto", ordem: 5, atividadeServicoAncoraId: "missing" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.tipo)).toEqual(["Projeto", "Compra", "Servi\u00e7o"]);
    expect(result.lines[1].subtipo_compra).toBe("LIMITE_COMPRA");
    expect(result.lines[2].data_programada).toBe("2026-05-04");
    expect(result.lines[0].data_programada < result.lines[1].data_programada).toBe(true);
    expect(result.lines[1].data_programada < result.lines[2].data_programada).toBe(true);
  });

  it("posiciona projeto com antecedencia relativa ao aviso de orcamento", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 6,
      obra_json: [{ id: "obra_1", dataInicio: "2026-05-01T03:00:00.000Z" }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
        {
          id: "compra_aviso",
          nome: "Aviso",
          tipo: "Compra",
          ordem: 1,
          atividadeServicoAncoraId: "serv_1",
          etapaCompra: "Aviso de orcamento",
          diasAntecedencia: 4
        },
        {
          id: "projeto_1",
          nome: "Projeto",
          tipo: "Projeto",
          ordem: 1,
          atividadeServicoAncoraId: "serv_1",
          diasAntecedencia: 4
        }
      ]
    }));

    const result = runScheduleEngine(payload);
    const project = result.lines.find((line) => line.atividadeId === "projeto_1");
    const purchase = result.lines.find((line) => line.atividadeId === "compra_aviso");
    const service = result.lines.find((line) => line.atividadeId === "serv_1");

    expect(project?.data_programada).toBe("2026-04-22");
    expect(purchase?.data_programada).toBe("2026-04-27");
    expect(service?.data_programada).toBe("2026-05-01");
  });

  it("formata codigo D-0 no dia anterior ao D+1", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 6,
      obra_json: [{ id: "obra_1", dataInicio: "2026-05-01T03:00:00.000Z" }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
        {
          id: "compra_1",
          nome: "Compra",
          tipo: "Compra",
          ordem: 1,
          atividadeServicoAncoraId: "serv_1",
          etapaCompra: "Recebimento",
          diasAntecedencia: 1
        }
      ]
    }));

    const result = runScheduleEngine(payload);
    const purchase = result.lines.find((line) => line.atividadeId === "compra_1");

    expect(purchase?.data_programada).toBe("2026-04-30");
    expect(purchase?.codigo_d).toBe("D-0");
  });

  it("posiciona projeto relativo ao servico quando nao ha compra ancora", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", ordem: 1, atividadeServicoAncoraId: "serv_1", diasAntecedencia: 2 },
        { id: "projeto_sem_ancora", nome: "Projeto solto", tipo: "Projeto", ordem: 2 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.atividadeId)).toEqual(["projeto_1", "serv_1"]);
    expect(result.lines[0].data_programada).toBe("2026-04-30");
    expect(result.lines[1].data_programada).toBe("2026-05-04");
  });

  it("usa duracao fixa quando quantidade variavel nao tem base ou quantidade", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 2, duracaoVariavel: true, quantidadeBase: null }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].produto).toBeNull();
    expect(result.lines[0].ambiente).toBeNull();
  });

  it("nao usa fallback quando atividade declara produto inexistente", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [{ id: "oap_1", produto: "produto_existente", quantidade: 10 }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, produto: "produto_inexistente" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines[0].obraAmbienteProdutoId).toBeNull();
    expect(result.lines[0].produtoId).toBeNull();
    expect(result.lines[0].produto).toBeNull();
  });

  it("cobre fallbacks de normalizacao e dias uteis", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "", name: "Nome fallback", tipo: "Projeto", etapaCompra: "etapa desconhecida", equipe: "" }
      ]
    }));

    expect(payload.atividades_json[0].id).toBe("atividade_1");
    expect(payload.atividades_json[0].nome).toBe("Nome fallback");
    expect(payload.atividades_json[0].etapaCompra).toBeNull();
    expect(payload.atividades_json[0].equipe).toBeNull();
    expect(formatDateOnly(addBusinessDays(parseDateOnly("2026-05-03"), 0, 5))).toBe("2026-05-04");
  });

  it("ignora dependencia inexistente e escolhe a dependencia mais recente", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico 1", tipo: "Servico", ordem: 1, duracao: 1 },
        { id: "serv_2", nome: "Servico 2", tipo: "Servico", ordem: 2, duracao: 1 },
        { id: "serv_3", nome: "Servico 3", tipo: "Servico", ordem: 3, duracao: 1, interdependenciasMasterIds: ["missing", "serv_1", "serv_2"] }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.data_programada)).toEqual(["2026-05-04", "2026-05-05", "2026-05-06"]);
  });

  it("usa fallbacks de ambiente por unique_id e produto por produtoId", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [{ unique_id: "amb_unique", name: "Ambiente unique" }],
      obra_ambiente_produto_json: [{ unique_id: "oap_unique", obraAmbienteId: "amb_unique", produtoId: "prod_fallback", quantidade: 1 }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines[0].obraAmbienteProdutoId).toBe("oap_unique");
    expect(result.lines[0].ambiente).toBe("Ambiente unique");
    expect(result.lines[0].produto).toBe("prod_fallback");
  });

  it("aceita aliases reais do Bubble com espacos e data ISO", () => {
    const payload = normalizePayload(basePayload({
      obra_json: [{ "unique id": "obra_bubble", dataInicio: "2026-05-01T03:00:00.000Z" }],
      obra_ambiente_json: [{ "unique id": "amb_obra_1", "nome ambiente": "Area Social" }],
      obra_ambiente_produto_json: [{
        "unique id": "oap_bubble_1",
        "ambiente x obra": "amb_obra_1",
        produto: "produto_1",
        "nome produto": "Piso",
        quantidade: 150
      }],
      atividades_json: [
        {
          "unique id": "serv_bubble_1",
          nome: "Servico Bubble",
          tipo: "Servico",
          ordem: 1,
          duracao: 1,
          "tipo equipe": "Equipe Bubble"
        },
        {
          "unique id": "compra_bubble_1",
          nome: "Compra Bubble",
          tipo: "Compra",
          ordem: 2,
          duracao: 1,
          atividadeServicoAncoraId: "serv_bubble_1",
          diasAntecedencia: 1,
          etapaCompra: "Recebimento"
        }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].atividadeId).toBe("compra_bubble_1");
    expect(result.lines[1].atividadeId).toBe("serv_bubble_1");
    expect(result.lines[1].data_programada).toBe("2026-05-01");
    expect(result.lines[1].obraAmbienteProdutoId).toBe("oap_bubble_1");
    expect(result.lines[1].ambiente).toBe("Area Social");
    expect(result.lines[1].produto).toBe("Piso");
    expect(result.lines[1].produtoId).toBe("produto_1");
    expect(result.lines[1].equipe).toBe("Equipe Bubble");
  });

  it("cobre fallbacks vazios de obra, tipo, ambiente, produto e ordenacao", () => {
    expect(() => runScheduleEngine(normalizePayload(basePayload({ obra_json: [] })))).toThrow("dataInicio");
    expect(() => normalizePayload(basePayload({ atividades_json: [{ id: "x", nome: "X", tipo: "" as never }] }))).toThrow("Tipo de atividade invalido");

    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [{ id: "amb_raw" }],
      obra_ambiente_produto_json: [{ ambienteId: "amb_raw", quantidade: 1 }],
      atividades_json: [
        { id: "serv_b", nome: "Servico B", tipo: "Servico", ordem: 1, duracao: 1, peso: 1 },
        { id: "serv_a", nome: "Servico A", tipo: "Servico", ordem: 1, duracao: 1, peso: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].obraAmbienteProdutoId).toBeNull();
    expect(result.lines[0].produtoId).toBeNull();
    expect(result.lines[0].ambiente).toBe("amb_raw");
    expect(result.lines[0].data_programada).toBe(result.lines[1].data_programada);
  });
  it("cobre ambiente sem id nem unique_id", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [{}],
      obra_ambiente_produto_json: [],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines).toHaveLength(1);
  });});
