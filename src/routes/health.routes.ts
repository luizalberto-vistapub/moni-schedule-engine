import { Router } from "express";
import packageJson from "../../package.json" with { type: "json" };

export const healthRoutes = Router();

export function readyResponse() {
  return {
    ok: true,
    service: "moni-schedule-engine",
    ready: true,
    timestamp: new Date().toISOString()
  };
}

healthRoutes.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "moni-schedule-engine",
    version: packageJson.version,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

healthRoutes.get("/ready", (_, res) => {
  res.json(readyResponse());
});
