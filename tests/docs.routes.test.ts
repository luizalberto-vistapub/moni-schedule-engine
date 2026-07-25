import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";

describe("docs routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves swagger ui", async () => {
    const response = await request(app).get("/docs");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("SwaggerUIBundle");
  });

  it("does not expose the swagger alias", async () => {
    const response = await request(app).get("/swagger");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("labels the development branch document", async () => {
    vi.stubEnv("SWAGGER_BRANCH", "codex/bubble-bulk-persistence");

    const response = await request(app).get("/docs/openapi.json");

    expect(response.status).toBe(200);
    expect(response.body.info.title).toBe("Moni Schedule Engine API - Development");
    expect(response.body.info.version).toContain("Development - codex/bubble-bulk-persistence");
    expect(response.body.paths["/api/v1/schedules/generate"]).toBeTruthy();
  });

  it("labels the live branch document", async () => {
    vi.stubEnv("SWAGGER_BRANCH", "main");

    const response = await request(app).get("/docs/openapi.json");

    expect(response.status).toBe(200);
    expect(response.body.info.title).toBe("Moni Schedule Engine API - Live");
    expect(response.body.info.version).toContain("Live - main");
  });

  it("returns independent documents for development and live branches", async () => {
    vi.stubEnv("SWAGGER_BRANCH", "codex/bubble-bulk-persistence");
    const developmentResponse = await request(app).get("/docs/openapi.json");

    vi.stubEnv("SWAGGER_BRANCH", "main");
    const liveResponse = await request(app).get("/docs/openapi.json");

    expect(developmentResponse.status).toBe(200);
    expect(liveResponse.status).toBe(200);
    expect(developmentResponse.body.info.title).toBe("Moni Schedule Engine API - Development");
    expect(liveResponse.body.info.title).toBe("Moni Schedule Engine API - Live");
    expect(developmentResponse.body.info.version).not.toBe(liveResponse.body.info.version);
    expect(developmentResponse.body.info.description).toContain("codex/bubble-bulk-persistence");
    expect(liveResponse.body.info.description).toContain("main");
  });
});
