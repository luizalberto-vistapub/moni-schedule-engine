import { describe, expect, it } from "vitest";
import type { ActivityPayload } from "../src/types/payload.types.js";
import { addBusinessDays, isBusinessDay, nextBusinessDay, previousBusinessDay } from "../src/services/business-days.service.js";
import { normalizePayload } from "../src/services/normalize-payload.service.js";
import { buildScheduleResponse } from "../src/services/response-builder.service.js";
import { compareAnchorPriority, runScheduleEngine } from "../src/services/schedule-engine.service.js";
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

  it("usa produto canonico quando o mesmo produto aparece em ordens diferentes", () => {
    const payloadBody = {
      obra_ambiente_json: [
        { id: "amb_a", nome: "Ambiente A" },
        { id: "amb_b", nome: "Ambiente B" }
      ],
      obra_ambiente_produto_json: [
        { id: "oap_b", ambienteId: "amb_b", produto: "prod_repetido", "id produto composto": "comp_b", quantidade: 30 },
        { id: "oap_a", ambienteId: "amb_a", produto: "prod_repetido", "id produto composto": "comp_a", quantidade: 10 }
      ],
      atividades_json: [
        {
          id: "serv_repetido",
          nome: "Servico com produto repetido",
          tipo: "Servico" as const,
          produto: "prod_repetido",
          ordem: 1,
          duracao: 1,
          duracaoVariavel: true,
          quantidadeBase: 10
        }
      ]
    };
    const forwardPayload = normalizePayload(basePayload(payloadBody));
    const reversedPayload = normalizePayload(basePayload({
      ...payloadBody,
      obra_ambiente_produto_json: [...payloadBody.obra_ambiente_produto_json].reverse()
    }));

    const forwardResult = runScheduleEngine(forwardPayload);
    const reversedResult = runScheduleEngine(reversedPayload);

    expect(forwardResult.lines.map((line) => line.atividade_obra_id_externo)).toEqual(
      reversedResult.lines.map((line) => line.atividade_obra_id_externo)
    );
    expect(forwardResult.lines).toHaveLength(1);
    expect(forwardResult.lines[0]).toMatchObject({
      obraAmbienteProdutoId: "oap_a",
      ambiente: "Ambiente A"
    });
  });

  it("ignora o produto composto informado quando outro contexto do produto tem servico de menor ordem", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [
        { id: "amb_parede", nome: "Parede" },
        { id: "amb_piso", nome: "Piso" },
        { id: "amb_outro", nome: "Outro ambiente" }
      ],
      obra_ambiente_produto_json: [
        { id: "oap_espacador_parede", ambienteId: "amb_parede", produto: "prod_espacador", "id produto composto": "comp_parede", quantidade: 30 },
        { id: "oap_serv_parede", ambienteId: "amb_parede", produto: "prod_serv_parede", "id produto composto": "comp_parede", quantidade: 1 },
        { id: "oap_espacador_outro", ambienteId: "amb_outro", produto: "prod_espacador", "id produto composto": "comp_piso", quantidade: 1 },
        { id: "oap_espacador_piso", ambienteId: "amb_piso", produto: "prod_espacador", "id produto composto": "comp_piso", quantidade: 10 },
        { id: "oap_serv_piso", ambienteId: "amb_piso", produto: "prod_serv_piso", "id produto composto": "comp_piso", quantidade: 1 }
      ],
      atividades_json: [
        {
          id: "serv_parede",
          nome: "Servico parede",
          tipo: "Servico",
          produto: "prod_serv_parede",
          ordem: 1
        },
        {
          id: "serv_piso",
          nome: "Servico piso",
          tipo: "Servico",
          produto: "prod_serv_piso",
          ordem: 2
        },
        {
          id: "compra_espacador_piso",
          nome: "Compra espacador piso",
          tipo: "Compra",
          produto: "prod_espacador",
          ordem: 1,
          atividadeServicoAncoraId: "comp_piso",
          etapaCompra: "Recebimento"
        }
      ]
    }));

    const result = runScheduleEngine(payload);
    const purchase = result.lines.find((line) => line.atividadeId === "compra_espacador_piso");

    expect(purchase).toMatchObject({
      obraAmbienteProdutoId: "oap_espacador_parede",
      ambiente: "Parede",
      atividadeServicoAncoraId: "serv_parede"
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

  it("resposta resumida contem metricas e nao contem listas de linhas", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico fixo", tipo: "Servico", ordem: 1, duracao: 2, duracaoVariavel: false }
      ]
    }));
    const result = runScheduleEngine(payload);
    const response = buildScheduleResponse(result, new Date(), "versao_anterior");

    expect(response.ok).toBe(true);
    expect(response.serverVersionId).toMatch(/^schedule_version_/);
    expect(response.previous_version_id).toBe("versao_anterior");
    expect(response.version.id).toBe(response.serverVersionId);
    expect(response.metrics.linesCount).toBe(result.lines.length);
    expect(response.metrics.servicesCount).toBe(result.lines.length);
    expect(response.metrics.purchasesCount).toBe(0);
    expect(response.metrics.projectsCount).toBe(0);
    expect(response.validations).toEqual({ warnings: [], errors: [] });
    expect("lines" in response).toBe(false);
    expect("cronograma" in response).toBe(false);
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

  it("reconhece as quatro etapas dentro do nome complementado e rejeita a compra mae", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "aviso", tipo: "Compra", etapaCompra: "Aviso de orçamento - TESTE VIVI PS1 - COMPRA" },
        { id: "aviso_sem_de", tipo: "Compra", etapaCompra: "PRODUTO - Aviso orçamento - COMPRA" },
        { id: "limite_orcamento", tipo: "Compra", etapaCompra: "TESTE - Limite de orçamento - PRODUTO" },
        { id: "limite_orcamento_sem_de", tipo: "Compra", etapaCompra: "PRODUTO - Limite orçamento - COMPRA" },
        { id: "limite_compra", tipo: "Compra", etapaCompra: "PRODUTO - Limite de compra" },
        { id: "limite_compra_sem_de", tipo: "Compra", etapaCompra: "PRODUTO - Limite compra - TESTE" },
        { id: "recebimento", tipo: "Compra", etapaCompra: "Recebimento - TESTE VIVI PS1 - COMPRA" },
        { id: "mae", tipo: "Compra", etapaCompra: "Atividade de compra 1 - TESTE VIVI PS1 - COMPRA" },
        { id: "palavra_parcial", tipo: "Compra", etapaCompra: "Pré-recebimentos - TESTE VIVI PS1 - COMPRA" }
      ]
    }));

    expect(payload.atividades_json.map((activity) => activity.etapaCompra)).toEqual([
      "AVISO_ORCAMENTO",
      "AVISO_ORCAMENTO",
      "LIMITE_ORCAMENTO",
      "LIMITE_ORCAMENTO",
      "LIMITE_COMPRA",
      "LIMITE_COMPRA",
      "RECEBIMENTO",
      null,
      null
    ]);
  });

  it("normaliza ancora somente para compras", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "servico", nome: "Servico", tipo: "Servico", atividadeServicoAncoraId: "não" },
        { id: "projeto", nome: "Projeto", tipo: "Projeto", atividadeServicoAncoraId: "não" },
        { id: "compra", nome: "Compra", tipo: "Compra", atividadeServicoAncoraId: "prod_compra", etapaCompra: "Recebimento" }
      ]
    }));

    expect(payload.atividades_json.map((activity) => activity.atividadeServicoAncoraId)).toEqual([
      null,
      null,
      "prod_compra"
    ]);
  });

  it("ancora compra pelo produto simples no primeiro servico do produto composto", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        { "unique id": "item_compra", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_compra", "nome produto simples": "Compra" },
        { "unique id": "item_servico_tarde", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_servico_tarde", "nome produto simples": "Servico tarde" },
        { "unique id": "item_servico_cedo", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_servico_cedo", "nome produto simples": "Servico cedo" }
      ],
      atividades_json: [
        { id: "servico_tarde", nome: "Servico tarde", tipo: "Servico", produto: "prod_servico_tarde", ordem: 2, duracao: 1 },
        { id: "servico_cedo", nome: "Servico cedo", tipo: "Servico", produto: "prod_servico_cedo", ordem: 1, duracao: 1 },
        { id: "compra", nome: "Recebimento", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "prod_compra" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const compra = result.lines.find((line) => line.atividadeId === "compra");

    expect(compra).toMatchObject({
      atividadeServicoAncoraId: "servico_cedo",
      data_programada: "2026-05-03"
    });
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
    expect(result.lines.find((line) => line.atividadeId === "dependente")?.interdependenciasMasterIds).toEqual(
      result.lines.filter((line) => line.atividadeId === "base").map((line) => line.atividade_obra_id_externo)
    );
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
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 10, duracao: 1, atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto" }] },
        { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "limite de compra" },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "" },
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

  it("ignora compra sem subtipo conhecido", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
        { id: "compra_generica", nome: "Compra generica", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "Atividade de compra - Produto Cap" },
        { id: "recebimento", nome: "Recebimento", tipo: "Compra", ordem: 2, atividadeServicoAncoraId: "serv_1", etapaCompra: "Recebimento" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.atividadeId)).toEqual(["recebimento", "serv_1"]);
    expect(result.lines[0].subtipo_compra).toBe("RECEBIMENTO");
  });

  it("posiciona projeto com antecedencia relativa ao aviso de orcamento", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 6,
      obra_json: [{ id: "obra_1", dataInicio: "2026-05-01T03:00:00.000Z" }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto", diasAntecedencia: 4 }] },
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

    expect(project?.data_programada).toBe("2026-04-23");
    expect(purchase?.data_programada).toBe("2026-04-27");
    expect(service?.data_programada).toBe("2026-05-01");
  });

  it("encadeia antecedentes das etapas de compra antes do servico", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 5,
      obra_json: [{ id: "obra_1", dataInicio: "2026-06-01" }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 10, duracao: 1, atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto", diasAntecedencia: 1 }] },
        {
          id: "aviso",
          nome: "Aviso de orçamento",
          tipo: "Compra",
          ordem: 1,
          atividadeServicoAncoraId: "serv_1",
          etapaCompra: "Aviso de orçamento",
          diasAntecedencia: 1
        },
        {
          id: "limite_orcamento",
          nome: "Limite de orçamento",
          tipo: "Compra",
          ordem: 2,
          atividadeServicoAncoraId: "serv_1",
          etapaCompra: "Limite de orçamento",
          diasAntecedencia: 1
        },
        {
          id: "limite_compra",
          nome: "Limite de compra",
          tipo: "Compra",
          ordem: 3,
          atividadeServicoAncoraId: "serv_1",
          etapaCompra: "Limite de compra",
          diasAntecedencia: 1
        },
        {
          id: "recebimento",
          nome: "Recebimento",
          tipo: "Compra",
          ordem: 4,
          atividadeServicoAncoraId: "serv_1",
          etapaCompra: "Recebimento",
          diasAntecedencia: 1
        },
        {
          id: "projeto_1",
          nome: "Projeto",
          tipo: "Projeto",
          ordem: 1,
          atividadeServicoAncoraId: "serv_1",
          diasAntecedencia: 1
        }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => [line.atividadeId, line.data_programada])).toEqual([
      ["projeto_1", "2026-05-30"],
      ["aviso", "2026-05-31"],
      ["limite_orcamento", "2026-05-31"],
      ["limite_compra", "2026-05-31"],
      ["recebimento", "2026-05-31"],
      ["serv_1", "2026-06-01"]
    ]);
  });

  it("encadeia compras por item de composicao sem misturar produtos do mesmo servico", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 6,
      obra_json: [{ id: "obra_1", dataInicio: "2026-07-01T03:00:00.000Z" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        { "unique id": "item_compra_1", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_1", "nome produto simples": "PS DNL 1" },
        { "unique id": "item_compra_3", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_3", "nome produto simples": "PS DNL 3" },
        { "unique id": "item_servico", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_mo", "nome produto simples": "PS DNL 4 (MO)" }
      ],
      atividades_json: [
        { id: "aviso_1", nome: "Aviso PS1", tipo: "Compra", produto: "prod_1", ordem: 1, atividadeServicoAncoraId: "item_compra_1", etapaCompra: "Aviso de orçamento", diasAntecedencia: 25 },
        { id: "limite_orcamento_1", nome: "Limite orcamento PS1", tipo: "Compra", produto: "prod_1", ordem: 1, atividadeServicoAncoraId: "item_compra_1", etapaCompra: "Limite de orçamento", diasAntecedencia: 25 },
        { id: "limite_compra_1", nome: "Limite compra PS1", tipo: "Compra", produto: "prod_1", ordem: 1, atividadeServicoAncoraId: "item_compra_1", etapaCompra: "Limite de compra", diasAntecedencia: 25 },
        { id: "recebimento_1", nome: "Recebimento PS1", tipo: "Compra", produto: "prod_1", ordem: 1, atividadeServicoAncoraId: "item_compra_1", etapaCompra: "Recebimento", diasAntecedencia: 25 },
        { id: "aviso_3", nome: "Aviso PS3", tipo: "Compra", produto: "prod_3", ordem: 1, atividadeServicoAncoraId: "item_compra_3", etapaCompra: "Aviso de orçamento", diasAntecedencia: 30 },
        { id: "limite_orcamento_3", nome: "Limite orcamento PS3", tipo: "Compra", produto: "prod_3", ordem: 1, atividadeServicoAncoraId: "item_compra_3", etapaCompra: "Limite de orçamento", diasAntecedencia: 30 },
        { id: "limite_compra_3", nome: "Limite compra PS3", tipo: "Compra", produto: "prod_3", ordem: 1, atividadeServicoAncoraId: "item_compra_3", etapaCompra: "Limite de compra", diasAntecedencia: 30 },
        { id: "recebimento_3", nome: "Recebimento PS3", tipo: "Compra", produto: "prod_3", ordem: 1, atividadeServicoAncoraId: "item_compra_3", etapaCompra: "Recebimento", diasAntecedencia: 30 },
        { id: "servico_1", nome: "ATV DNL MO 1", tipo: "Servico", produto: "prod_mo", ordem: 8, duracao: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);
    const datesByActivity = new Map(result.lines.map((line) => [line.atividadeId, line.data_programada]));

    expect(datesByActivity.get("recebimento_1")).toBe("2026-06-06");
    expect(datesByActivity.get("limite_compra_1")).toBe("2026-06-06");
    expect(datesByActivity.get("limite_orcamento_1")).toBe("2026-06-06");
    expect(datesByActivity.get("aviso_1")).toBe("2026-06-06");
    expect(datesByActivity.get("recebimento_3")).toBe("2026-06-01");
    expect(datesByActivity.get("limite_compra_3")).toBe("2026-06-01");
    expect(datesByActivity.get("limite_orcamento_3")).toBe("2026-06-01");
    expect(datesByActivity.get("aviso_3")).toBe("2026-06-01");
    expect(datesByActivity.get("servico_1")).toBe("2026-07-01");
  });

  it("gera compra ancorada em composto mesmo quando o produto de servico aparece em outro composto primeiro", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 6,
      obra_json: [{ id: "obra_1", dataInicio: "2026-07-01T03:00:00.000Z" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        { "unique id": "item_servico_composto_1", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_mo", "nome produto simples": "Servico repetido" },
        { "unique id": "item_compra_composto_2", "id ambiente item composicao": "amb_2", "id produto composto": "composto_2", "id produto simples": "prod_compra", "nome produto simples": "Compra contexto 2" },
        { "unique id": "item_servico_composto_2", "id ambiente item composicao": "amb_2", "id produto composto": "composto_2", "id produto simples": "prod_mo", "nome produto simples": "Servico repetido" }
      ],
      atividades_json: [
        { id: "servico_1", nome: "Servico", tipo: "Servico", produto: "prod_mo", ordem: 8, duracao: 1 },
        { id: "aviso", nome: "Aviso", tipo: "Compra", produto: "prod_compra", ordem: 1, atividadeServicoAncoraId: "composto_2", etapaCompra: "Aviso de orcamento", diasAntecedencia: 1 },
        { id: "limite", nome: "Limite", tipo: "Compra", produto: "prod_compra", ordem: 2, atividadeServicoAncoraId: "composto_2", etapaCompra: "Limite de compra", diasAntecedencia: 1 },
        { id: "recebimento", nome: "Recebimento", tipo: "Compra", produto: "prod_compra", ordem: 3, atividadeServicoAncoraId: "composto_2", etapaCompra: "Recebimento", diasAntecedencia: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.filter((line) => line.tipo === "Compra").map((line) => line.atividadeId).sort()).toEqual(["aviso", "limite", "recebimento"]);
    expect(result.validations.warnings).toEqual([]);
  });

  it("sinaliza compra com composto sem servico ancora gerado", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        { "unique id": "item_compra", "id ambiente item composicao": "amb_1", "id produto composto": "composto_sem_servico", "id produto simples": "prod_compra", "nome produto simples": "Compra sem servico" }
      ],
      atividades_json: [
        { id: "servico_1", nome: "Servico", tipo: "Servico", produto: "prod_outro", ordem: 1, duracao: 1 },
        { id: "aviso", nome: "Aviso", tipo: "Compra", produto: "prod_compra", ordem: 1, atividadeServicoAncoraId: "composto_sem_servico", etapaCompra: "Aviso de orcamento", diasAntecedencia: 1 },
        { id: "recebimento", nome: "Recebimento", tipo: "Compra", produto: "prod_compra", ordem: 2, atividadeServicoAncoraId: "composto_sem_servico", etapaCompra: "Recebimento", diasAntecedencia: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.filter((line) => line.tipo === "Compra")).toHaveLength(0);
    expect(result.validations.warnings).toEqual([
      "Atividades ancoradas nao geradas: tipo=Compra; quantidade=2; produto=prod_compra; atividadeServicoAncoraId=composto_sem_servico; motivo=sem servico ancora gerado."
    ]);
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
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto", diasAntecedencia: 2 }] },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", ordem: 1, atividadeServicoAncoraId: "", diasAntecedencia: 2 },
        { id: "projeto_sem_ancora", nome: "Projeto solto", tipo: "Projeto", ordem: 2 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.atividadeId)).toEqual(["projeto_1", "serv_1"]);
    expect(result.lines[0].data_programada).toBe("2026-05-02");
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

  it("aceita item composicao e ancora compras pelo produto composto", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [{ "unique id": "amb_item_1", "nome ambiente": "Ambiente Cap", "id ambiente x obra": "amb_obra_1" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        {
          "unique id": "item_compra_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "nome produto composto": "Produto Composto",
          "quantidade produto composto": 40,
          "id produto simples": "prod_compra",
          "nome produto simples": "Produto de compra"
        },
        {
          "unique id": "item_servico_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "nome produto composto": "Produto Composto",
          "quantidade produto composto": 20,
          "id produto simples": "prod_servico",
          "nome produto simples": "Mao de obra"
        }
      ],
      atividades_json: [
        { id: "compra_1", nome: "Recebimento", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "composto_1" },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", produto: "prod_compra", ordem: 1, atividadeServicoAncoraId: "composto_1" },
        { id: "servico_1", nome: "Instalacao", tipo: "Servico", produto: "prod_servico", ordem: 1, duracao: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.atividadeId)).toEqual(["projeto_1", "compra_1", "servico_1"]);
    expect(result.lines[0].atividadeServicoAncoraId).toBe("servico_1");
    expect(result.lines[1]).toMatchObject({
      atividadeServicoAncoraId: "servico_1",
      produtoId: "prod_compra",
      produto: "Produto de compra",
      ambienteId: "amb_obra_1",
      ambienteItemComposicaoId: "amb_item_1",
      ambiente: "Ambiente Cap"
    });
    expect(result.lines[2]).toMatchObject({
      obraAmbienteProdutoId: "item_servico_1",
      produtoId: "prod_servico",
      produto: "Mao de obra"
    });
    expect(result.lines[0].data_programada < result.lines[1].data_programada).toBe(true);
    expect(result.lines[1].data_programada < result.lines[2].data_programada).toBe(true);
  });

  it("ancora item de composicao no servico mais cedo do produto composto", () => {
    const payload = normalizePayload(basePayload({
      dias_trabalho_semana: 5,
      obra_json: [{ id: "obra_1", dataInicio: "2026-06-01" }],
      obra_ambiente_json: [{ "unique id": "amb_item_1", "nome ambiente": "Ambiente Cap" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        {
          "unique id": "item_compra_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "nome produto composto": "Produto Composto",
          "id produto simples": "prod_compra",
          "nome produto simples": "Produto de compra"
        },
        {
          "unique id": "item_servico_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "nome produto composto": "Produto Composto",
          "id produto simples": "prod_servico",
          "nome produto simples": "Mao de obra"
        }
      ],
      atividades_json: [
        {
          id: "aaa_servico_dependente",
          nome: "Assentar",
          tipo: "Servico",
          produto: "prod_servico",
          ordem: 1,
          duracao: 1,
          interdependenciasMasterIds: ["zzz_servico_base"]
        },
        {
          id: "zzz_servico_base",
          nome: "Preparar base",
          tipo: "Servico",
          produto: "prod_servico",
          ordem: 1,
          duracao: 1
        },
        {
          id: "recebimento",
          nome: "Recebimento",
          tipo: "Compra",
          produto: "prod_compra",
          ordem: 1,
          etapaCompra: "Recebimento",
          diasAntecedencia: 1,
          atividadeServicoAncoraId: "item_compra_1"
        }
      ]
    }));

    const result = runScheduleEngine(payload);
    const purchase = result.lines.find((line) => line.atividadeId === "recebimento");

    expect(result.lines.map((line) => [line.atividadeId, line.data_programada])).toEqual([
      ["recebimento", "2026-05-31"],
      ["zzz_servico_base", "2026-06-01"],
      ["aaa_servico_dependente", "2026-06-02"]
    ]);
    expect(purchase).toMatchObject({
      atividadeServicoAncoraId: "zzz_servico_base",
      anchor_service_name: "Preparar base"
    });
  });

  it("gera projeto a partir de atividadeProjeto da mao de obra", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [{ "unique id": "amb_item_1", "nome ambiente": "Ambiente Cap" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        {
          "unique id": "item_servico_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "id produto simples": "prod_servico",
          "nome produto simples": "Mao de obra"
        },
        {
          "unique id": "item_compra_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_1",
          "id produto simples": "prod_compra",
          "nome produto simples": "Produto"
        }
      ],
      atividades_json: [
        { id: "aviso", nome: "Aviso", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Aviso de orçamento", atividadeServicoAncoraId: "composto_1", diasAntecedencia: 2 },
        {
          id: "servico_1",
          nome: "Instalacao",
          tipo: "Servico",
          produto: "prod_servico",
          ordem: 1,
          duracao: 1,
          atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto Cap", diasAntecedencia: 5 }]
        }
      ]
    }));

    expect(payload.atividades_json.map((activity) => activity.id)).toContain("projeto_1");

    const result = runScheduleEngine(payload);
    const project = result.lines.find((line) => line.atividadeId === "projeto_1");
    const purchase = result.lines.find((line) => line.atividadeId === "aviso");
    const service = result.lines.find((line) => line.atividadeId === "servico_1");

    expect(project).toMatchObject({
      tipo: "Projeto",
      nome_atividade: "Projeto Cap",
      atividadeServicoAncoraId: "servico_1",
      produtoId: "prod_servico"
    });
    expect(project!.data_programada).toBe("2026-04-27");
    expect(purchase!.data_programada).toBe("2026-05-02");
    expect(service!.data_programada).toBe("2026-05-04");
    expect(project!.data_programada < purchase!.data_programada).toBe(true);
    expect(purchase!.data_programada < service!.data_programada).toBe(true);
  });

  it("normaliza atividadeProjeto sem antecedencia e ignora id duplicado", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        {
          id: "servico_1",
          nome: "Instalacao",
          tipo: "Servico",
          ordem: 1,
          duracao: 1,
          atividadeProjeto: [
            { idAtividadeProjeto: "servico_1", nomeAtividadeProjeto: "Duplicado", diasAntecedencia: null },
            { idAtividadeProjeto: "projeto_sem_antecedencia", nomeAtividadeProjeto: "Projeto sem antecedencia" },
            { idAtividadeProjeto: "projeto_em_branco", nomeAtividadeProjeto: "Projeto em branco", diasAntecedencia: "" }
          ]
        }
      ]
    }));

    const generatedProjects = payload.atividades_json.filter((activity) => activity.tipo === "Projeto");

    expect(generatedProjects.map((activity) => activity.id)).toEqual(["projeto_sem_antecedencia", "projeto_em_branco"]);
    expect(generatedProjects.map((activity) => activity.offsetDias)).toEqual([undefined, undefined]);
  });

  it("gera uma unica atividade de projeto quando o mesmo projeto aparece em varios servicos", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        {
          id: "servico_1",
          nome: "Instalacao 1",
          tipo: "Servico",
          ordem: 2,
          duracao: 1,
          atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto unico", diasAntecedencia: 2 }]
        },
        {
          id: "servico_2",
          nome: "Instalacao 2",
          tipo: "Servico",
          ordem: 1,
          duracao: 1,
          atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto unico", diasAntecedencia: 2 }]
        }
      ]
    }));

    const generatedProjects = payload.atividades_json.filter((activity) => activity.tipo === "Projeto");
    const result = runScheduleEngine(payload);
    const projectLines = result.lines.filter((line) => line.atividadeId === "projeto_1");

    expect(generatedProjects).toHaveLength(2);
    expect(projectLines).toHaveLength(1);
    expect(projectLines[0]).toMatchObject({
      atividadeId: "projeto_1",
      atividadeServicoAncoraId: "servico_2",
      anchor_service_name: "Instalacao 2"
    });
  });

  it("consolida compras repetidas no servico de menor ordem independentemente da ancora e da ordem do payload", () => {
    const purchaseStages = [
      { suffix: "aviso", nome: "Aviso", etapaCompra: "Aviso de orçamento", diasAntecedencia: 30 },
      { suffix: "limite_orcamento", nome: "Limite orçamento", etapaCompra: "Limite de orçamento", diasAntecedencia: 28 },
      { suffix: "limite_compra", nome: "Limite compra", etapaCompra: "Limite de compra", diasAntecedencia: 14 },
      { suffix: "recebimento", nome: "Recebimento", etapaCompra: "Recebimento", diasAntecedencia: 2 }
    ];
    const purchases: ActivityPayload[] = purchaseStages.flatMap((stage, stageIndex) => [
      {
        id: `${stage.suffix}_primeira`,
        nome: stage.nome,
        tipo: "Compra",
        produto: "prod_compra",
        ordem: 1,
        etapaCompra: stage.etapaCompra,
        diasAntecedencia: stage.diasAntecedencia,
        createdAt: `2026-01-01T00:00:0${stageIndex}.000Z`
      },
      {
        id: `${stage.suffix}_duplicada`,
        nome: `${stage.nome} duplicada`,
        tipo: "Compra",
        produto: "prod_compra",
        ordem: 1,
        etapaCompra: stage.etapaCompra,
        diasAntecedencia: stage.diasAntecedencia,
        createdAt: `2026-01-02T00:00:0${stageIndex}.000Z`
      }
    ]);
    const compositionProducts = [
      {
        "unique id": "compra_ordem_1",
        "id ambiente item composicao": "amb_ordem_1",
        "id produto composto": "composto_ordem_1",
        "id produto simples": "prod_compra",
        "nome produto simples": "Porcelanato"
      },
      {
        "unique id": "servico_ordem_1_produto",
        "id ambiente item composicao": "amb_ordem_1",
        "id produto composto": "composto_ordem_1",
        "id produto simples": "prod_servico_ordem_1",
        "nome produto simples": "Mão de obra ordem 1"
      },
      {
        "unique id": "compra_ordem_5",
        "id ambiente item composicao": "amb_ordem_5",
        "id produto composto": "composto_ordem_5",
        "id produto simples": "prod_compra",
        "nome produto simples": "Porcelanato"
      },
      {
        "unique id": "servico_ordem_5_produto",
        "id ambiente item composicao": "amb_ordem_5",
        "id produto composto": "composto_ordem_5",
        "id produto simples": "prod_servico_ordem_5",
        "nome produto simples": "Mão de obra ordem 5"
      }
    ];
    const services: ActivityPayload[] = [
      { id: "servico_ordem_1", nome: "Assentar primeiro ambiente", tipo: "Servico", produto: "prod_servico_ordem_1", ordem: 1, duracao: 1 },
      { id: "servico_ordem_5", nome: "Assentar segundo ambiente", tipo: "Servico", produto: "prod_servico_ordem_5", ordem: 5, duracao: 1 }
    ];
    const generate = (anchorId: string, reverse: boolean) => {
      const anchoredPurchases = purchases.map((purchase) => ({ ...purchase, atividadeServicoAncoraId: anchorId }));
      const atividades_json = [...services, ...(reverse ? anchoredPurchases.reverse() : anchoredPurchases)];
      const payload = normalizePayload(basePayload({
        obra_ambiente_json: [
          { "unique id": "amb_ordem_1", "nome ambiente": "Sala" },
          { "unique id": "amb_ordem_5", "nome ambiente": "Varanda" }
        ],
        obra_ambiente_produto_json: [],
        obra_ambiente_item_composicao_json: compositionProducts,
        atividades_json: reverse ? atividades_json.reverse() : atividades_json
      }));

      return runScheduleEngine(payload).lines
        .filter((line) => line.tipo === "Compra")
        .map((line) => ({
          atividadeId: line.atividadeId,
          etapa: line.subtipo_compra,
          ancora: line.atividadeServicoAncoraId,
          data: line.data_programada,
          produtoContextual: line.obraAmbienteProdutoId
        }));
    };

    const anchoredInLateComposite = generate("composto_ordem_5", false);
    const anchoredInEarlyCompositeAndReversed = generate("composto_ordem_1", true);

    expect(anchoredInLateComposite).toEqual([
      { atividadeId: "aviso_primeira", etapa: "AVISO_ORCAMENTO", ancora: "servico_ordem_1", data: "2026-04-04", produtoContextual: "compra_ordem_1" },
      { atividadeId: "limite_orcamento_primeira", etapa: "LIMITE_ORCAMENTO", ancora: "servico_ordem_1", data: "2026-04-06", produtoContextual: "compra_ordem_1" },
      { atividadeId: "limite_compra_primeira", etapa: "LIMITE_COMPRA", ancora: "servico_ordem_1", data: "2026-04-20", produtoContextual: "compra_ordem_1" },
      { atividadeId: "recebimento_primeira", etapa: "RECEBIMENTO", ancora: "servico_ordem_1", data: "2026-05-02", produtoContextual: "compra_ordem_1" }
    ]);
    expect(anchoredInEarlyCompositeAndReversed).toEqual(anchoredInLateComposite);
  });

  it("desempata a ancora pela menor data programada quando os servicos tem a mesma ordem", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        { "unique id": "compra_cedo", "id ambiente item composicao": "amb_1", "id produto composto": "composto_cedo", "id produto simples": "prod_compra" },
        { "unique id": "produto_servico_cedo", "id ambiente item composicao": "amb_1", "id produto composto": "composto_cedo", "id produto simples": "prod_servico_cedo" },
        { "unique id": "compra_tarde", "id ambiente item composicao": "amb_1", "id produto composto": "composto_tarde", "id produto simples": "prod_compra" },
        { "unique id": "produto_servico_tarde", "id ambiente item composicao": "amb_1", "id produto composto": "composto_tarde", "id produto simples": "prod_servico_tarde" }
      ],
      atividades_json: [
        { id: "z_servico_cedo", nome: "Serviço cedo", tipo: "Servico", produto: "prod_servico_cedo", ordem: 1, duracao: 1 },
        { id: "a_servico_tarde", nome: "Serviço tarde", tipo: "Servico", produto: "prod_servico_tarde", ordem: 1, duracao: 1, interdependenciasMasterIds: ["z_servico_cedo"] },
        { id: "recebimento", nome: "Recebimento", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "composto_tarde" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const purchase = result.lines.find((line) => line.atividadeId === "recebimento");

    expect(result.lines.find((line) => line.atividadeId === "z_servico_cedo")!.data_programada).toBe("2026-05-04");
    expect(result.lines.find((line) => line.atividadeId === "a_servico_tarde")!.data_programada).toBe("2026-05-05");
    expect(purchase).toMatchObject({
      atividadeServicoAncoraId: "z_servico_cedo",
      obraAmbienteProdutoId: "compra_cedo"
    });
  });

  it("desempata a ancora pelo id quando ordem e data programada sao iguais", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        { "unique id": "compra_a", "id ambiente item composicao": "amb_1", "id produto composto": "composto_a", "id produto simples": "prod_compra" },
        { "unique id": "produto_servico_a", "id ambiente item composicao": "amb_1", "id produto composto": "composto_a", "id produto simples": "prod_servico_a" },
        { "unique id": "compra_z", "id ambiente item composicao": "amb_1", "id produto composto": "composto_z", "id produto simples": "prod_compra" },
        { "unique id": "produto_servico_z", "id ambiente item composicao": "amb_1", "id produto composto": "composto_z", "id produto simples": "prod_servico_z" }
      ],
      atividades_json: [
        { id: "z_servico", nome: "Serviço Z", tipo: "Servico", produto: "prod_servico_z", ordem: 1, duracao: 1 },
        { id: "a_servico", nome: "Serviço A", tipo: "Servico", produto: "prod_servico_a", ordem: 1, duracao: 1 },
        { id: "recebimento", nome: "Recebimento", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "composto_z" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const purchase = result.lines.find((line) => line.atividadeId === "recebimento");

    expect(result.lines.find((line) => line.atividadeId === "a_servico")!.data_programada).toBe("2026-05-04");
    expect(result.lines.find((line) => line.atividadeId === "z_servico")!.data_programada).toBe("2026-05-04");
    expect(purchase).toMatchObject({
      atividadeServicoAncoraId: "a_servico",
      obraAmbienteProdutoId: "compra_a"
    });
  });

  it("prioriza a menor ordem da ancora mesmo quando sua data informada e posterior", () => {
    const lowerOrder = { id: "servico_ordem_1", ordem: 1 };
    const higherOrder = { id: "servico_ordem_5", ordem: 5 };

    expect(compareAnchorPriority(
      lowerOrder,
      new Date("2026-06-01T00:00:00.000Z"),
      higherOrder,
      new Date("2026-05-01T00:00:00.000Z")
    )).toBeLessThan(0);
  });

  it("escolhe a compra mais antiga por timestamp e desempata pelo id sem gerar warning", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        { "unique id": "compra_contextual", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_compra" },
        { "unique id": "servico_contextual", "id ambiente item composicao": "amb_1", "id produto composto": "composto_1", "id produto simples": "prod_servico" }
      ],
      atividades_json: [
        { id: "servico", nome: "Serviço", tipo: "Servico", produto: "prod_servico", ordem: 1, duracao: 1 },
        { id: "z_compra_antiga", nome: "Recebimento Z", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Recebimento", atividadeServicoAncoraId: "composto_1", createdAt: "2026-01-01T04:00:00+02:00" },
        { id: "m_compra_recente", nome: "Recebimento M", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Recebimento", atividadeServicoAncoraId: "composto_1", createdAt: "2026-01-01T03:00:00Z" },
        { id: "a_compra_antiga", nome: "Recebimento A", tipo: "Compra", produto: "prod_compra", ordem: 1, etapaCompra: "Recebimento", atividadeServicoAncoraId: "composto_1", createdAt: "2026-01-01T04:00:00+02:00" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const purchases = result.lines.filter((line) => line.tipo === "Compra");

    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      atividadeId: "a_compra_antiga",
      subtipo_compra: "RECEBIMENTO",
      atividadeServicoAncoraId: "servico",
      obraAmbienteProdutoId: "compra_contextual"
    });
    expect(result.validations.warnings).toEqual([]);
  });

  it("ignora compras e projetos sem ancora resolvida", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
        { id: "compra_orfa", nome: "Compra orfa", tipo: "Compra", ordem: 1, etapaCompra: "Recebimento", atividadeServicoAncoraId: "ancora_inexistente" },
        { id: "projeto_orfao", nome: "Projeto orfao", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "ancora_inexistente" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.atividadeId)).toEqual(["serv_1"]);
  });

  it("usa produto do servico ancora quando compra ou projeto nao informam produto", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, produto: "prod_1", atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto" }] },
        { id: "compra_1", nome: "Recebimento", tipo: "Compra", ordem: 1, etapaCompra: "Recebimento", atividadeServicoAncoraId: "serv_1" },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const purchase = result.lines.find((line) => line.atividadeId === "compra_1");
    const project = result.lines.find((line) => line.atividadeId === "projeto_1");

    expect(purchase).toMatchObject({ produtoId: "prod_1", produto: "Piso" });
    expect(project).toMatchObject({ produtoId: "prod_1", produto: "Piso" });
  });

  it("mantem atividades ancoradas sem produto quando nao ha produto fallback", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, atividadeProjeto: [{ idAtividadeProjeto: "projeto_1", nomeAtividadeProjeto: "Projeto" }] },
        { id: "compra_1", nome: "Recebimento", tipo: "Compra", ordem: 1, etapaCompra: "Recebimento", atividadeServicoAncoraId: "serv_1" },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", ordem: 2, atividadeServicoAncoraId: "" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.find((line) => line.atividadeId === "compra_1")).toMatchObject({ produtoId: null, produto: null });
    expect(result.lines.find((line) => line.atividadeId === "projeto_1")).toMatchObject({ produtoId: null, produto: null });
  });

  it("mantem produto proprio em atividades ancoradas e ignora composto sem servico", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [{ "unique id": "amb_item_1", "nome ambiente": "Ambiente Cap" }],
      obra_ambiente_produto_json: [],
      obra_ambiente_item_composicao_json: [
        {
          "unique id": "item_servico_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_servico",
          "id produto simples": "prod_servico",
          "nome produto simples": "Mao de obra"
        },
        {
          "unique id": "item_compra_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_servico",
          "id produto simples": "prod_compra",
          "nome produto simples": "Produto proprio"
        },
        {
          "unique id": "item_orfao_1",
          "id ambiente item composicao": "amb_item_1",
          "id produto composto": "composto_sem_servico",
          "id produto simples": "prod_orfao",
          "nome produto simples": "Produto orfao"
        }
      ],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1, produto: "prod_servico" },
        { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 1, etapaCompra: "Recebimento", produto: "prod_compra", atividadeServicoAncoraId: "serv_1" },
        { id: "projeto_1", nome: "Projeto", tipo: "Projeto", ordem: 2, produto: "prod_compra", atividadeServicoAncoraId: "serv_1" },
        { id: "compra_orfa", nome: "Compra orfa", tipo: "Compra", ordem: 3, etapaCompra: "Recebimento", produto: "prod_orfao" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.map((line) => line.atividadeId)).toEqual(["projeto_1", "compra_1", "serv_1"]);
    expect(result.lines.find((line) => line.atividadeId === "compra_1")).toMatchObject({ produtoId: "prod_compra", produto: "Produto proprio" });
    expect(result.lines.find((line) => line.atividadeId === "projeto_1")).toMatchObject({ produtoId: "prod_compra", produto: "Produto proprio" });
    expect(result.lines.find((line) => line.atividadeId === "compra_orfa")).toBeUndefined();
  });

  it("resolve ambiente pelo unique id e usa somente id ambiente x obra como referencia Bubble", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_json: [{
        "unique id": "1778509663183x408131843469357700",
        "id ambiente x obra": "1778509663183xambienteobra",
        obra: "1778509641991x511373404079390700",
        ambiente: "1778260028546x369044729899253800",
        "nome ambiente": "garagem de teste"
      }],
      obra_ambiente_produto_json: [{
        "unique id": "oap_1",
        ambiente: "1778260028546x369044729899253800",
        produto: "prod_1",
        "nome produto": "Piso",
        quantidade: 1
      }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines[0].ambienteId).toBe("1778509663183xambienteobra");
    expect(result.lines[0].ambiente).toBe("garagem de teste");

    const payloadWithoutObraAmbienteUniqueId = normalizePayload(basePayload({
      obra_ambiente_json: [{
        ambiente: "1778260028546x369044729899253800",
        "nome ambiente": "garagem sem unique id"
      }],
      obra_ambiente_produto_json: [{
        ambiente: "1778260028546x369044729899253800",
        quantidade: 1
      }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 }
      ]
    }));
    const fallbackResult = runScheduleEngine(payloadWithoutObraAmbienteUniqueId);

    expect(fallbackResult.lines[0].ambienteId).toBeNull();
    expect(fallbackResult.lines[0].ambiente).toBe("garagem sem unique id");
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
  });

  it("cobre ramos de etapa desconhecida, ancora composta e inicio forcado", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [{
        id: "oap_1",
        produtoId: "prod_1",
        produtoNome: "Piso",
        "id produto composto": "composto_1",
        quantidade: 1
      }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", produto: "prod_1", ordem: 1, duracao: 1 },
        { id: "compra_1", nome: "Compra", tipo: "Compra", produto: "prod_1", ordem: 1, atividadeServicoAncoraId: "composto_1", etapaCompra: "Limite de compra" }
      ]
    }));
    payload.atividades_json[0]!.__recalculateStartDate = "2026-05-06";
    payload.atividades_json[1]!.etapaCompra = "ETAPA_DESCONHECIDA" as never;
    payload.atividades_json[1]!.interdependenciasMasterIds = undefined as never;

    const result = runScheduleEngine(payload);

    expect(result.lines.find((line) => line.tipo === "Serviço")).toMatchObject({
      data_programada: "2026-05-06"
    });
    expect(result.lines.find((line) => line.tipo === "Compra")).toMatchObject({
      atividadeServicoAncoraId: "serv_1",
      subtipo_compra: "ETAPA_DESCONHECIDA"
    });
  });

  it("gera cadeia de compra default sem produto especifico", () => {
    const payload = normalizePayload(basePayload({
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", ordem: 1, duracao: 1 },
        { id: "compra_1", nome: "Compra", tipo: "Compra", ordem: 1, atividadeServicoAncoraId: "serv_1", etapaCompra: "Limite de compra" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.find((line) => line.tipo === "Compra")).toMatchObject({
      atividadeServicoAncoraId: "serv_1"
    });
  });

  it("resolve compra sem ancora explicita pelo produto composto", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [{
        id: "oap_1",
        produtoId: "prod_1",
        produtoNome: "Piso",
        "id produto composto": "composto_1",
        quantidade: 1
      }],
      atividades_json: [
        { id: "serv_1", nome: "Servico", tipo: "Servico", produto: "prod_1", ordem: 1, duracao: 1 },
        { id: "compra_1", nome: "Compra", tipo: "Compra", produto: "prod_1", ordem: 1, etapaCompra: "Limite de compra" }
      ]
    }));

    const result = runScheduleEngine(payload);

    expect(result.lines.find((line) => line.tipo === "Compra")).toMatchObject({
      atividadeServicoAncoraId: "serv_1"
    });
  });

  it("links direct project activities through atividadeProjeto references", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [
        { id: "oap_1", ambienteId: "amb_1", produtoId: "prod_1", produtoNome: "Produto 1", quantidade: 1 },
        { id: "oap_2", ambienteId: "amb_1", produtoId: "prod_2", produtoNome: "Produto 2", quantidade: 1 }
      ],
      atividades_json: [
        { id: "serv_1", nome: "Servico 1", tipo: "Servico", produto: "prod_1", ordem: 1, duracao: 1 },
        {
          id: "serv_2",
          nome: "Servico 2",
          tipo: "Servico",
          produto: "prod_2",
          ordem: 2,
          duracao: 1,
          atividadeProjeto: [{ idAtividadeProjeto: "proj_1", nomeAtividadeProjeto: "Projeto" }]
        },
        { id: "compra_2", nome: "Compra 2", tipo: "Compra", produto: "prod_2", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "serv_2" },
        { id: "proj_1", nome: "Projeto direto", tipo: "Projeto", ordem: 1, duracao: 1, diasAntecedencia: 2, produto: "", atividadeServicoAncoraId: "" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const projectLine = result.lines.find((line) => line.tipo === "Projeto");

    expect(projectLine).toMatchObject({
      atividadeId: "proj_1",
      nome_atividade: "Projeto direto",
      atividadeServicoAncoraId: "serv_2",
      produtoId: "prod_2",
      produto: "Produto 2",
      anchor_service_name: "Servico 2"
    });
  });

  it("creates one project line on the earliest planned service when one project is referenced by multiple services", () => {
    const payload = normalizePayload(basePayload({
      obra_ambiente_produto_json: [
        { id: "oap_1", ambienteId: "amb_1", produtoId: "prod_1", produtoNome: "Produto 1", quantidade: 1 },
        { id: "oap_2", ambienteId: "amb_1", produtoId: "prod_2", produtoNome: "Produto 2", quantidade: 1 }
      ],
      atividades_json: [
        {
          id: "serv_1",
          nome: "Servico 1",
          tipo: "Servico",
          produto: "prod_1",
          ordem: 1,
          duracao: 1,
          atividadeProjeto: [
            { idAtividadeProjeto: "proj_shared", nomeAtividadeProjeto: "Projeto compartilhado", diasAntecedencia: 1 },
            { idAtividadeProjeto: "proj_shared", nomeAtividadeProjeto: "Projeto compartilhado duplicado", diasAntecedencia: 1 }
          ]
        },
        {
          id: "serv_2",
          nome: "Servico 2",
          tipo: "Servico",
          produto: "prod_2",
          ordem: 2,
          duracao: 1,
          atividadeProjeto: [{ idAtividadeProjeto: "proj_shared", nomeAtividadeProjeto: "Projeto compartilhado", diasAntecedencia: 2 }]
        },
        { id: "compra_1", nome: "Compra 1", tipo: "Compra", produto: "prod_1", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "serv_1" },
        { id: "compra_2", nome: "Compra 2", tipo: "Compra", produto: "prod_2", ordem: 1, etapaCompra: "Recebimento", diasAntecedencia: 1, atividadeServicoAncoraId: "serv_2" },
        { id: "proj_shared", nome: "Projeto direto compartilhado", tipo: "Projeto", ordem: 1, duracao: 1, produto: "", atividadeServicoAncoraId: "" }
      ]
    }));

    const result = runScheduleEngine(payload);
    const projectLines = result.lines.filter((line) => line.tipo === "Projeto");

    expect(projectLines).toHaveLength(1);
    expect(projectLines.map((line) => ({
      atividadeId: line.atividadeId,
      anchor: line.atividadeServicoAncoraId,
      product: line.produtoId
    }))).toEqual([
      { atividadeId: "proj_shared", anchor: "serv_1", product: "prod_1" }
    ]);
  });

  it("keeps atividade obra external ids stable when planned dates change", () => {
    const payloadA = normalizePayload(basePayload({
      obra_json: [{ id: "obra_1", dataInicio: "2026-05-04" }],
      obra_ambiente_produto_json: [
        { id: "oap_1", ambienteId: "amb_1", produtoId: "prod_1", produtoNome: "Produto 1", quantidade: 1 }
      ],
      atividades_json: [{ id: "serv_1", nome: "Servico 1", tipo: "Servico", produto: "prod_1", ordem: 1, duracao: 1 }]
    }));
    const payloadB = normalizePayload(basePayload({
      obra_json: [{ id: "obra_1", dataInicio: "2026-05-11" }],
      obra_ambiente_produto_json: [
        { id: "oap_1", ambienteId: "amb_1", produtoId: "prod_1", produtoNome: "Produto 1", quantidade: 1 }
      ],
      atividades_json: [{ id: "serv_1", nome: "Servico 1", tipo: "Servico", produto: "prod_1", ordem: 1, duracao: 1 }]
    }));

    const [lineA] = runScheduleEngine(payloadA).lines;
    const [lineB] = runScheduleEngine(payloadB).lines;

    expect(lineA!.atividade_obra_id_externo).toBe("serv_1|amb_1|1");
    expect(lineB!.atividade_obra_id_externo).toBe("serv_1|amb_1|1");
    expect(lineA!.data_programada).toBe("2026-05-04");
    expect(lineB!.data_programada).toBe("2026-05-11");
  });
});
