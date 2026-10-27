import { describe, expect, it, vi } from "vitest";
import { GroqProvider } from "../src/ai/groqProvider.js";
import { RepairService } from "../src/repairs/repairService.js";

const audit = {
  id: "bf0a7f10-8f81-47e1-a21d-c4d7a170003e",
  sourceType: "html",
  previewHtml: '<!doctype html><html><body><main><label>Contact</label><input id="email" type="email"></main></body></html>',
  violations: [{
    id: "label",
    impact: "serious",
    description: "Form controls need labels.",
    wcagCriteria: ["WCAG 2.1 A"],
    nodes: [{ selector: "#email", html: '<input id="email" type="email">', failureSummary: "Add a label." }],
  }],
};
const artifact = {
  id: "da52ac2d-a62c-4c36-aeb1-13b843a2e3bc",
  name: "fixture.html",
  auditId: audit.id,
  html: audit.previewHtml,
  version: 1,
};
const contrastAudit = {
  id: "c1b433e8-053e-4d93-bd8a-0e31940e6b37",
  sourceType: "html",
  previewHtml: '<!doctype html><html><head><style>.copy { color: #888; } body { background: #fff; }</style></head><body><p id="copy" class="copy">Readable text</p></body></html>',
  violations: [{
    id: "color-contrast",
    impact: "serious",
    description: "Text does not have sufficient contrast.",
    wcagCriteria: ["WCAG 2.1 AA"],
    nodes: [{
      selector: "#copy",
      html: '<p id="copy" class="copy">Readable text</p>',
      failureSummary: "Contrast is insufficient.",
      relatedNodes: [],
      styleEvidence: {
        color: "rgb(136, 136, 136)",
        backgroundColor: "rgba(0, 0, 0, 0)",
        effectiveBackground: "rgb(255, 255, 255)",
        backgroundUncertain: false,
        fontSize: "16px",
        fontWeight: "400",
        matchedRules: [],
      },
    }],
  }],
};
const contrastArtifact = {
  id: "51713f42-9d6c-4c40-b185-8d462ce8bf54",
  name: "contrast-fixture.html",
  auditId: contrastAudit.id,
  html: contrastAudit.previewHtml,
  version: 1,
};

describe("repair service provider fallback", () => {
  it("uses stylesheet evidence stored with the audit when preparing a suggestion", async () => {
    const provider = {
      getStatus: () => ({ provider: "groq", status: "configured", model: "openai/gpt-oss-120b" }),
      suggest: vi.fn().mockResolvedValue({
        proposedCode: '<p id="copy" class="copy" style="color: #000000">Readable text</p>',
        explanation: "Use a higher contrast text color.",
        accessibilityRationale: "Text needs sufficient contrast.",
        expectedVerificationCriteria: ["The contrast finding is absent on a successful rescan."],
        assumptions: [],
        manualReviewRequired: false,
      }),
    };
    const auditWithCss = {
      ...contrastAudit,
      sourceType: "url",
      additionalCss: ".copy { color: #888; background-color: #fff; }",
    };
    const service = new RepairService({ provider });

    await service.suggest({
      auditStore: new Map([[auditWithCss.id, auditWithCss]]),
      repairStore: new Map(),
      controlledArtifacts: new Map([[contrastArtifact.id, structuredClone(contrastArtifact)]]),
      input: {
        auditId: auditWithCss.id,
        artifactId: contrastArtifact.id,
        violationId: "color-contrast",
        nodeIndex: 0,
      },
    });

    expect(provider.suggest).toHaveBeenCalledWith(expect.objectContaining({
      cssEvidence: expect.objectContaining({
        suppliedStylesheet: true,
        declarations: expect.arrayContaining([
          expect.objectContaining({
            source: "developer-provided stylesheet",
            selector: ".copy",
          }),
        ]),
      }),
    }));
  });

  it("returns an evidenced, calculated CSS patch for review without applying it", async () => {
    const provider = {
      getStatus: () => ({ provider: "groq", status: "configured", model: "openai/gpt-oss-120b" }),
      suggest: vi.fn().mockResolvedValue({
        proposedCode: '<p id="copy" class="copy" style="color: #000000">Readable text</p>',
        explanation: "Use a higher contrast text color.",
        accessibilityRationale: "Text needs sufficient contrast.",
        expectedVerificationCriteria: ["The contrast finding is absent on a successful rescan."],
        assumptions: ["The candidate is an override in the controlled artifact."],
        manualReviewRequired: false,
      }),
    };
    const repairStore = new Map();
    const artifactStore = new Map([[contrastArtifact.id, structuredClone(contrastArtifact)]]);
    const service = new RepairService({ provider });
    const repair = await service.suggest({
      auditStore: new Map([[contrastAudit.id, contrastAudit]]),
      repairStore,
      controlledArtifacts: artifactStore,
      input: {
        auditId: contrastAudit.id,
        artifactId: contrastArtifact.id,
        violationId: "color-contrast",
        nodeIndex: 0,
      },
    });

    expect(repair.status).toBe("proposed");
    expect(repair.applicable).toBe(true);
    expect(repair.manualReviewRequired).toBe(true);
    expect(repair.cssPatch).toMatchObject({
      targetSelector: "#copy",
      proposedDeclaration: "color: rgb(0, 0, 0);",
      contrastCheck: {
        status: "candidate_pass_not_verified",
        passes: true,
        requiredRatio: 4.5,
      },
    });
    expect(repair.cssPatch.application).toMatch(/only to this controlled artifact/);
    expect(artifactStore.get(contrastArtifact.id).html).toBe(contrastArtifact.html);
    expect(() => service.apply({
      auditStore: new Map([[contrastAudit.id, contrastAudit]]),
      repairStore,
      controlledArtifacts: artifactStore,
      repairId: repair.id,
      manualReviewConfirmed: false,
      reviewedPatchHash: repair.patchHash,
      artifactVersion: repair.artifactVersion,
    })).toThrow(/Confirm that you reviewed/);
    const applied = service.apply({
      auditStore: new Map([[contrastAudit.id, contrastAudit]]),
      repairStore,
      controlledArtifacts: artifactStore,
      repairId: repair.id,
      manualReviewConfirmed: true,
      reviewedPatchHash: repair.patchHash,
      artifactVersion: repair.artifactVersion,
    });
    expect(applied.status).toBe("applied");
    expect(applied.updatedArtifact).toContain('style="color: #000000"');
    expect(applied.updatedArtifact).toContain("<p id=\"copy\" class=\"copy\"");
    expect(applied.updatedArtifact).toContain("<style>.copy { color: #888; }");
  });

  it("does not call Groq or invent a contrast repair when source CSS is unidentified", async () => {
    const provider = {
      getStatus: () => ({ provider: "groq", status: "configured", model: "openai/gpt-oss-120b" }),
      suggest: vi.fn(),
    };
    const auditWithoutStyles = {
      ...contrastAudit,
      previewHtml: '<!doctype html><html><body><p id="copy">Readable text</p></body></html>',
      violations: [{
        ...contrastAudit.violations[0],
        nodes: [{
          ...contrastAudit.violations[0].nodes[0],
          html: '<p id="copy">Readable text</p>',
        }],
      }],
    };
    const artifactWithoutStyles = {
      ...contrastArtifact,
      auditId: auditWithoutStyles.id,
      html: auditWithoutStyles.previewHtml,
    };
    const service = new RepairService({ provider });
    const repair = await service.suggest({
      auditStore: new Map([[auditWithoutStyles.id, auditWithoutStyles]]),
      repairStore: new Map(),
      controlledArtifacts: new Map([[artifactWithoutStyles.id, artifactWithoutStyles]]),
      input: {
        auditId: auditWithoutStyles.id,
        artifactId: artifactWithoutStyles.id,
        violationId: "color-contrast",
        nodeIndex: 0,
      },
    });

    expect(provider.suggest).not.toHaveBeenCalled();
    expect(repair.source).toBe("manual");
    expect(repair.applicable).toBe(false);
    expect(repair.explanation).toMatch(/Provide the relevant stylesheet/);
    expect(repair.cssPatch.application).toMatch(/No CSS patch proposed/);
  });

  it("uses supplied external CSS as evidence and labels the artifact-only override", async () => {
    const externalArtifact = {
      ...contrastArtifact,
      html: '<!doctype html><html><body><p id="copy" class="copy">Readable text</p></body></html>',
    };
    const externalAudit = {
      ...contrastAudit,
      previewHtml: externalArtifact.html,
    };
    const provider = {
      getStatus: () => ({ provider: "groq", status: "configured", model: "openai/gpt-oss-120b" }),
      suggest: vi.fn().mockResolvedValue({
        proposedCode: '<p id="copy" class="copy" style="color: #000000">Readable text</p>',
        explanation: "Use a higher contrast text color.",
        accessibilityRationale: "Text needs sufficient contrast.",
        expectedVerificationCriteria: ["Rescan the controlled artifact."],
        assumptions: ["The supplied stylesheet reflects the intended source."],
        manualReviewRequired: false,
      }),
    };
    const service = new RepairService({ provider });
    const repair = await service.suggest({
      auditStore: new Map([[externalAudit.id, externalAudit]]),
      repairStore: new Map(),
      controlledArtifacts: new Map([[externalArtifact.id, externalArtifact]]),
      input: {
        auditId: externalAudit.id,
        artifactId: externalArtifact.id,
        violationId: "color-contrast",
        nodeIndex: 0,
        cssSource: ".copy { color: #888; } body { background-color: #fff; }",
      },
    });

    expect(provider.suggest).toHaveBeenCalledWith(expect.objectContaining({
      cssEvidence: expect.objectContaining({ suppliedStylesheet: true, sourceKnown: true }),
    }));
    expect(repair.cssPatch.suppliedStylesheet).toBe(true);
    expect(repair.cssPatch.application).toMatch(/source stylesheet remains unchanged/);
    expect(repair.cssPatch.originalDeclaration).toContain(".copy");
  });

  it("creates deterministic suggestions without Groq credentials", async () => {
    const service = new RepairService({ provider: new GroqProvider({ apiKey: "", fetchImpl: vi.fn() }) });
    const repair = await service.suggest({
      auditStore: new Map([[audit.id, audit]]),
      repairStore: new Map(),
      controlledArtifacts: new Map([[artifact.id, structuredClone(artifact)]]),
      input: { auditId: audit.id, artifactId: artifact.id, violationId: "label", nodeIndex: 0 },
    });

    expect(repair.source).toBe("deterministic");
    expect(repair.applicable).toBe(true);
    expect(repair.proposedCode).toContain('aria-label="Contact"');
  });

  it("falls back safely when the configured Groq model is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new GroqProvider({
      apiKey: "test-key",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => "{}",
      }),
    });
    const service = new RepairService({ provider });
    const repair = await service.suggest({
      auditStore: new Map([[audit.id, audit]]),
      repairStore: new Map(),
      controlledArtifacts: new Map([[artifact.id, structuredClone(artifact)]]),
      input: { auditId: audit.id, artifactId: artifact.id, violationId: "label", nodeIndex: 0 },
    });

    expect(repair.source).toBe("deterministic");
    expect(repair.fallbackReason).toMatch(/model is unavailable/);
    expect(service.getStatus().status).toBe("temporarily_unavailable");
    expect(warning).toHaveBeenCalledWith("Groq repair suggestion failed:", {
      requestId: null,
      code: "GROQ_MODEL_UNAVAILABLE",
    });
    warning.mockRestore();
  });

  it("validates a real-shaped Groq patch and returns it for human review", async () => {
    const provider = {
      getStatus: () => ({ provider: "groq", status: "configured", model: "openai/gpt-oss-120b" }),
      suggest: vi.fn().mockResolvedValue({
        proposedCode: '<input id="email" type="email" aria-label="Contact">',
        explanation: "Give the field an accessible name.",
        accessibilityRationale: "Assistive technology needs the form control's purpose.",
        expectedVerificationCriteria: ["The label finding is absent on a successful rescan."],
        assumptions: ["Contact accurately describes this email field."],
        manualReviewRequired: true,
      }),
    };
    const service = new RepairService({ provider });
    const repair = await service.suggest({
      auditStore: new Map([[audit.id, audit]]),
      repairStore: new Map(),
      controlledArtifacts: new Map([[artifact.id, structuredClone(artifact)]]),
      input: { auditId: audit.id, artifactId: artifact.id, violationId: "label", nodeIndex: 0 },
    });

    expect(repair).toMatchObject({
      source: "groq",
      status: "proposed",
      applicable: true,
      manualReviewRequired: true,
      proposedCode: '<input id="email" type="email" aria-label="Contact">',
    });
    expect(repair.patchHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repair.status).not.toBe("applied");
  });

  it("falls back to scoped manual guidance when a provider payload misses the repair schema", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = {
        getStatus: () => ({ provider: "groq", status: "configured", model: "openai/gpt-oss-120b" }),
        suggest: vi.fn().mockResolvedValue({ proposedCode: "<script>alert(1)</script>" }),
      };
      const service = new RepairService({ provider });
      const repair = await service.suggest({
        auditStore: new Map([[audit.id, audit]]),
        repairStore: new Map(),
        controlledArtifacts: new Map([[artifact.id, structuredClone(artifact)]]),
        input: { auditId: audit.id, artifactId: artifact.id, violationId: "label", nodeIndex: 0, requestId: "request-test" },
      });

      expect(repair.source).toBe("deterministic");
      expect(repair.applicable).toBe(true);
      expect(repair.fallbackReason).toMatch(/invalid suggestion/);
      expect(repair.proposedCode).toContain('aria-label="Contact"');
      expect(warning).toHaveBeenCalledWith("Groq repair suggestion rejected:", {
        requestId: "request-test",
        code: "INVALID_SUGGESTION",
      });
    } finally {
      warning.mockRestore();
    }
  });
});
