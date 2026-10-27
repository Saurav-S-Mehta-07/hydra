import { describe, expect, it } from "vitest";
import { buildAuditReport, renderAuditReportHtml } from "../src/reports/auditReport.js";

describe("print-friendly audit report", () => {
  it("includes scan evidence, score methodology, an executive summary, and print controls", () => {
    const audit = {
      id: "audit-123",
      projectName: "Sample project",
      sourceType: "html",
      createdAt: "2026-10-27T12:00:00.000Z",
      durationMs: 1250,
      wcagLevel: "AA",
      summary: {
        score: 82,
        violations: 1,
        violationNodes: 2,
        passes: 9,
        incomplete: 1,
        inapplicable: 3,
        scoreBreakdown: {
          failedFindingCount: 1,
          severityCounts: { serious: 1 },
          formula: "Weighted tested outcomes determine this indicator.",
          weights: { serious: 4 },
        },
      },
      violations: [{
        id: "image-alt",
        help: "Images must have alternative text",
        description: "Images must have alternative text.",
        impact: "serious",
        wcagCriteria: ["WCAG 2.1 A"],
        nodes: [{ selector: "#hero-image", html: '<img id="hero-image">', failureSummary: "Provide text." }],
      }],
      engine: { name: "Playwright + Chromium + axe-core", axeVersion: "4.10.3", tags: ["wcag21a"] },
      scanLimitations: ["Human review is required."],
    };

    const html = renderAuditReportHtml(buildAuditReport({ audit }));

    expect(html).toContain("Executive summary");
    expect(html).toContain("affecting 2 reported elements");
    expect(html).toContain("AccessZ score · not WCAG compliance");
    expect(html).toContain("Describe the image’s purpose in alt text.");
    expect(html).toContain("Weighted tested outcomes determine this indicator.");
    expect(html).toContain("Print or save as PDF");
    expect(html).toContain("@media print");
    expect(html).toContain("@page");
    expect(html).toContain("#hero-image");
    expect(html).toContain("Automated checks and scores do not establish legal compliance");
  });

  it("escapes untrusted project names, selectors, and source snippets", () => {
    const audit = {
      id: "audit-unsafe",
      projectName: '</h1><script>alert("x")</script>',
      sourceType: "html",
      createdAt: "2026-10-27T12:00:00.000Z",
      durationMs: 1,
      summary: { score: null, violations: 1, passes: 0, incomplete: 0, inapplicable: 0, scoreBreakdown: {} },
      violations: [{
        id: "unsafe-rule",
        help: "Unsafe content",
        description: "Check <script>alert(1)</script>",
        impact: "minor",
        wcagCriteria: [],
        nodes: [{ selector: "<script>", html: '<img src=x onerror="alert(1)">', failureSummary: "<script>bad</script>" }],
      }],
      engine: { name: "axe-core", tags: [] },
      scanLimitations: [],
    };

    const html = renderAuditReportHtml(buildAuditReport({ audit }));

    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
