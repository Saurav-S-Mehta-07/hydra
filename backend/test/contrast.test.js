import { describe, expect, it } from "vitest";
import { calculateContrast, parseCssColor, relativeLuminance } from "../src/contrast.js";

describe("CSS contrast calculations", () => {
  it("uses the WCAG relative luminance and contrast ratio formula", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000")).toBe(0);
    expect(calculateContrast("#000", "#fff").ratio).toBe(21);
  });

  it("applies normal and large-text contrast thresholds", () => {
    expect(calculateContrast("#777", "#fff", 16).requiredRatio).toBe(4.5);
    expect(calculateContrast("#777", "#fff", 16).passes).toBe(false);
    expect(calculateContrast("#777", "#fff", 24).requiredRatio).toBe(3);
    expect(calculateContrast("#777", "#fff", 24).passes).toBe(true);
    expect(calculateContrast("#777", "#fff", 18.66, true).passes).toBe(true);
  });

  it("parses supported hex, rgb, hsl-like-independent named and percentage RGB formats", () => {
    expect(parseCssColor("#1234")).toEqual({ red: 17, green: 34, blue: 51, alpha: 68 / 255 });
    expect(parseCssColor("rgb(100% 0% 0%)")).toEqual({ red: 255, green: 0, blue: 0, alpha: 1 });
    expect(parseCssColor("rgba(10, 20, 30, 0.5)").alpha).toBe(0.5);
    expect(parseCssColor("rebeccapurple")).toEqual({ red: 102, green: 51, blue: 153, alpha: 1 });
  });

  it("marks transparent and complex CSS colors for human review", () => {
    expect(calculateContrast("currentColor", "#fff").status).toBe("needs_review");
    expect(calculateContrast("#000", "linear-gradient(red, blue)").status).toBe("needs_review");
    expect(calculateContrast("rgba(0,0,0,.5)", "#fff").status).toBe("needs_review");
  });
});
