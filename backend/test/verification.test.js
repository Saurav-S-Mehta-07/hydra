import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareAudits, createVerificationRecord, freezeSnapshot } from "../src/verification/engine.js";
import { buildAuditReport, renderAuditReportHtml } from "../src/reports/auditReport.js";

function audit({ violations = [], incomplete = [], score = 80 } = {}) {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "completed",
    sourceType: "html",
    projectName: "Example",
    wcagLevel: "AA",
    includeBestPractices: true,
    engine: { name: "Playwright + Chromium + axe-core", axeVersion: "4.x", tags: ["wcag21aa"] },
    durationMs: 20,
    summary: { score, violations: violations.length, incomplete: incomplete.length, passes: 1, inapplicable: 0 },
    violations,
    incomplete,
    passes: [],
    inapplicable: [],
  };
}

function rule(id, selector, failureSummary = "Fix this issue") {
  return {
    id,
    impact: "serious",
    wcagCriteria: ["4.1.2"],
    description: "Accessible name",
    help: "Provide a name",
    helpUrl: "https://example.test/rule",
    nodes: [{ selector, targets: [selector], html: "<input>", failureSummary }],
  };
}

describe("verification comparison", () => {
  it("resolves a baseline finding only after a successful follow-up scan", () => {
    const baseline = audit({ violations: [rule("label", "#name")] });
    const followUp = audit({ violations: [], score: 100 });
    const record = createVerificationRecord({ baseline, followUp, scope: "controlled_html_snapshot" });

    expect(record.status).toBe("verified");
    expect(record.comparison.resolved).toHaveLength(1);
    expect(record.finalScore).toBe(100);
    expect(record.scoreDifference).toBe(20);
  });

  it("keeps unchanged issues open and identifies introduced issues as regressions", () => {
    const baseline = audit({ violations: [rule("label", "#name")] });
    const followUp = audit({ violations: [rule("label", "#name"), rule("image-alt", "#logo")], score: 50 });
    const comparison = compareAudits(baseline, followUp);

    expect(comparison.remaining).toHaveLength(1);
    expect(comparison.newlyIntroduced).toHaveLength(1);
    expect(comparison.regressions[0].ruleId).toBe("image-alt");
  });

  it("classifies changed failure details separately and incomplete checks as manual review", () => {
    const baseline = audit({ violations: [rule("label", "#name")] });
    const followUp = audit({
      violations: [rule("label", "#name", "A different failure remains")],
      incomplete: [{ id: "color-contrast", help: "Review contrast", nodes: [{ selector: "#copy", targets: ["#copy"], html: "<p>copy</p>", failureSummary: "Cannot determine background" }] }],
    });
    const comparison = compareAudits(baseline, followUp);
    const record = createVerificationRecord({ baseline, followUp, scope: "controlled_html_snapshot" });

    expect(comparison.changed).toHaveLength(1);
    expect(comparison.manualReview).toHaveLength(1);
    expect(record.status).toBe("needs_review");
  });

  it("can verify the selected repair while unrelated baseline findings remain open", () => {
    const baseline = audit({
      violations: [rule("label", "#name"), rule("image-alt", "#logo")],
    });
    const followUp = audit({ violations: [rule("image-alt", "#logo")], score: 90 });
    const repair = { violationId: "label", selector: "#name" };
    const record = createVerificationRecord({ baseline, followUp, repair, scope: "controlled_html_snapshot" });

    expect(record.status).toBe("verified");
    expect(record.comparison.resolved).toHaveLength(1);
    expect(record.comparison.remaining).toHaveLength(1);
  });

  it("never updates the final score on a failed scan and preserves immutable snapshots", () => {
    const baseline = audit({ violations: [rule("label", "#name")] });
    const snapshot = freezeSnapshot(baseline);
    const record = createVerificationRecord({
      baseline: snapshot,
      scanError: { code: "SCAN_TIMEOUT", message: "Timed out." },
      scope: "controlled_html_snapshot",
    });

    expect(record.status).toBe("failed");
    expect(record.finalScore).toBeNull();
    expect(record.scoreDifference).toBeNull();
    expect(Object.isFrozen(snapshot.violations[0].nodes[0])).toBe(true);
  });

  it("labels live URL rescans as environmental rather than verified repairs", () => {
    const baseline = audit({ violations: [rule("label", "#name")] });
    const followUp = audit({ violations: [], score: 100 });
    const record = createVerificationRecord({
      baseline,
      followUp,
      scope: "live_url_rescan",
      environmentalChange: true,
    });

    expect(record.status).toBe("environmental_change");
    expect(record.scoreDifference).toBe(20);
  });

  it("renders escaped report content and retains underlying repair and verification records", () => {
    const sourceAudit = audit({ violations: [rule("label", "#name", "<script>alert(1)</script>")] });
    const report = buildAuditReport({
      audit: sourceAudit,
      repairs: [{ id: "repair-1", violationId: "label", status: "verified", originalCode: "<input>", proposedCode: "<input aria-label=&quot;Name&quot;>", explanation: "Add a name" }],
      verifications: [{
        id: "verification-1",
        status: "verified",
        scope: "controlled_html_snapshot",
        baselineScore: 80,
        finalScore: 100,
        scoreDifference: 20,
        comparison: {
          resolved: [],
          remaining: [],
          newlyIntroduced: [{ ruleId: "image-alt", selector: "#image", failureSummary: "Provide text", html: "<img>" }],
          changed: [],
          manualReview: [],
          counts: { resolved: 0, remaining: 0, newlyIntroduced: 1, manualReview: 0 },
        },
      }],
    });
    const html = renderAuditReportHtml(report);

    expect(report.audit.id).toBe(sourceAudit.id);
    expect(report.repairs[0].id).toBe("repair-1");
    expect(report.verifications[0].finalScore).toBe(100);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("New regressions (1)");
    expect(html).toContain("&lt;img&gt;");
  });
});
