import pino from "pino";

export const logger = pino({
  base: { service: "moni-schedule-engine" },
  level: process.env.LOG_LEVEL
});