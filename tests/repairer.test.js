import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { closeModel, openFixture, runRepairPipeline } from "./testHelpers.js";
import { analyze, proposalNeedsAction } from "../src/core/detector.js";
import { detectProjectBlocks } from "../src/core/blockDetection.js";
import { applyRepair } from "../src/core/repairer.js";
import { WebIFC, createIfcApi, getContainedElements, getIdsOfType, getLine, openModel } from "../src/core/ifcModel.js";

function parentIds(model, storeyId) {
  const storey = getLine(model, storeyId, "Decomposes");
  return (storey?.Decomposes || [])
    .map((ref) => getLine(model, ref.value)?.RelatingObject?.value)
    .filter((id) => id != null)
    .sort((a, b) => a - b);
}

describe("hierarchy-preserving repair", () => {
  it("updates linked storey names without merging branches into the master building", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);
    const beforeBuildings = getIdsOfType(model, WebIFC.IFCBUILDING);
    const beforeStoreys = getIdsOfType(model, WebIFC.IFCBUILDINGSTOREY);

    // No per-site collisions in this fixture (4 separate single-storey
    // branches, each to a distinct master storey) -- every proposal stays
    // "rename", so applyRepair() itself must not touch the model at all.
    const { result, reloaded } = await runRepairPipeline(model, report);

    expect(result.storeysUpdated).toBe(4);
    expect(result.elementsAffected).toBe(16);
    expect(result.elementsMoved).toBe(0);
    expect(result.mergeChanges).toHaveLength(0);
    expect(result.removedEntities).toHaveLength(0);
    expect(getIdsOfType(model, WebIFC.IFCBUILDING)).toEqual(beforeBuildings);
    expect(getIdsOfType(model, WebIFC.IFCBUILDINGSTOREY)).toEqual(beforeStoreys);
    closeModel(model);

    for (const change of result.changes) {
      expect(getLine(reloaded, change.sourceStoreyId).Name.value).toBe(change.toStoreyName);
      expect(parentIds(reloaded, change.sourceStoreyId)).toEqual(change.sourceParentIds);
      expect(getContainedElements(reloaded, change.sourceStoreyId)).toEqual(change.containedElementIds);
    }

    closeModel(reloaded);
  });

  it("preserves source storey and product GUIDs, placements, elevations and containment", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);
    const { result, reloaded } = await runRepairPipeline(model, report);
    closeModel(model);

    for (const change of result.changes) {
      const storey = getLine(reloaded, change.sourceStoreyId);
      expect(storey.GlobalId.value).toBe(change.sourceStoreyGuid);
      expect(storey.ObjectPlacement?.value ?? null).toBe(change.sourcePlacementRef);
      expect(storey.Elevation?.value ?? null).toBe(change.fromElevation);
      expect(getContainedElements(reloaded, change.sourceStoreyId)).toEqual(change.containedElementIds);
      for (const snapshot of change.elementSnapshots) {
        const element = getLine(reloaded, snapshot.id);
        expect(element.GlobalId.value).toBe(snapshot.guid);
        expect(element.ObjectPlacement?.value ?? null).toBe(snapshot.placementRef);
      }
    }

    closeModel(reloaded);
  });

  it("round-trips the preserved hierarchy and renamed storeys through SaveModel", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);
    const { result, reloaded } = await runRepairPipeline(model, report);
    closeModel(model);

    expect(getIdsOfType(reloaded, WebIFC.IFCBUILDING)).toHaveLength(5);
    expect(getIdsOfType(reloaded, WebIFC.IFCBUILDINGSTOREY)).toHaveLength(8);
    for (const change of result.changes) {
      const storey = getLine(reloaded, change.sourceStoreyId);
      expect(storey.Name.value).toBe(change.toStoreyName);
      expect(storey.GlobalId.value).toBe(change.sourceStoreyGuid);
      expect(getContainedElements(reloaded, change.sourceStoreyId)).toHaveLength(change.elementCount);
    }
    closeModel(reloaded);
  });

  it("ignores the legacy remove-empty option and always preserves linked branches", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);
    const result = applyRepair(model, report, { removeEmptyBranchesOpt: true });

    expect(result.removedEntities).toHaveLength(0);
    expect(getIdsOfType(model, WebIFC.IFCBUILDING)).toHaveLength(5);
    closeModel(model);
  });

  it("respects a storey selection", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);
    const first = report.proposals[0];
    const result = applyRepair(model, report, { selectedStoreyIds: new Set([first.sourceStoreyId]) });

    expect(result.storeysUpdated).toBe(1);
    expect(result.elementsAffected).toBe(4);
    expect(result.changes[0].sourceStoreyId).toBe(first.sourceStoreyId);
    closeModel(model);
  });

  it("re-running detection sees corrected names but keeps all linked branches", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const { reloaded } = await runRepairPipeline(model, analyze(model));
    closeModel(model);

    const report = analyze(reloaded);
    expect(report.buildingCount).toBe(5);
    expect(report.linkedBranches).toHaveLength(4);
    expect(report.repairNeeded).toBe(false);
    expect(report.alreadyCorrectStoreys).toBe(4);
    closeModel(reloaded);
  });

  it("is a no-op on an already-clean file", async () => {
    const model = await openFixture("clean_master_only.ifc");
    const result = applyRepair(model, analyze(model));
    expect(result.storeysUpdated).toBe(0);
    expect(result.elementsAffected).toBe(0);
    closeModel(model);
  });

  it("real 417-building/3-tower reference file: all eligible updates remain rename-only", async () => {
    const refPath = "C:\\Users\\ISS\\OneDrive\\Documents\\Corenet X\\Example IFC files from Consultants\\24183_bck_str_cg03_submission-(2).ifc";
    if (!fs.existsSync(refPath)) return; // machine-specific, skipped elsewhere

    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const blocks = detectProjectBlocks(model);
    expect(blocks.mode).toBe("MULTI_BLOCK");
    const report = analyze(model, { storeyMatchTolerance: 50, sourceName: "test", blocks });
    const actionable = report.proposals.filter(proposalNeedsAction);
    const selected = new Set(actionable.map((p) => p.sourceStoreyId));

    const result = applyRepair(model, report, { selectedStoreyIds: selected });
    expect(result.storeysUpdated).toBeGreaterThan(700);
    expect(result.renameChanges).toHaveLength(result.storeysUpdated);
    expect(result.mergeChanges).toEqual([]);
    expect(result.removedEntities).toEqual([]);
    closeModel(model);
  }, 120000);
});
