import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { ScanError } from "../src/networkGuard.js";
import { GroqProvider } from "../src/ai/groqProvider.js";
import { RepairService } from "../src/repairs/repairService.js";

const fixture = await readFile(resolve("test/fixtures/inaccessible.html"), "utf8");

const testAuth = {
  ready: () => true,
  sessionMiddleware: () => (_request, _response, next) => next(),
  requireReady: (_request, _response, next) => next(),
  requireOrigin: (_request, _response, next) => next(),
  requireUser: (request, _response, next) => {
    request.user = { id: "000000000000000000000001" };
    next();
  },
  loginLimiter: (_request, _response, next) => next(),
  register: (_request, response) => response.status(501).end(),
  login: (_request, response) => response.status(501).end(),
  logout: (_request, response) => response.status(501).end(),
  me: (_request, response) => response.status(501).end(),
};

function createTestApp(options = {}) {
  return createApp({ ...options, auth: testAuth });
}

function simulatedAudit(input) {
  const resolved = input.html.includes('aria-label="Contact"');
  const now = new Date().toISOString();
  const violation = {
    id: "label",
    impact: "serious",
    description: "Form controls need accessible names.",
    help: "Provide a label",
    helpUrl: "https://example.test/label",
    tags: ["wcag412"],
    wcagCriteria: ["WCAG 2.1 A"],
    nodeCount: 1,
    nodesTruncated: false,
    nodes: [{
      selector: "#email",
      targets: ["#email"],
      html: '<input id="email" type="email">',
      failureSummary: "Add an accessible name.",
      any: [],
      all: [],
      none: [],
      relatedNodes: [],
    }],
  };
  return {
    id: randomUUID(),
    sourceType: "html",
    source: input.projectName ?? "Test artifact",
    projectName: input.projectName ?? "Test artifact",
    status: "completed",
    createdAt: now,
    durationMs: 12,
    wcagLevel: input.wcagLevel,
    includeBestPractices: input.includeBestPractices,
    engine: { name: "Playwright + Chromium + axe-core", axeVersion: "4.14.0", tags: ["wcag21aa"] },
    summary: {
      score: resolved ? 100 : 80,
      scoreLabel: "AccessZ weighted rule indicator — not WCAG conformance",
      scoreBreakdown: { formula: "Actual applicable outcomes.", weights: { critical: 5, serious: 4, moderate: 2, minor: 1 } },
      violations: resolved ? 0 : 1,
      violationNodes: resolved ? 0 : 1,
      passes: resolved ? 1 : 0,
      incomplete: 0,
      inapplicable: 0,
      rulesEvaluated: 1,
    },
    violations: resolved ? [] : [violation],
    passes: resolved ? [{ id: "label" }] : [],
    incomplete: [],
    inapplicable: [],
    previewHtml: input.html,
    scanLimitations: ["Manual assessment is still required."],
  };
}

describe("A11yPilot API", () => {
  it("fails closed for protected endpoints when database-backed auth is unavailable", async () => {
    const unavailableAuth = createAuth({ databaseStatus: () => ({ connected: false, status: "not_configured" }) });
    const response = await request(createApp({ auth: unavailableAuth })).get("/api/audits/");

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("AUTH_NOT_CONFIGURED");
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("denies protected endpoints when no authenticated session is present", async () => {
    const anonymousAuth = {
      ...testAuth,
      requireUser(_request, response) {
        return response.status(401).json({
          error: { code: "AUTH_REQUIRED", message: "Sign in to access this resource." },
        });
      },
    };
    const response = await request(createApp({ auth: anonymousAuth })).get("/api/audits/");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTH_REQUIRED");
    expect(response.body.stack).toBeUndefined();
  });

  it("rate-limits repeated sign-in requests and includes the request ID", async () => {
    const limiter = createAuth({ databaseStatus: () => ({ connected: true, status: "connected" }) }).loginLimiter;
    const limitedAuth = { ...testAuth, loginLimiter: limiter };
    const app = createApp({ auth: limitedAuth });
    let response;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await request(app).post("/api/auth/login").send({});
    }

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("LOGIN_RATE_LIMITED");
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("isolates persisted audit history between two authenticated users", async () => {
    const data = new Map();
    const ensureUser = (userId) => {
      if (!data.has(userId)) data.set(userId, { audits: [], repairs: [], verifications: [], artifacts: [] });
      return data.get(userId);
    };
    const repository = {
      async loadWorkspace(userId) {
        return structuredClone(ensureUser(userId));
      },
      async saveAudit(userId, audit) {
        const bucket = ensureUser(userId);
        bucket.audits = [audit, ...bucket.audits.filter(({ id }) => id !== audit.id)];
      },
      async saveRepair(userId, repair) {
        const bucket = ensureUser(userId);
        bucket.repairs = [repair, ...bucket.repairs.filter(({ id }) => id !== repair.id)];
      },
      async saveVerification(userId, verification) {
        const bucket = ensureUser(userId);
        bucket.verifications = [verification, ...bucket.verifications.filter(({ id }) => id !== verification.id)];
      },
      async saveArtifact(userId, artifact) {
        const bucket = ensureUser(userId);
        bucket.artifacts = [artifact, ...bucket.artifacts.filter(({ id }) => id !== artifact.id)];
      },
      async saveRepairAndArtifact(userId, repair, artifact) {
        const bucket = ensureUser(userId);
        bucket.repairs = [repair, ...bucket.repairs.filter(({ id }) => id !== repair.id)];
        bucket.artifacts = [artifact, ...bucket.artifacts.filter(({ id }) => id !== artifact.id)];
      },
    };
    const perRequestAuth = {
      ...testAuth,
      requireUser(request, _response, next) {
        request.user = { id: request.get("X-Test-User") ?? "user-a" };
        next();
      },
    };
    const app = createApp({
      auth: perRequestAuth,
      repository,
      storageName: "test_memory",
      scan: async (input) => simulatedAudit(input),
    });
    const created = await request(app)
      .post("/api/audits/html")
      .set("X-Test-User", "user-a")
      .send({ html: "<main><h1>Private audit</h1></main>", projectName: "User A" });
    expect(created.status).toBe(201);
    const auditId = created.body.audit.id;

    const ownHistory = await request(app).get("/api/audits/").set("X-Test-User", "user-a");
    const otherHistory = await request(app).get("/api/audits/").set("X-Test-User", "user-b");
    const otherDetail = await request(app).get(`/api/audits/${auditId}`).set("X-Test-User", "user-b");
    const ownerArtifacts = await request(app).get("/api/artifacts/").set("X-Test-User", "user-a");
    const otherArtifacts = await request(app).get("/api/artifacts/").set("X-Test-User", "user-b");
    const otherArtifact = await request(app).get(`/api/artifacts/${ownerArtifacts.body.artifacts[0].id}`).set("X-Test-User", "user-b");

    expect(ownHistory.body.audits).toHaveLength(1);
    expect(ownHistory.body.storage).toBe("test_memory");
    expect(otherHistory.body.audits).toHaveLength(0);
    expect(otherDetail.status).toBe(404);
    expect(data.get("user-b").audits).toHaveLength(0);
    expect(ownerArtifacts.body.artifacts).toHaveLength(1);
    expect(otherArtifacts.body.artifacts).toHaveLength(0);
    expect(otherArtifact.status).toBe(404);
    expect(data.get("user-b").artifacts).toHaveLength(0);
  });

  it("reports the real scanner engine and a request ID", async () => {
    const response = await request(createTestApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.capabilities.accessibilityScanning).toMatch(/playwright-axe-core|unavailable/);
    expect(response.body.scanner.status).toMatch(/available|unavailable/);
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
    expect(response.body.scanner.engine).toBe("Playwright + Chromium + axe-core");
  });

  it("allows only configured local browser origins through CORS", async () => {
    const app = createTestApp();
    const local = await request(app).get("/api/audits/").set("Origin", "http://localhost:5173");
    const remote = await request(app).get("/api/audits/").set("Origin", "https://attacker.example");

    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(remote.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("runs a real Chromium and axe-core scan and retains actual results", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              proposedCode: '<input type="email" aria-label="Contact">',
              explanation: "Use the adjacent visible label as the control name.",
              accessibilityRationale: "The field needs a programmatic accessible name.",
              expectedVerificationCriteria: ["The label violation is absent after a successful rescan."],
              assumptions: ["The adjacent label accurately describes the field."],
              manualReviewRequired: true,
            }),
          },
        }],
      }),
    });
    const app = createTestApp({
      repairs: new RepairService({
        provider: new GroqProvider({ apiKey: "test-key-not-a-secret", model: "openai/gpt-oss-120b", fetchImpl }),
      }),
    });
    const response = await request(app).post("/api/audits/html").send({
      html: fixture,
      projectName: "Regression fixture",
      wcagLevel: "AA",
      includeBestPractices: false,
    });

    expect(response.status).toBe(201);
    expect(response.body.audit.status).toBe("completed");
    expect(response.body.audit.engine.axeVersion).toBeTruthy();
    expect(response.body.audit.createdAt).toMatch(/Z$/);
    expect(response.body.audit.durationMs).toBeGreaterThan(0);
    expect(response.body.audit.violations.map((item) => item.id)).toEqual(expect.arrayContaining(["image-alt", "label", "color-contrast"]));
    expect(response.body.audit.violations.find((item) => item.id === "image-alt").nodes[0]).toMatchObject({
      selector: expect.any(String),
      html: expect.stringContaining("<img"),
      failureSummary: expect.any(String),
    });
    expect(response.body.audit.keyboardAudit.status).toBe("review_candidates_only");
    expect(response.body.audit.summary.scoreLabel).toContain("not WCAG conformance");
    expect(response.body.audit.scanLimitations.join(" ")).toContain("manual assessment");

    const auditId = response.body.audit.id;
    const detail = await request(app).get(`/api/audits/${auditId}`);
    const history = await request(app).get("/api/audits/?limit=5");
    expect(detail.body.audit.id).toBe(auditId);
    expect(history.body.audits[0].id).toBe(auditId);
    expect(history.body.audits[0].previewHtml).toBeUndefined();
    expect(history.body.storage).toBe("in_memory");

    const labelViolation = response.body.audit.violations.find(({ id }) => id === "label");
    const controlledArtifacts = await request(app).get("/api/artifacts/");
    expect(controlledArtifacts.status).toBe(200);
    const artifactId = controlledArtifacts.body.artifacts.find((item) => item.auditId === auditId).id;
    const suggestionResponse = await request(app).post("/api/repairs/suggest").send({
      auditId,
      artifactId,
      violationId: labelViolation.id,
      nodeIndex: 0,
    });
    expect(suggestionResponse.status).toBe(201);
    expect(suggestionResponse.body.repair.source).toBe("groq");
    expect(suggestionResponse.body.repair.proposedCode).toContain('aria-label="Contact"');
    expect(suggestionResponse.body.repair.status).toBe("proposed");
    expect(suggestionResponse.body.repair.manualReviewRequired).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).response_format.json_schema.strict).toBe(true);

    const repairId = suggestionResponse.body.repair.id;
    const reviewedPatch = {
      reviewedPatchHash: suggestionResponse.body.repair.patchHash,
      artifactVersion: suggestionResponse.body.repair.artifactVersion,
    };
    const tamperedPatch = await request(app).post(`/api/repairs/${repairId}/apply`).send({
      manualReviewConfirmed: true,
      reviewedPatchHash: "0".repeat(64),
      artifactVersion: reviewedPatch.artifactVersion,
    });
    expect(tamperedPatch.status).toBe(409);
    expect(tamperedPatch.body.error.code).toBe("PATCH_REVIEW_MISMATCH");
    const staleArtifact = await request(app).post(`/api/repairs/${repairId}/apply`).send({
      manualReviewConfirmed: true,
      reviewedPatchHash: reviewedPatch.reviewedPatchHash,
      artifactVersion: reviewedPatch.artifactVersion + 1,
    });
    expect(staleArtifact.status).toBe(409);
    expect(staleArtifact.body.error.code).toBe("ARTIFACT_VERSION_CONFLICT");
    const approvalMissing = await request(app).post(`/api/repairs/${repairId}/apply`).send({ manualReviewConfirmed: false, ...reviewedPatch });
    expect(approvalMissing.status).toBe(400);
    expect(approvalMissing.body.error.code).toBe("MANUAL_REVIEW_REQUIRED");

    const applied = await request(app).post(`/api/repairs/${repairId}/apply`).send({ manualReviewConfirmed: true, ...reviewedPatch });
    expect(applied.status).toBe(200);
    expect(applied.body.repair.status).toBe("applied");
    expect(applied.body.repair.updatedArtifact).toContain('aria-label="Contact"');
    expect(applied.body.repair.verifiedAt).toBeUndefined();
    expect(applied.body.repair.approvedBy).toBe(testAuth.requireUser ? "000000000000000000000001" : undefined);

    const rolledBack = await request(app).post(`/api/repairs/${repairId}/rollback`);
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body.repair.status).toBe("rolled_back");
    expect(rolledBack.body.repair.updatedArtifact).not.toContain('aria-label="Contact"');
    const restoredArtifact = await request(app).get(`/api/artifacts/${artifactId}`);
    expect(restoredArtifact.body.artifact.version).toBe(3);
    expect(restoredArtifact.body.artifact.html).not.toContain('aria-label="Contact"');
  }, 45_000);

  it("requires a user-controlled artifact for URL findings and accepts bounded HTML uploads", async () => {
    const urlAudit = {
      ...simulatedAudit({ html: "" }),
      sourceType: "url",
      requestedUrl: "https://public.example/",
      previewHtml: undefined,
    };
    const scan = vi.fn(async (input) => ({ ...urlAudit, additionalCss: input.additionalCss }));
    const app = createTestApp({ scan });
    const additionalCss = ".content { color: #333; }";
    const scanned = await request(app).post("/api/audits/url").send({ url: "https://public.example/", additionalCss });
    expect(scanned.status).toBe(201);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ additionalCss }), expect.anything());
    expect(scanned.body.audit.additionalCss).toBe(additionalCss);
    expect((await request(app).get(`/api/audits/${urlAudit.id}`)).body.audit.additionalCss).toBe(additionalCss);
    expect((await request(app).get("/api/artifacts/")).body.artifacts).toHaveLength(0);

    const suggestion = await request(app).post("/api/repairs/suggest").send({
      auditId: urlAudit.id,
      artifactId: randomUUID(),
      violationId: "label",
      nodeIndex: 0,
    });
    expect(suggestion.status).toBe(404);
    expect(suggestion.body.error.code).toBe("ARTIFACT_NOT_FOUND");

    const uploaded = await request(app).post("/api/artifacts/").send({
      name: "owned-source.html",
      html: "<!doctype html><html><body><main><h1>Owned source</h1></main></body></html>",
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.artifact.version).toBe(1);
    const download = await request(app).get(`/api/artifacts/${uploaded.body.artifact.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.text).toContain("Owned source");
  });

  it("verifies a scoped repair only after a real follow-up scan and exports matching reports", async () => {
    const scan = vi.fn(async (input) => simulatedAudit(input));
    const app = createTestApp({
      scan,
      repairs: new RepairService({ provider: new GroqProvider({ apiKey: "", fetchImpl: vi.fn() }) }),
    });
    const baseline = await request(app).post("/api/audits/html").send({
      html: '<main><label>Contact</label><input id="email" type="email"></main>',
      projectName: "Verification fixture",
      wcagLevel: "AA",
      includeBestPractices: false,
    });
    expect(baseline.status).toBe(201);
    const auditId = baseline.body.audit.id;
    const artifactResponse = await request(app).get("/api/artifacts/");
    const artifactId = artifactResponse.body.artifacts.find((item) => item.auditId === auditId).id;
    const suggestion = await request(app).post("/api/repairs/suggest").send({
      auditId,
      artifactId,
      violationId: "label",
      nodeIndex: 0,
    });
    expect(suggestion.status).toBe(201);
    expect(suggestion.body.repair.baselineSnapshot).toBeUndefined();
    const repairId = suggestion.body.repair.id;
    const applied = await request(app).post(`/api/repairs/${repairId}/apply`).send({
      manualReviewConfirmed: true,
      reviewedPatchHash: suggestion.body.repair.patchHash,
      artifactVersion: suggestion.body.repair.artifactVersion,
    });
    expect(applied.body.repair.status).toBe("applied");
    expect(applied.body.repair.updatedArtifact).toContain('aria-label="Contact"');

    const first = await request(app).post(`/api/repairs/${repairId}/verify`);
    expect(first.status).toBe(201);
    expect(first.body.verification).toMatchObject({
      status: "verified",
      baselineAuditId: auditId,
      comparisonBaselineAuditId: expect.any(String),
      baselineScore: 80,
      sourceAuditScore: 80,
      finalScore: 100,
      scoreDifference: 20,
      baselineScanStatus: "completed",
      scope: "controlled_html_snapshot",
    });
    expect(first.body.verification.comparisonBaselineAuditId).not.toBe(auditId);
    expect(first.body.verification.comparison.counts.resolved).toBe(1);
    expect(applied.body.repair.verifiedAt).toBeUndefined();
    expect(app.locals.repairs.get(repairId).status).toBe("verified");

    const repeated = await request(app).post(`/api/repairs/${repairId}/verify`);
    expect(repeated.body.verification.comparison).toEqual(first.body.verification.comparison);
    expect(scan).toHaveBeenCalledTimes(5);
    const jsonReport = await request(app).get(`/api/audits/${auditId}/report.json`);
    const htmlReport = await request(app).get(`/api/audits/${auditId}/report.html`);
    expect(jsonReport.status).toBe(200);
    expect(jsonReport.body.audit.id).toBe(auditId);
    expect(jsonReport.body.verifications).toHaveLength(2);
    expect(jsonReport.body.repairs[0]).toMatchObject({ status: "verified", verificationStatus: "verified" });
    expect(jsonReport.body.repairs[0].baselineSnapshot).toBeUndefined();
    expect(htmlReport.status).toBe(200);
    expect(htmlReport.text).toContain("verified");
  });

  it("records failed verification without updating the score or falsely verifying a repair", async () => {
    let scanCount = 0;
    const scan = vi.fn(async (input) => {
      scanCount += 1;
      if (scanCount > 2) throw new ScanError("SCAN_TIMEOUT", "The audit exceeded its time limit and was stopped.", 504);
      return simulatedAudit(input);
    });
    const app = createTestApp({
      scan,
      repairs: new RepairService({ provider: new GroqProvider({ apiKey: "", fetchImpl: vi.fn() }) }),
    });
    const baseline = await request(app).post("/api/audits/html").send({
      html: '<main><label>Contact</label><input id="email" type="email"></main>',
      wcagLevel: "AA",
      includeBestPractices: false,
    });
    const artifacts = await request(app).get("/api/artifacts/");
    const suggestion = await request(app).post("/api/repairs/suggest").send({
      auditId: baseline.body.audit.id,
      artifactId: artifacts.body.artifacts.find((item) => item.auditId === baseline.body.audit.id).id,
      violationId: "label",
      nodeIndex: 0,
    });
    const repairId = suggestion.body.repair.id;
    await request(app).post(`/api/repairs/${repairId}/apply`).send({
      manualReviewConfirmed: true,
      reviewedPatchHash: suggestion.body.repair.patchHash,
      artifactVersion: suggestion.body.repair.artifactVersion,
    });

    const failed = await request(app).post(`/api/repairs/${repairId}/verify`);
    expect(failed.status).toBe(504);
    expect(failed.body.verification).toMatchObject({ status: "failed", baselineScore: 80, finalScore: null, scoreDifference: null });
    expect(app.locals.repairs.get(repairId).status).toBe("needs_review");
    expect((await request(app).get(`/api/audits/${baseline.body.audit.id}/verifications`)).body.verifications).toHaveLength(1);
  });

  it("rejects malformed, oversized, and invalid HTML inputs before scanning", async () => {
    const scan = vi.fn();
    const app = createTestApp({ scan });
    const invalid = await request(app).post("/api/audits/html").send({ html: "" });
    const oversized = await request(app).post("/api/audits/html").send({ html: "x".repeat(300_001) });
    const malformed = await request(app).post("/api/audits/url").send({ url: "not-a-url" });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    expect(invalid.body.error.requestId).toBe(invalid.headers["x-request-id"]);
    expect(oversized.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(scan).not.toHaveBeenCalled();
  });

  it("rejects private destinations and disallowed URL schemes", async () => {
    const app = createTestApp();
    const privateTarget = await request(app).post("/api/audits/url").send({ url: "http://127.0.0.1" });
    const disallowedScheme = await request(app).post("/api/audits/url").send({ url: "ftp://example.com/resource" });

    expect(privateTarget.status).toBe(400);
    expect(privateTarget.body.error.code).toBe("DESTINATION_BLOCKED");
    expect(disallowedScheme.status).toBe(400);
    expect(disallowedScheme.body.error.code).toBe("DISALLOWED_SCHEME");
    expect(privateTarget.body.stack).toBeUndefined();
  });

  it("returns scanner failures without creating successful audits or exposing stacks", async () => {
    let scanOptions;
    const app = createTestApp({
      scan: async (_input, options) => {
        scanOptions = options;
        throw new ScanError("SCAN_TIMEOUT", "The audit exceeded its time limit and was stopped.", 504);
      },
    });
    const response = await request(app).post("/api/audits/html").send({ html: "<main><h1>Test</h1></main>" });
    const history = await request(app).get("/api/audits/");

    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe("SCAN_TIMEOUT");
    expect(response.body.stack).toBeUndefined();
    expect(scanOptions.requestId).toBe(response.headers["x-request-id"]);
    expect(history.body.audits).toHaveLength(0);
  });

  it("validates repair requests and keeps provider credentials out of health responses", async () => {
    const app = createTestApp({
      repairs: new RepairService({
        provider: new GroqProvider({ apiKey: "test-key-not-for-production", model: "custom-model", fetchImpl: vi.fn() }),
      }),
    });
    const health = await request(app).get("/api/health");
    const invalidSuggestion = await request(app).post("/api/repairs/suggest").send({ auditId: "invalid" });

    expect(health.body.capabilities.aiSuggestions).toMatchObject({
      provider: "groq",
      status: "configured",
      model: "custom-model",
    });
    expect(JSON.stringify(health.body)).not.toContain("test-key-not-for-production");
    expect(invalidSuggestion.status).toBe(400);
    expect(invalidSuggestion.body.error.code).toBe("VALIDATION_ERROR");
    expect(invalidSuggestion.body.stack).toBeUndefined();
  });

  it("returns consistent 404 and history validation errors", async () => {
    const app = createTestApp();
    const missing = await request(app).get("/api/unknown");
    const invalidLimit = await request(app).get("/api/audits/?limit=1000");
    const malformedJson = await request(app)
      .post("/api/audits/html")
      .set("Content-Type", "application/json")
      .send('{"html":');

    expect(missing.status).toBe(404);
    expect(missing.body.error.requestId).toBe(missing.headers["x-request-id"]);
    expect(invalidLimit.status).toBe(400);
    expect(invalidLimit.body.error.code).toBe("VALIDATION_ERROR");
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.body.error.code).toBe("INVALID_JSON");
    expect(malformedJson.body.error.requestId).toBe(malformedJson.headers["x-request-id"]);
  });
});
