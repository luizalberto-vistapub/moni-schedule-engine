import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { requestLogger } from "./middleware/request-logger.middleware.js";
import { docsRoutes } from "./routes/docs.routes.js";
import { healthRoutes, readyResponse } from "./routes/health.routes.js";
import { schedulesRoutes } from "./routes/schedules.routes.js";
import { buildScheduleErrorResponse } from "./services/response-builder.service.js";

const jsonBodyErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const typedError = error as { status?: number; type?: string; message?: string };
  const isJsonBodyError = typedError.type === "entity.parse.failed" || typedError.type === "entity.too.large";
  if (!isJsonBodyError) {
    next(error);
    return;
  }

  const message = typedError.type === "entity.too.large"
    ? "Request body exceeds the 10mb JSON limit"
    : "Invalid JSON request body";

  req.log?.warn({
    requestId: req.id,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: typedError.message || String(error)
  }, "json body parsing failed");

  res.status(typedError.status || 400).json(buildScheduleErrorResponse(message, "INVALID_JSON_BODY"));
};

export const app = express();

app.use(requestLogger);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(jsonBodyErrorHandler);

app.use("/health", healthRoutes);
app.get("/ready", (_, res) => {
  res.json(readyResponse());
});
app.use("/docs", docsRoutes);
app.use("/api/v1/schedules", schedulesRoutes);

app.use((_, res) => {
  res.status(404).json({
    ok: false,
    error: {
      message: "Route not found",
      code: "ROUTE_NOT_FOUND",
      details: {}
    },
    validations: {
      warnings: [],
      errors: []
    }
  });
});
