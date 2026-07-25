import cors from "cors";
import express from "express";
import { requestLogger } from "./middleware/request-logger.middleware.js";
import { docsRoutes } from "./routes/docs.routes.js";
import { healthRoutes, readyResponse } from "./routes/health.routes.js";
import { schedulesRoutes } from "./routes/schedules.routes.js";

export const app = express();

app.use(requestLogger);
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
