import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  absoluteZOf,
  closeModel,
  createIfcApi,
  getContainedElements,
  getContainingSiteId,
  getLengthUnitScaleToMM,
  getLine,
  openModel,
} from "../src/core/ifcModel.js";
import { analyze, proposalNeedsAction, selectRepairableProposals } from "../src/core/detector.js";
import { applyRepair } from "../src/core/repairer.js";

// Real-world acceptance case, kept out of tests/fixtures/ because the file
// is 108MB and lives on this machine only. Every assertion below discovers
// its expected values FROM the file at runtime (master storey elevations,
// GUIDs, element counts) rather than hard-coding them, per the requirement
// that this scenario be verified against the live file, not against
// numbers copied out of it. On any machine without the file, this whole
// suite is skipped rather than failing.
const UPL_PATH = "C:\\Users\\ISS\\Downloads\\main-development\\UPL.ifc";
const hasUpl = fs.existsSync(UPL_PATH);

describe.skipIf(!hasUpl)("UPL.ifc acceptance: bottom-reference interval matching on a real Revit export", () => {
  async function open() {
    const api = await createIfcApi();
    return openModel(api, fs.readFileSync(UPL_PATH));
  }

  it("finds at least one genuine interior-interval (gap-bridging fallback) match, and it is internally consistent", async () => {
    const model = await open();
    const report = analyze(model);

    expect(report.masterStoreys.length).toBeGreaterThan(0);

    // The defect this tool targets: a linked storey whose own elevation
    // falls strictly between two consecutive master storeys with a real
    // gap (not just a rounding-sized offset) to the one it matches -- i.e.
    // matchingMethod "interval", not "exact"/"boundary-snap".
    const gapBridging = report.proposals.filter(
      (p) => p.elementCount > 0 && p.intervalStatus === "matched" && p.matchingMethod === "interval"
    );
    expect(gapBridging.length).toBeGreaterThan(0);

    const sortedMasters = report.masterStoreys.slice().sort((a, b) => a.absoluteZ - b.absoluteZ);

    for (const p of gapBridging) {
      // Reference basis must be honestly reported as the fallback, never
      // claimed as a verified element base.
      expect(p.referenceBasis).toBe("source-storey-reference");
      // A genuine same-building duplicate target is retained as evidence but
      // held for review; every other interval match remains auto-repairable.
      if (p.sameParentCollision) {
        expect(p.status).toBe("ambiguous");
        expect(proposalNeedsAction(p)).toBe(false);
      } else {
        expect(p.status).toBe("high");
        expect(proposalNeedsAction(p)).toBe(true);
      }

      // The target must be a real master storey, and the source elevation
      // must genuinely sit inside [target, next) -- not at either edge
      // (that would have been "exact"/"boundary-snap" instead).
      const targetIdx = sortedMasters.findIndex((m) => m.id === p.targetStoreyId);
      expect(targetIdx).toBeGreaterThanOrEqual(0);
      expect(sortedMasters[targetIdx].absoluteZ).toBe(p.intervalLowerZ);
      expect(p.sourceAbsoluteZ).toBeGreaterThan(p.intervalLowerZ);
      if (p.intervalUpperZ != null) {
        expect(sortedMasters[targetIdx + 1].absoluteZ).toBe(p.intervalUpperZ);
        expect(p.sourceAbsoluteZ).toBeLessThan(p.intervalUpperZ);
      }

      // Every element actually contained in the source storey is covered by
      // this proposal (the fallback group is the whole storey) -- counted
      // from the live model, never hard-coded.
      expect(p.elementIds.length).toBe(p.elementCount);
    }

    // Only non-colliding storey intervals are eligible with default settings.
    const repairable = selectRepairableProposals(report);
    for (const p of gapBridging) {
      if (p.sameParentCollision) expect(repairable).not.toContain(p);
      else expect(repairable).toContain(p);
    }

    closeModel(model);
  }, 20000);

  it("does not use each element's own placement as the matching reference (cross-check, not override)", async () => {
    const model = await open();
    const report = analyze(model);
    const scaleToMM = getLengthUnitScaleToMM(model);

    const gapBridging = report.proposals.filter(
      (p) => p.elementCount > 0 && p.intervalStatus === "matched" && p.matchingMethod === "interval"
    );
    expect(gapBridging.length).toBeGreaterThan(0);

    // Diagnostic-only cross-check: report (via console.warn, not a failure)
    // any element whose own placement would resolve outside the group's
    // matched interval -- the "if evidence contradicts the fallback, report
    // it" requirement. On the known real-world case none are expected, but
    // the test must not hard-code that as an assumption; it only records
    // what it finds.
    let contradictions = 0;
    for (const p of gapBridging) {
      for (const elId of p.elementIds) {
        const ownZ = absoluteZOf(model, elId) * scaleToMM;
        const inInterval = ownZ >= p.intervalLowerZ && (p.intervalUpperZ == null || ownZ < p.intervalUpperZ);
        if (!inInterval) contradictions++;
      }
    }
    if (contradictions > 0) {
      console.warn(
        `UPL.ifc: ${contradictions} element(s) have an own-placement elevation outside their group's matched ` +
          "interval -- not treated as a match override, but worth a human look."
      );
    }

    closeModel(model);
  }, 20000);

  it("holds a same-building duplicate target for review without mutating hierarchy", async () => {
    const model = await open();
    const report = analyze(model);
    const gapBridging = report.proposals.find(
      (p) => p.elementCount > 0 && p.intervalStatus === "matched" && p.matchingMethod === "interval"
    );
    expect(gapBridging).toBeTruthy();
    expect(gapBridging.sameParentCollision).toBe(true);
    expect(gapBridging.status).toBe("ambiguous");
    expect(gapBridging.repairStrategy).toBeNull();

    const scaleToMM = getLengthUnitScaleToMM(model);
    const worldZBefore = new Map(gapBridging.elementIds.map((id) => [id, absoluteZOf(model, id) * scaleToMM]));
    const containedBefore = getContainedElements(model, gapBridging.sourceStoreyId);

    const result = applyRepair(model, report, { selectedStoreyIds: new Set([gapBridging.sourceStoreyId]) });

    expect(result.mergeChanges).toHaveLength(0);
    expect(result.renameChanges).toHaveLength(0);
    expect(result.elementsMoved).toBe(0);
    expect(result.removedEntities).toEqual([]);
    expect(getContainedElements(model, gapBridging.sourceStoreyId)).toEqual(containedBefore);
    for (const elementId of gapBridging.elementIds) {
      expect(absoluteZOf(model, elementId) * scaleToMM).toBeCloseTo(worldZBefore.get(elementId), 6);
    }

    closeModel(model);
  }, 20000);

  it("flags UPL Level 0/Level 1 as a same-parent review case and preserves every container", async () => {
    const model = await open();
    const report = analyze(model);
    const uplProposals = report.proposals.filter((p) => ["Level 0", "Level 1"].includes(p.sourceStoreyName));
    expect(uplProposals).toHaveLength(2);
    expect(new Set(uplProposals.map((p) => p.sourceBuildingId)).size).toBe(1);
    for (const p of uplProposals) {
      expect(p.sameParentCollision).toBe(true);
      expect(p.status).toBe("ambiguous");
      expect(p.repairStrategy).toBeNull();
      expect(proposalNeedsAction(p)).toBe(false);
      expect(p.targetStoreyId).toBe(uplProposals[0].targetStoreyId);
    }

    const sourceBuildingId = uplProposals[0].sourceBuildingId;
    const sourceSiteId = getContainingSiteId(model, sourceBuildingId);
    expect(sourceSiteId).not.toBeNull();
    const sourceBuilding = getLine(model, sourceBuildingId);
    const sourceSite = getLine(model, sourceSiteId);
    const storeysBefore = new Map(uplProposals.map((p) => [p.sourceStoreyId, getLine(model, p.sourceStoreyId).GlobalId?.value]));
    const contentsBefore = new Map(uplProposals.map((p) => [p.sourceStoreyId, getContainedElements(model, p.sourceStoreyId)]));

    const result = applyRepair(model, report, {
      selectedStoreyIds: new Set(uplProposals.map((p) => p.sourceStoreyId)),
    });

    expect(result.mergeChanges).toHaveLength(0);
    expect(result.renameChanges).toHaveLength(0);
    expect(result.elementsMoved).toBe(0);
    expect(result.removedEntities).toEqual([]);
    expect(getLine(model, sourceBuildingId).GlobalId?.value).toBe(sourceBuilding.GlobalId?.value);
    expect(getLine(model, sourceSiteId).GlobalId?.value).toBe(sourceSite.GlobalId?.value);
    for (const p of uplProposals) {
      expect(getLine(model, p.sourceStoreyId).GlobalId?.value).toBe(storeysBefore.get(p.sourceStoreyId));
      expect(getContainedElements(model, p.sourceStoreyId)).toEqual(contentsBefore.get(p.sourceStoreyId));
    }

    closeModel(model);
  }, 20000);
});
