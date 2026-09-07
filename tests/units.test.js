import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { analyze, proposalNeedsAction } from "../src/core/detector.js";
import { getLengthUnitScaleToMM } from "../src/core/ifcModel.js";

// tests/fixtures/metres_units.ifc: master storeys authored in METRES (not
// millimetres) at 0 / 3.6 / 7.2, plus one linked branch ("Linked Unit",
// storey "Base Level") also at 3.6 containing 2 elements. Elevations must be
// converted to a common unit (millimetres) via IfcUnitAssignment before
// interval matching -- comparing raw, unconverted values (0 / 3.6 / 7.2 vs.
// tolerance/interval math written in mm) would silently misclassify
// everything as either exact-zero or absurdly far apart.
describe("unit conversion", () => {
  it("resolves a metres-denominated file's length unit scale to 1000", async () => {
    const model = await openFixture("metres_units.ifc");
    expect(getLengthUnitScaleToMM(model)).toBe(1000);
    closeModel(model);
  });

  it("matches an exact boundary correctly once elevations are converted to a common unit", async () => {
    const model = await openFixture("metres_units.ifc");
    const report = analyze(model);

    expect(report.masterStoreys.map((s) => s.absoluteZ).sort((a, b) => a - b)).toEqual([0, 3600, 7200]);

    const branch = report.linkedBranches.find((b) => b.buildingName === "Linked Unit");
    expect(branch).toBeTruthy();

    const p = report.proposals.find((prop) => prop.sourceBuildingId === branch.buildingId);
    expect(p.sourceAbsoluteZ).toBe(3600); // 3.6m converted to mm, not the raw "3.6"
    expect(p.matchingMethod).toBe("exact");
    expect(p.status).toBe("high");
    expect(p.targetStoreyName).toBe("2nd Storey");
    expect(p.elementCount).toBe(2);
    expect(proposalNeedsAction(p)).toBe(true);

    closeModel(model);
  });
});
