import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { getRequestId } from "../src/middleware/request-logger.middleware.js";
import { getLogLevel } from "../src/utils/logger.js";

describe("request observability", () => {
  it("gets request id from a string header", () => {
    const req = { headers: { "x-request-id": "req_1" } } as unknown as IncomingMessage;

    expect(getRequestId(req)).toBe("req_1");
  });

  it("gets request id from the first array header", () => {
    const req = { headers: { "x-request-id": ["req_1", "req_2"] } } as unknown as IncomingMessage;

    expect(getRequestId(req)).toBe("req_1");
  });

  it("generates request id when header is absent or empty array", () => {
    const absent = { headers: {} } as unknown as IncomingMessage;
    const emptyArray = { headers: { "x-request-id": [] } } as unknown as IncomingMessage;

    expect(getRequestId(absent)).toMatch(/[0-9a-f-]{36}/);
    expect(getRequestId(emptyArray)).toMatch(/[0-9a-f-]{36}/);
  });

  it("falls back to info for missing or invalid log levels", () => {
    expect(getLogLevel()).toBe("silent");
    expect(getLogLevel("")).toBe("info");
    expect(getLogLevel("undefined")).toBe("info");
    expect(getLogLevel("verbose")).toBe("info");
    expect(getLogLevel("debug")).toBe("debug");
  });
});
