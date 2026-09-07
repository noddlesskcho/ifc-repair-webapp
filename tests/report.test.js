import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { analyze, selectRepairableProposals } from "../src/core/detector.js";
import { applyRepair, buildElementAudit, validateRepair } from "../src/core/repairer.js";
import { buildReportData, renderCsvReport, renderPdfReport } from "../src/core/report.js";
import { getLine } from "../src/core/ifcModel.js";

const META = {
  sourceName: "classification_scenarios.ifc",
  schema: "IFC4",
  tolerance: 50,
  generatedAt: "2026-01-01T00:00:00.000Z",
  appVersion: "test",
};

async function repairedData(skipInterval = false) {
  const model = await openFixture("classification_scenarios.ifc");
  const report = analyze(model);
  const selected = new Set(selectRepairableProposals(report).filter((p) => !skipInterval || p.matchingMethod !== "interval").map((p) => p.sourceStoreyId));
  const result = applyRepair(model, report, { selectedStoreyIds: selected });
  const audit = buildElementAudit(model, report, result);
  const validation = validateRepair(model, result);
  const data = buildReportData({ report, result, audit, validation, meta: META });
  closeModel(model);
  return data;
}

describe("buildReportData", () => {
  it("PDF/CSV counts agree with each other and with the underlying repair result", async () => {
    const data = await repairedData(); // Unit High + Unit Medium repaired; Unmatched/Ambiguous unresolved

    expect(data.counts.branches).toEqual({ detected: 4, repaired: 2, alreadyCorrect: 0, skipped: 0, unresolved: 2, removed: 0 });
    expect(data.counts.elements).toEqual({ detected: 8, repaired: 4, alreadyCorrect: 0, skipped: 0, unresolved: 4 });

    // the appendix (source for both the PDF appendix and the CSV) must add
    // up to exactly the detected element count, with no element double
    // counted or dropped
    expect(data.audit).toHaveLength(data.counts.elements.detected);

    const csv = renderCsvReport(data);
    const dataLines = csv.trim().split("\r\n").slice(1); // drop header
    expect(dataLines).toHaveLength(data.audit.length);
  });

  it("shows skipped branches distinctly from unresolved ones", async () => {
    const data = await repairedData(true); // explicitly skip an eligible interval group

    expect(data.counts.branches).toEqual({ detected: 4, repaired: 1, alreadyCorrect: 0, skipped: 1, unresolved: 2, removed: 0 });
    expect(data.mapping.find((m) => m.branch.includes("Unit Medium")).outcome).toBe("Skipped");
    expect(data.mapping.find((m) => m.branch.includes("Unit Unmatched")).outcome).toBe("Unresolved");
  });

  it("never claims a validation check passed that was not actually run", async () => {
    const data = await repairedData();
    for (const check of data.validation) {
      expect(check.performed).toBe(true);
    }
  });

  it("reports that rename-only repair preserves containers and containment", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);
    const result = applyRepair(model, report, { selectedStoreyIds: new Set() });
    const data = buildReportData({ report, result, audit: [], validation: [], meta: META });

    expect(data.removedContainers).toEqual([]);
    expect(data.containmentReassignments).toBe(0);
    closeModel(model);
  });

  it("produces a valid, non-empty multipage PDF", async () => {
    const data = await repairedData();
    const bytes = renderPdfReport(data);
    const header = new TextDecoder().decode(new Uint8Array(bytes).slice(0, 8));
    expect(header).toContain("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("includes same-name/same-FFL linked storeys as already correct in both reports", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const initial = analyze(model);
    const candidate = initial.proposals.find((p) => p.sourceBuildingName === "Unit High");
    const storey = getLine(model, candidate.sourceStoreyId);
    storey.Name.value = "1st Storey";
    model.api.WriteLine(model.modelID, storey);

    const report = analyze(model);
    const result = applyRepair(model, report, { selectedStoreyIds: new Set() });
    const audit = buildElementAudit(model, report, result);
    const data = buildReportData({ report, result, audit, validation: validateRepair(model, result), meta: META });

    expect(data.counts.branches.alreadyCorrect).toBe(1);
    expect(data.counts.elements.alreadyCorrect).toBe(2);
    const mapping = data.mapping.find((m) => m.branch.includes("Unit High"));
    expect(mapping).toMatchObject({ nameMatchesMaster: true, fflMatchesMaster: true, outcome: "Already correct" });
    const csv = renderCsvReport(data);
    expect(csv).toContain("storey_name_match,storey_ffl_match,ffl_difference_mm");
    expect(csv).toContain("Already correct (unchanged)");
    expect(renderPdfReport(data).byteLength).toBeGreaterThan(1000);
    closeModel(model);
  });
});
