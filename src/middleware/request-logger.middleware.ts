import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pinoHttp } from "pino-http";
import { logger } from "../utils/logger.js";

export function getRequestId(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  if (Array.isArray(header)) return header[0] || randomUUID();
  return header || randomUUID();
}

export const requestLogger = pinoHttp({
  logger,
  genReqId(req: IncomingMessage, res: ServerResponse) {
    const requestId = getRequestId(req);
    res.setHeader("x-request-id", requestId);
    return requestId;
  },
  customProps(req: IncomingMessage) {
    return {
      requestId: req.id
    };
  }
});