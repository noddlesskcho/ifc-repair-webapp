import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { analyze, proposalNeedsAction, selectRepairableProposals } from "../src/core/detector.js";
import { detectProjectBlocks } from "../src/core/blockDetection.js";
import { createIfcApi, getLine, openModel } from "../src/core/ifcModel.js";

describe("detector", () => {
  it("clean file needs no repair", async () => {
    const model = await openFixture("clean_master_only.ifc");
    const report = analyze(model);

    expect(report.buildingCount).toBe(1);
    expect(report.masterBuildingName).toBe("Master Building");
    expect(report.masterStoreys).toHaveLength(5);
    expect(report.linkedBranches).toHaveLength(0);
    expect(report.repairNeeded).toBe(false);
    expect(report.totalElementsToMove).toBe(0);

    closeModel(model);
  });

  it("linked file detects branches and maps by elevation, not by name", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const report = analyze(model);

    expect(report.buildingCount).toBe(5); // 1 master + 4 linked
    expect(report.masterBuildingName).toBe("Master Building");
    expect(report.masterStoreys).toHaveLength(4);
    expect(report.linkedBranches).toHaveLength(4);
    expect(report.repairNeeded).toBe(true);
    expect(report.totalElementsToMove).toBe(4 * 4); // fixture uses 4 elements/branch

    const zToMasterName = new Map(report.masterStoreys.map((s) => [s.absoluteZ, s.name]));
    const seenTargets = new Set();
    for (const p of report.proposals) {
      expect(proposalNeedsAction(p)).toBe(true);
      expect(p.status).toBe("high");
      expect(p.targetStoreyName).toBe(zToMasterName.get(p.sourceAbsoluteZ));
      seenTargets.add(p.targetStoreyId);
    }
    expect(seenTargets.size).toBe(4); // each master storey received exactly one branch

    closeModel(model);
  });

  it("reports a linked storey with the same master name and FFL as already correct", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const before = analyze(model);
    const candidate = before.proposals.find((p) => p.sourceBuildingName === "Unit High");
    const line = getLine(model, candidate.sourceStoreyId);
    line.Name.value = "  1ST   STOREY ";
    model.api.WriteLine(model.modelID, line);

    const report = analyze(model);
    const correct = report.proposals.find((p) => p.sourceBuildingName === "Unit High");
    expect(correct.nameMatchesMaster).toBe(true);
    expect(correct.fflMatchesMaster).toBe(true);
    expect(correct.fflDifferenceMm).toBe(30);
    expect(correct.alreadyCorrect).toBe(true);
    expect(proposalNeedsAction(correct)).toBe(false);
    expect(selectRepairableProposals(report)).not.toContain(correct);
    expect(report.alreadyCorrectStoreys).toBe(1);
    expect(report.alreadyCorrectElements).toBe(2);
    expect(report.totalElementsToMove).toBe(2);

    closeModel(model);
  });

  it("does not edit a linked storey whose name is already correct even when its source placement is inside the storey interval", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const before = analyze(model);
    const candidate = before.proposals.find((p) => p.sourceBuildingName === "Unit Medium");
    const line = getLine(model, candidate.sourceStoreyId);
    line.Name.value = candidate.targetStoreyName;
    model.api.WriteLine(model.modelID, line);

    const report = analyze(model);
    const correct = report.proposals.find((p) => p.sourceBuildingName === "Unit Medium");
    expect(correct.nameMatchesMaster).toBe(true);
    expect(correct.fflMatchesMaster).toBe(false);
    expect(correct.alreadyCorrect).toBe(true);
    expect(proposalNeedsAction(correct)).toBe(false);
    closeModel(model);
  });
});

describe("detector -- MULTI_BLOCK mode", () => {
  it("reports cross-block storey-name conflicts without blocking physical analysis", async () => {
    const model = await openFixture("multi_block_same_name_diff_ffl.ifc");
    const blockResult = detectProjectBlocks(model);
    const report = analyze(model, { blocks: blockResult });

    expect(blockResult.mode).toBe("MULTI_BLOCK");
    expect(report.blocksMode).toBe("MULTI_BLOCK");
    expect(report.storeyNameComparison.pass).toBe(false);
    expect(report.storeyNameComparison.conflicts.length).toBeGreaterThan(0);
    expect(report.warnings.some((warning) => warning.includes("reused at different FFLs across blocks"))).toBe(true);
    expect(report.towerGroups).toHaveLength(blockResult.blocks.length);
    closeModel(model);
  });

  it("never proposes renaming a storey to another tower's name just because they share an elevation", async () => {
    const model = await openFixture("multi_block_regression_wrong_tower.ifc");
    const blockResult = detectProjectBlocks(model);
    expect(blockResult.mode).toBe("MULTI_BLOCK");

    const report = analyze(model, { blocks: blockResult });
    expect(report.blocksMode).toBe("MULTI_BLOCK");
    expect(report.towerGroups).toHaveLength(2);

    const proposal = report.proposals.find((p) => p.sourceBuildingName === "Linked Model Near B");
    expect(proposal.targetStoreyName).toBe("04 STOREY");
    expect(proposal.sourceBlockLabel).toBe("Tower B");
    closeModel(model);
  });

  it("scopes each tower's own master storeys and never lets one tower's storey count leak into another's", async () => {
    const model = await openFixture("multi_block_regression_wrong_tower.ifc");
    const blockResult = detectProjectBlocks(model);
    const report = analyze(model, { blocks: blockResult });

    for (const group of report.towerGroups) {
      expect(group.masterStoreys).toHaveLength(5);
    }
    // Master storey ids belonging to Tower A must never be a proposal's target when the proposal's source block is Tower B, or vice versa.
    const ownerOf = new Map();
    for (const g of report.towerGroups) for (const s of g.masterStoreys) ownerOf.set(s.id, g.blockGuid);
    for (const p of report.proposals) {
      if (p.targetStoreyId == null) continue;
      expect(ownerOf.get(p.targetStoreyId)).toBe(p.sourceBlockGuid);
    }
    closeModel(model);
  });

  it("allows equal target names in separate linked buildings to merge into the shared block storey", async () => {
    const model = await openFixture("multi_block_podium.ifc");
    const blockResult = detectProjectBlocks(model);
    expect(blockResult.mode).toBe("MULTI_BLOCK");
    const report = analyze(model, { blocks: blockResult });

    const towerA = report.proposals.filter((p) => p.elementCount > 0 && p.sourceBlockLabel === "Tower A");
    expect(towerA.length).toBeGreaterThan(1);
    expect(new Set(towerA.map((p) => p.sourceBuildingId)).size).toBeGreaterThan(1);
    for (const p of towerA) {
      expect(p.repairStrategy).toBe("merge");
      expect(p.sameParentCollision).toBe(false);
    }
    closeModel(model);
  });

  it("SINGLE_BLOCK behavior is completely unchanged when no blocks are passed", async () => {
    const model = await openFixture("linked_branches_defect.ifc");
    const withoutBlocks = analyze(model);
    expect(withoutBlocks.blocksMode).toBe("SINGLE_BLOCK");
    expect(withoutBlocks.towerGroups).toBeNull();
    expect(withoutBlocks.masterBuildingName).toBe("Master Building");
    closeModel(model);
  });

  it("uses the authoritative SINGLE_BLOCK preflight master instead of selecting a second master", async () => {
    const model = await openFixture("multi_block_podium.ifc");
    const detected = detectProjectBlocks(model);
    const towerB = detected.blocks.find((b) => b.name === "Tower B");
    const typicalB = detected.linkedBuildings.find((b) => b.name === "Typical Unit B");
    const supplied = {
      mode: "SINGLE_BLOCK",
      blocks: [towerB],
      baseBuildings: [],
      linkedBuildings: [typicalB],
      unclassifiedBuildings: [],
    };
    const report = analyze(model, { blocks: supplied });

    expect(report.masterBuildingGuid).toBe(towerB.guid);
    expect(report.linkedBranches.map((branch) => branch.buildingGuid)).toEqual([typicalB.guid]);
    closeModel(model);
  });

  it("never auto-selects a proposal whose tower assignment wasn't confident, even if the FFL match is -- until manually confirmed", async () => {
    const model = await openFixture("multi_block_podium.ifc");
    const blockResult = detectProjectBlocks(model);
    const report = analyze(model, { blocks: blockResult });

    const uncertain = report.proposals.find((p) => p.assignmentConfident === false && p.elementCount > 0);
    expect(uncertain).toBeTruthy();
    // A confident FFL match to the wrong tower's name is exactly the unsafe
    // case this gate exists for -- it must never be auto-applied on its own.
    let selected = new Set(selectRepairableProposals(report).map((p) => p.sourceStoreyId));
    expect(selected.has(uncertain.sourceStoreyId)).toBe(false);
    // ...but once the user has looked at the row and confirmed/changed its
    // target (a manual override), that IS the required confirmation.
    const confirmed = analyze(model, {
      blocks: blockResult,
      overrides: { [uncertain.sourceStoreyId]: uncertain.targetStoreyId },
    });
    selected = new Set(selectRepairableProposals(confirmed).map((p) => p.sourceStoreyId));
    expect(selected.has(uncertain.sourceStoreyId)).toBe(true);
    closeModel(model);
  });

  it("real distinct-placement reference file: proposes only the 11 correctly tower-scoped linked storeys", async () => {
    const refPath = "C:\\Users\\ISS\\Downloads\\Multi Block Export.ifc";
    if (!fs.existsSync(refPath)) return;

    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const blockResult = detectProjectBlocks(model);
    const report = analyze(model, { blocks: blockResult });
    const selected = selectRepairableProposals(report);

    expect(report.blocksMode).toBe("MULTI_BLOCK");
    expect(report.proposals).toHaveLength(11);
    expect(report.proposals.some((proposal) => proposal.sourceBuildingId === 27)).toBe(false);
    expect(selected).toHaveLength(11);
    expect(selected.reduce((sum, proposal) => sum + proposal.elementCount, 0)).toBe(99);
    expect(selected.filter((proposal) => proposal.sourceBlockGuid === "2GpSE$G6cqQG$cxkhQKa9s")).toHaveLength(4);
    expect(selected.filter((proposal) => proposal.sourceBlockGuid === "255Ewxp09I0A7CFuDkrVw1")).toHaveLength(7);
    closeModel(model);
  });
});
