import { Router } from "express";
import packageJson from "../../package.json" with { type: "json" };

export const docsRoutes = Router();

type OpenApiSchema = Record<string, unknown>;

const branchEnvironmentMap: Record<string, { name: string; description: string }> = {
  main: {
    name: "Live",
    description: "Documentacao do ambiente Live, publicado pela branch main."
  },
  "codex/bubble-bulk-persistence": {
    name: "Development",
    description: "Documentacao do ambiente Development, publicado pela branch codex/bubble-bulk-persistence."
  }
};

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim())?.trim() || "";
}

function currentBranch(): string {
  return firstNonEmpty(
    process.env.SWAGGER_BRANCH,
    process.env.APP_BRANCH,
    process.env.RENDER_GIT_BRANCH,
    process.env.GIT_BRANCH,
    process.env.BRANCH
  );
}

function currentEnvironment(branch: string): { name: string; description: string } {
  const explicitEnvironment = firstNonEmpty(process.env.SWAGGER_ENVIRONMENT, process.env.APP_ENVIRONMENT);
  if (explicitEnvironment) {
    return {
      name: explicitEnvironment,
      description: `Documentacao do ambiente ${explicitEnvironment}${branch ? `, publicado pela branch ${branch}` : ""}.`
    };
  }

  return branchEnvironmentMap[branch] || {
    name: branch ? `Branch ${branch}` : "Local",
    description: branch
      ? `Documentacao publicada pela branch ${branch}.`
      : "Documentacao do ambiente local."
  };
}

function schema(ref: string): OpenApiSchema {
  return { $ref: `#/components/schemas/${ref}` };
}

function jsonObject(description: string): OpenApiSchema {
  return {
    type: "object",
    description,
    additionalProperties: true
  };
}

export function buildOpenApiDocument() {
  const branch = currentBranch();
  const environment = currentEnvironment(branch);
  const versionSuffix = branch ? ` (${environment.name} - ${branch})` : ` (${environment.name})`;

  return {
    openapi: "3.0.3",
    info: {
      title: `Moni Schedule Engine API - ${environment.name}`,
      version: `${packageJson.version}${versionSuffix}`,
      description: [
        environment.description,
        "Motor de cronograma de obra do sistema Moni.",
        "Cada servico Render deve informar SWAGGER_BRANCH ou APP_BRANCH para diferenciar a documentacao por branch."
      ].join("\n\n")
    },
    tags: [
      { name: "Health", description: "Status operacional do servidor." },
      { name: "Schedules", description: "Geracao e recalculo de cronogramas." }
    ],
    paths: {
      "/health": {
        get: {
          tags: ["Health"],
          summary: "Health check",
          responses: {
            200: {
              description: "Servidor ativo.",
              content: {
                "application/json": {
                  schema: schema("HealthResponse")
                }
              }
            }
          }
        }
      },
      "/ready": {
        get: {
          tags: ["Health"],
          summary: "Readiness check",
          responses: {
            200: {
              description: "Servidor pronto para receber requisicoes.",
              content: {
                "application/json": {
                  schema: schema("ReadyResponse")
                }
              }
            }
          }
        }
      },
      "/api/v1/schedules/generate": {
        post: {
          tags: ["Schedules"],
          summary: "Gera um cronograma",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schema("SchedulePayload")
              }
            }
          },
          responses: {
            201: {
              description: "Cronograma gerado e persistido.",
              content: {
                "application/json": {
                  schema: schema("ScheduleSuccessResponse")
                }
              }
            },
            400: {
              description: "Payload invalido.",
              content: {
                "application/json": {
                  schema: schema("ScheduleErrorResponse")
                }
              }
            },
            500: {
              description: "Erro interno ou configuracao invalida de persistencia.",
              content: {
                "application/json": {
                  schema: schema("ScheduleErrorResponse")
                }
              }
            },
            502: {
              description: "Falha ao persistir no Bubble.",
              content: {
                "application/json": {
                  schema: schema("ScheduleErrorResponse")
                }
              }
            }
          }
        }
      },
      "/api/v1/schedules/recalculate": {
        post: {
          tags: ["Schedules"],
          summary: "Recalcula um cronograma",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schema("SchedulePayload")
              }
            }
          },
          responses: {
            201: {
              description: "Cronograma recalculado e persistido.",
              content: {
                "application/json": {
                  schema: schema("ScheduleSuccessResponse")
                }
              }
            },
            400: {
              description: "Payload invalido.",
              content: {
                "application/json": {
                  schema: schema("ScheduleErrorResponse")
                }
              }
            },
            500: {
              description: "Erro interno ou configuracao invalida de persistencia.",
              content: {
                "application/json": {
                  schema: schema("ScheduleErrorResponse")
                }
              }
            },
            502: {
              description: "Falha ao persistir no Bubble.",
              content: {
                "application/json": {
                  schema: schema("ScheduleErrorResponse")
                }
              }
            }
          }
        }
      }
    },
    components: {
      schemas: {
        HealthResponse: {
          type: "object",
          required: ["ok", "service", "version", "uptime", "timestamp"],
          properties: {
            ok: { type: "boolean", example: true },
            service: { type: "string", example: "moni-schedule-engine" },
            version: { type: "string", example: packageJson.version },
            uptime: { type: "number", example: 123.45 },
            timestamp: { type: "string", format: "date-time" }
          }
        },
        ReadyResponse: {
          type: "object",
          required: ["ok", "service", "ready", "timestamp"],
          properties: {
            ok: { type: "boolean", example: true },
            service: { type: "string", example: "moni-schedule-engine" },
            ready: { type: "boolean", example: true },
            timestamp: { type: "string", format: "date-time" }
          }
        },
        SchedulePayload: {
          type: "object",
          required: ["cronograma_unique_id", "dias_trabalho_semana", "obra_json", "atividades_json"],
          properties: {
            cronograma_unique_id: { type: "string" },
            versao_cronograma_unique_id: { type: "string", description: "Nova versao do cronograma." },
            previous_version_id: { type: "string", nullable: true, description: "Versao anterior, obrigatoria em recalculo." },
            mode: { type: "string", enum: ["generate", "recalculate"] },
            dias_trabalho_semana: { type: "integer", enum: [5, 6] },
            timezone: { type: "string", example: "America/Sao_Paulo" },
            event_date: { type: "string", nullable: true },
            obra_json: {
              type: "array",
              items: schema("ObraPayload")
            },
            obra_ambiente_json: {
              type: "array",
              items: jsonObject("Ambiente da obra vindo do Bubble.")
            },
            obra_ambiente_produto_json: {
              type: "array",
              items: jsonObject("Produto por ambiente vindo do Bubble.")
            },
            obra_ambiente_item_composicao_json: {
              type: "array",
              items: jsonObject("Item de composicao por ambiente vindo do Bubble.")
            },
            atividades_json: {
              type: "array",
              items: schema("ActivityPayload")
            },
            atividade_obra_json: {
              type: "array",
              items: jsonObject("Snapshot anterior de Atividade x Obra.")
            },
            events_old: {
              type: "array",
              items: jsonObject("Eventos antigos do cronograma.")
            },
            events_json: {
              type: "array",
              items: schema("RecalculateEvent")
            }
          },
          additionalProperties: true
        },
        ObraPayload: {
          type: "object",
          properties: {
            id: { type: "string" },
            unique_id: { type: "string" },
            nome: { type: "string" },
            dataInicio: { type: "string", format: "date" }
          },
          additionalProperties: true
        },
        ActivityPayload: {
          type: "object",
          required: ["tipo"],
          properties: {
            id: { type: "string" },
            unique_id: { type: "string" },
            nome: { type: "string" },
            tipo: { type: "string", enum: ["Servico", "Serviço", "Compra", "Projeto"] },
            atividadeServicoAncoraId: { type: "string", nullable: true },
            interdependenciasMasterIds: {
              type: "array",
              items: { type: "string" }
            },
            ordem: { type: "integer" },
            duracao: { type: "integer" },
            duracaoVariavel: { type: "boolean" },
            quantidadeBase: { oneOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
            unidadeMedida: { type: "string", nullable: true },
            etapaCompra: { type: "string", nullable: true },
            peso: { type: "number" },
            equipe: { type: "string", nullable: true },
            offsetDias: { type: "integer" }
          },
          additionalProperties: true
        },
        RecalculateEvent: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "work_start_delayed",
                "activity_start_delayed",
                "activity_date_changed_cascade",
                "activity_date_changed_only",
                "from_date_delayed",
                "activity_inserted"
              ]
            },
            new_start_date: { type: "string", format: "date" },
            atividade_id: { type: "string" },
            id_atividade_obra_externo: { type: "string" },
            days: { type: "integer" }
          },
          additionalProperties: true
        },
        ScheduleSuccessResponse: {
          type: "object",
          required: ["ok", "serverVersionId", "previous_version_id", "version", "metrics", "validations"],
          properties: {
            ok: { type: "boolean", example: true },
            serverVersionId: { type: "string" },
            previous_version_id: { type: "string", nullable: true },
            version: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string" }
              }
            },
            metrics: schema("ScheduleMetrics"),
            validations: schema("ScheduleValidations")
          }
        },
        ScheduleErrorResponse: {
          type: "object",
          required: ["ok", "serverVersionId", "version", "metrics", "error", "validations"],
          properties: {
            ok: { type: "boolean", example: false },
            serverVersionId: { type: "null" },
            version: { type: "null" },
            metrics: { type: "null" },
            error: {
              type: "object",
              required: ["message", "code", "details"],
              properties: {
                message: { type: "string" },
                code: { type: "string" },
                details: {}
              }
            },
            validations: schema("ScheduleValidations")
          }
        },
        ScheduleMetrics: {
          type: "object",
          properties: {
            linesCount: { type: "integer" },
            servicesCount: { type: "integer" },
            purchasesCount: { type: "integer" },
            projectsCount: { type: "integer" },
            startedAt: { type: "string", format: "date-time" },
            finishedAt: { type: "string", format: "date-time" },
            durationMs: { type: "integer" }
          }
        },
        ScheduleValidations: {
          type: "object",
          required: ["warnings", "errors"],
          properties: {
            warnings: {
              type: "array",
              items: { type: "string" }
            },
            errors: {
              type: "array",
              items: { type: "string" }
            }
          }
        }
      }
    }
  };
}

function swaggerHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Moni Schedule Engine API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: window.location.pathname.replace(/\\/$/, "") + "/openapi.json",
        dom_id: "#swagger-ui"
      });
    </script>
  </body>
</html>`;
}

docsRoutes.get("/", (_, res) => {
  res.type("html").send(swaggerHtml());
});

docsRoutes.get("/openapi.json", (_, res) => {
  res.json(buildOpenApiDocument());
});
