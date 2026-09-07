import { describe, expect, it } from "vitest";
import { closeModel, openFixture, runRepairPipeline } from "./testHelpers.js";
import { analyze, selectRepairableProposals } from "../src/core/detector.js";
import { applyRepair, buildElementAudit, validateRepair } from "../src/core/repairer.js";
import { getLine } from "../src/core/ifcModel.js";

describe("buildElementAudit", () => {
  it("accounts for every element across updated, skipped, and unresolved proposals", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);
    // Explicitly leave one eligible group unselected to exercise skipped reporting.
    const selected = new Set(selectRepairableProposals(report).filter((p) => p.sourceBuildingName === "Unit High").map((p) => p.sourceStoreyId));
    const result = applyRepair(model, report, { selectedStoreyIds: selected });

    const audit = buildElementAudit(model, report, result);

    // Unit High (2, covered by storey update) + Unit Medium (2, deliberately
    // skipped above) + Unit Unmatched (2) + Unit Ambiguous (2).
    expect(audit).toHaveLength(8);

    const byAction = (action) => audit.filter((a) => a.action === action);
    expect(byAction("storey-metadata-updated")).toHaveLength(2);
    expect(byAction("skipped")).toHaveLength(2);
    expect(byAction("unresolved-unmatched")).toHaveLength(2);
    expect(byAction("unresolved-ambiguous")).toHaveLength(2);

    // every record has the identifying fields a report needs
    for (const record of audit) {
      expect(record.elementGuid).toBeTruthy();
      expect(record.elementType).toBeTruthy();
      expect(record.fromStoreyName).toBeTruthy();
      expect(record.confidence).toBeTruthy();
    }

    closeModel(model);
  });

  it("reports already-correct elements without editing their storey", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const initial = analyze(model);
    const candidate = initial.proposals.find((p) => p.sourceBuildingName === "Unit High");
    const storey = getLine(model, candidate.sourceStoreyId);
    storey.Name.value = "1st Storey";
    model.api.WriteLine(model.modelID, storey);

    const report = analyze(model);
    const correct = report.proposals.find((p) => p.sourceBuildingName === "Unit High");
    const result = applyRepair(model, report, { selectedStoreyIds: new Set() });
    const audit = buildElementAudit(model, report, result);
    const rows = audit.filter((a) => a.action === "already-correct");

    expect(result.storeysUpdated).toBe(0);
    expect(rows).toHaveLength(correct.elementCount);
    expect(rows.every((a) => a.nameMatchesMaster && a.fflMatchesMaster)).toBe(true);
    expect(rows.every((a) => a.toStoreyName === "1st Storey")).toBe(true);
    closeModel(model);
  });
});

describe("validateRepair", () => {
  it("reports checks as actually performed, and passing, on a real repair", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);
    const { result, reloaded } = await runRepairPipeline(model, report);
    closeModel(model);

    const checks = validateRepair(reloaded, result);
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      expect(c.performed).toBe(true);
      expect(c.passed).toBe(true);
      expect(typeof c.detail).toBe("string");
    }

    closeModel(reloaded);
  });

  it("catches a genuinely broken repair rather than reporting false confidence", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);
    const { result, reloaded } = await runRepairPipeline(model, report);
    closeModel(model);

    // Tamper with the expected linked-storey placement to simulate a repair
    // that changed geometry metadata -- the check must catch it.
    result.renameChanges[0].sourcePlacementRef = -999;

    const checks = validateRepair(reloaded, result);
    const identityCheck = checks.find((c) => c.name === "Linked storey renames preserve hierarchy");
    expect(identityCheck.passed).toBe(false);

    closeModel(reloaded);
  });
});
