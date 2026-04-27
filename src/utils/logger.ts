import pino from "pino";

const validLogLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function getLogLevel(value = process.env.LOG_LEVEL): string {
  if (!value || value === "undefined") return "info";
  return validLogLevels.has(value) ? value : "info";
}

export const logger = pino({
  base: { service: "moni-schedule-engine" },
  level: getLogLevel()
});
