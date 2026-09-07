import { describe, expect, it } from "vitest";
import { closeModel, openFixture, runRepairPipeline } from "./testHelpers.js";
import { DEFAULT_STOREY_MATCH_TOLERANCE, analyze, proposalNeedsAction } from "../src/core/detector.js";
import { applyRepair } from "../src/core/repairer.js";
import { getIdsOfType, getLine, WebIFC } from "../src/core/ifcModel.js";

// tests/fixtures/classification_scenarios.ifc: a master building (storeys at
// Z 0 / 3000 / 3020 / 6000 -- note 3000 and 3020 are only 20mm apart, on
// purpose) plus four single-storey linked branches. Under interval
// containment (see detector.js's file-header comment), against the default
// 150mm tolerance:
//   Unit High       Z=30    (30mm from Z=0, within tolerance)
//                     -> boundary-snap onto the Z=0 storey -> high
//   Unit Medium     Z=4500  (1480mm above 3rd Storey/Z=3020, 1500mm below
//                            4th Storey/Z=6000 -- comfortably inside that
//                            interval, nowhere near either boundary)
//                     -> interval containment onto 3rd Storey -> high
//                        (this is the UPL.ifc acceptance scenario in
//                        miniature: a large gap to the matched storey is
//                        fine when the source-storey reference is unambiguous)
//   Unit Unmatched  Z=9000  (3000mm above the topmost master storey, with
//                            no upper bound and outside tolerance)
//                     -> "above-highest" -> unmatched, never silently
//                        forced into the topmost storey
//   Unit Ambiguous  Z=3010  (10mm from BOTH 3000 and 3020, both within
//                            tolerance of each other)
//                     -> ambiguous-boundary -> ambiguous
//
// "Unit High"'s storey also carries a Pset_BuildingStoreyCommon (added via
// ifcopenshell, matching how real Revit exports attach one to nearly every
// IfcBuildingStorey/IfcBuilding) -- a regression fixture for a real bug
// found against an actual Revit export: hasOtherReferences() was treating
// that descriptive property set as "content that wasn't moved" and refusing
// to remove the otherwise-empty branch on every real-world file.
function byBuilding(report, name) {
  return report.proposals.find((p) => p.sourceBuildingName === name);
}

describe("match-status classification", () => {
  it("uses a 150mm default tolerance", () => {
    expect(DEFAULT_STOREY_MATCH_TOLERANCE).toBe(150);
  });

  it("snaps a near-boundary reference (within tolerance) onto that boundary as high confidence", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);
    const p = byBuilding(report, "Unit High");

    expect(p.status).toBe("high");
    expect(p.matchingMethod).toBe("boundary-snap");
    expect(p.toleranceUsed).toBe(true);
    expect(p.targetStoreyName).toBe("1st Storey");
    expect(p.intervalLowerZ).toBe(0);
    expect(proposalNeedsAction(p)).toBe(true);

    closeModel(model);
  });

  it("matches a linked storey deep inside an interval to its lower master storey as high confidence", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);
    const p = byBuilding(report, "Unit Medium"); // 4500mm: well inside 3rd Storey's [3020, 6000) interval

    expect(p.intervalStatus).toBe("matched");
    expect(p.matchingMethod).toBe("interval");
    expect(p.status).toBe("high");
    expect(p.targetStoreyName).toBe("3rd Storey");
    expect(p.intervalLowerZ).toBe(3020);
    expect(p.intervalUpperZ).toBe(6000);
    expect(p.toleranceUsed).toBe(false);
    expect(proposalNeedsAction(p)).toBe(true);

    closeModel(model);
  });

  it("classifies a far above-highest reference as unmatched with no target", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);
    const p = byBuilding(report, "Unit Unmatched");

    expect(p.status).toBe("unmatched");
    expect(p.intervalStatus).toBe("above-highest");
    expect(p.targetStoreyId).toBeNull();
    expect(p.intervalLowerZ).toBe(6000);
    expect(proposalNeedsAction(p)).toBe(false);
    expect(report.warnings.some((w) => w.includes("Unit Unmatched") && w.includes("above the highest"))).toBe(true);

    closeModel(model);
  });

  it("classifies a reference within tolerance of two master storeys as ambiguous with no target", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);
    const p = byBuilding(report, "Unit Ambiguous");

    expect(p.status).toBe("ambiguous");
    expect(p.intervalStatus).toBe("ambiguous-boundary");
    expect(p.targetStoreyId).toBeNull();
    expect(p.ambiguousCandidates).toHaveLength(2);
    expect(new Set(p.ambiguousCandidates.map((c) => c.storeyName))).toEqual(new Set(["2nd Storey", "3rd Storey"]));
    expect(proposalNeedsAction(p)).toBe(false);
    expect(report.warnings.some((w) => w.includes("Unit Ambiguous") && w.includes("within tolerance"))).toBe(true);

    closeModel(model);
  });

  it("a custom tolerance changes classification (e.g. narrowing it resolves an ambiguity into a clean interval match)", async () => {
    // Unit Ambiguous sits 10mm from both Z=3000 and Z=3020 -- ambiguous at
    // the default 50mm tolerance. Narrowing tolerance to 5mm takes both
    // boundaries out of range, so it falls through to plain interval
    // containment against the lower one instead.
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model, { storeyMatchTolerance: 5 });
    const p = byBuilding(report, "Unit Ambiguous");

    expect(p.intervalStatus).toBe("matched");
    expect(p.matchingMethod).toBe("interval");
    expect(p.status).toBe("high");
    expect(p.targetStoreyName).toBe("2nd Storey");
    expect(p.intervalUpperZ).toBe(3020);

    closeModel(model);
  });

  it("widening tolerance can turn a near-boundary interval match into a boundary snap", async () => {
    // Unit Medium (Z=4500) is 1480mm above 3rd Storey (Z=3020) -- an
    // ordinary interior interval match at the default 150mm tolerance.
    // Widening tolerance past that gap makes it snap onto 3rd Storey's own
    // boundary instead while remaining a trusted match.
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model, { storeyMatchTolerance: 1490 }); // > the 1480mm gap to 3rd Storey, but < the 1500mm gap to 4th Storey
    const p = byBuilding(report, "Unit Medium");

    expect(p.matchingMethod).toBe("boundary-snap");
    expect(p.toleranceUsed).toBe(true);
    expect(p.targetStoreyName).toBe("3rd Storey");

    closeModel(model);
  });
});

describe("repair only acts on eligible proposals", () => {
  it("never moves unmatched or ambiguous branches, even if force-selected", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);

    const unmatched = byBuilding(report, "Unit Unmatched");
    const ambiguous = byBuilding(report, "Unit Ambiguous");
    // A caller trying to force these in has no effect: proposalNeedsAction()
    // gates on a non-null target, which these structurally never have.
    const forced = new Set([unmatched.sourceStoreyId, ambiguous.sourceStoreyId]);

    const result = applyRepair(model, report, { selectedStoreyIds: forced });
    expect(result.storeysUpdated).toBe(0);

    closeModel(model);
  });

  it("updates selected storey names and reports skipped ones", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);

    const high = byBuilding(report, "Unit High");
    const medium = byBuilding(report, "Unit Medium");

    const result = applyRepair(model, report, { selectedStoreyIds: new Set([high.sourceStoreyId]) });
    expect(result.storeysUpdated).toBe(1);
    expect(result.elementsAffected).toBe(2);

    // "Unit Medium" needed action but wasn't selected -> shows up as skipped
    expect(result.skipped.some((p) => p.sourceStoreyId === medium.sourceStoreyId)).toBe(true);

    closeModel(model);
  });
});

describe("save/reload round trip preserves classification-driven repairs", () => {
  it("round-trips renamed storeys while every building branch remains", async () => {
    const model = await openFixture("classification_scenarios.ifc");
    const report = analyze(model);
    const high = byBuilding(report, "Unit High");
    const medium = byBuilding(report, "Unit Medium");

    const { reloaded } = await runRepairPipeline(model, report, {
      selectedStoreyIds: new Set([high.sourceStoreyId, medium.sourceStoreyId]),
    });
    closeModel(model);

    const buildings = getIdsOfType(reloaded, WebIFC.IFCBUILDING);
    expect(buildings).toHaveLength(5);
    expect(getLine(reloaded, high.sourceStoreyId).Name.value).toBe(high.targetStoreyName);
    expect(getLine(reloaded, medium.sourceStoreyId).Name.value).toBe(medium.targetStoreyName);
    closeModel(reloaded);
  });
});
