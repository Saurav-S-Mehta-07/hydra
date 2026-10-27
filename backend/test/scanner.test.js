import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getScannerRuntime, sanitizePreviewHtml, scannerConfiguration, scanAudit } from "../src/scanner.js";
import { applyScopedReplacement, deterministicProposal, prepareFindingContext } from "../src/repairs/repairEngine.js";

const fixture = await readFile(resolve("test/fixtures/inaccessible.html"), "utf8");

describe("real accessibility scanner", () => {
  it("runs axe against an isolated, sanitized HTML preview and captures keyboard review candidates", async () => {
    const audit = await scanAudit({
      sourceType: "html",
      html: fixture,
      projectName: "Regression fixture",
      wcagLevel: "AA",
      includeBestPractices: false,
    });

    expect(audit.engine.name).toBe("Playwright + Chromium + axe-core");
    expect(audit.violations.map((item) => item.id)).toEqual(expect.arrayContaining(["image-alt", "label", "color-contrast"]));
    expect(audit.violations.find((item) => item.id === "color-contrast").nodes[0].styleEvidence).toMatchObject({
      color: expect.any(String),
      effectiveBackground: expect.any(String),
      matchedRules: expect.any(Array),
    });
    expect(audit.previewHtml).not.toMatch(/<script\b/i);
    expect(audit.previewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(audit.keyboardAudit.status).toBe("review_candidates_only");
    expect(audit.keyboardAudit.capturedFocus.length).toBeGreaterThan(0);
    expect(audit.keyboardAudit.capturedFocus.map(({ direction }) => direction)).toEqual(expect.arrayContaining(["forward", "backward"]));
    expect(audit.keyboardAudit.candidates.map(({ type }) => type)).toContain("focus-indicator-review");
    expect(audit.summary.score).toEqual(expect.any(Number));
    expect(audit.durationMs).toBeGreaterThan(0);
    expect(getScannerRuntime()).toMatchObject({ activeBrowsers: 0, activePreviews: 0, activeProxies: 0, activeScans: 0 });
  }, 45_000);

  it("adds supplied CSS to the controlled HTML artifact without replacing existing styles", async () => {
    const audit = await scanAudit({
      sourceType: "html",
      html: '<!doctype html><html><head><style id="original-styles">p { color: #888; }</style></head><body><main><p style="font-weight: 700">Additional stylesheet test</p></main></body></html>',
      additionalCss: "p { background-color: #fff; }",
      projectName: "Supplemental CSS fixture",
      wcagLevel: "AA",
      includeBestPractices: false,
    });

    expect(audit.previewHtml).toContain('<style id="original-styles">p { color: #888; }</style>');
    expect(audit.previewHtml).toContain('<style data-accessz-additional-css="">p { background-color: #fff; }</style>');
    expect(audit.additionalCss).toBe("p { background-color: #fff; }");
  }, 45_000);

  it("calculates a CSS contrast override and verifies it only after an actual rescan", async () => {
    const baseline = await scanAudit({
      sourceType: "html",
      html: fixture,
      projectName: "CSS contrast verification fixture",
      wcagLevel: "AA",
      includeBestPractices: false,
    });
    const violation = baseline.violations.find((item) => item.id === "color-contrast");
    expect(violation).toBeTruthy();
    const finding = prepareFindingContext(baseline, violation, 0);
    const proposal = deterministicProposal({
      ruleId: violation.id,
      originalCode: finding.targetCode,
      styleEvidence: finding.context.styleEvidence,
      cssEvidence: finding.context.cssEvidence,
    });
    expect(finding.context.cssEvidence.sourceKnown).toBe(true);
    expect(proposal.applicable).toBe(true);
    expect(proposal.contrastCheck.passes).toBe(true);

    const repairedHtml = applyScopedReplacement(
      baseline.previewHtml,
      finding.repairSelector,
      finding.targetCode,
      proposal.proposedCode,
      violation.id,
    );
    const followup = await scanAudit({
      sourceType: "html",
      html: repairedHtml,
      projectName: "CSS contrast verification fixture",
      wcagLevel: "AA",
      includeBestPractices: false,
    });

    const remainingContrastNodes = followup.violations
      .find((item) => item.id === "color-contrast")?.nodes ?? [];
    expect(remainingContrastNodes.some((node) => node.html === finding.targetCode)).toBe(false);
  }, 90_000);

  it("removes navigable links and active content from controlled preview HTML", () => {
    const sanitized = sanitizePreviewHtml('<main><a href="https://example.com">link</a><img src="x"><script>alert(1)</script></main>');

    expect(sanitized).toContain("<main>");
    expect(sanitized).not.toContain("href=");
    expect(sanitized).not.toMatch(/<script\b/i);
  });

  it("blocks private URL targets before launching Chromium", async () => {
    await expect(scanAudit({
      sourceType: "url",
      url: "http://169.254.169.254/latest/meta-data/",
      wcagLevel: "AA",
      includeBestPractices: false,
    })).rejects.toMatchObject({ code: "DESTINATION_BLOCKED" });
  });

  it("cancels a browser scan and cleans up its preview and Chromium session", async () => {
    const controller = new AbortController();
    const scan = scanAudit({
      sourceType: "html",
      html: fixture,
      projectName: "Cancellation fixture",
      wcagLevel: "AA",
      includeBestPractices: false,
    }, { signal: controller.signal });
    const cancellationTimer = setTimeout(() => controller.abort(), 50);

    await expect(scan).rejects.toMatchObject({ code: "SCAN_CANCELLED" });
    clearTimeout(cancellationTimer);
    expect(getScannerRuntime()).toMatchObject({
      activeBrowsers: 0,
      activePreviews: 0,
      activeProxies: 0,
      activeScans: 0,
    });
  }, 45_000);

  it("caps browser requests, response bytes, and concurrent scans", () => {
    expect(scannerConfiguration.activeScans).toBe(2);
    expect(scannerConfiguration.queuedScans).toBe(4);
    expect(scannerConfiguration.limits.maxPageRequests).toBeLessThanOrEqual(100);
    expect(scannerConfiguration.limits.maxResponseBytes).toBeLessThan(5_000_000);
    expect(scannerConfiguration.timeoutMs).toBeLessThanOrEqual(45_000);
    expect(scannerConfiguration.tags.A).not.toContain("wcag22a");
    expect(scannerConfiguration.tags.AA).toContain("wcag22aa");
    expect(scannerConfiguration.tags.AAA).not.toContain("wcag22aaa");
  });
});
