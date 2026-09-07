import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { buildTowerAssignments } from "../src/core/towerAssignment.js";
import { detectProjectBlocks } from "../src/core/blockDetection.js";
import { createIfcApi, openModel } from "../src/core/ifcModel.js";

describe("buildTowerAssignments", () => {
  it("assigns a linked model to the tower it is physically near, never the tower it merely shares an elevation with", async () => {
    // Tower A has '03 STOREY' at 14425mm; Tower B has '04 STOREY' at the
    // SAME 14425mm elevation, 100m away. A linked model physically placed
    // right next to Tower B must be assigned to Tower B -- the exact unsafe
    // case this whole engine change exists to prevent.
    const model = await openFixture("multi_block_regression_wrong_tower.ifc");
    const blockResult = detectProjectBlocks(model);
    expect(blockResult.mode).toBe("MULTI_BLOCK");

    const towerB = blockResult.blocks.find((b) => b.name === "Tower B");
    const linked = blockResult.linkedBuildings.find((b) => b.name === "Linked Model Near B");
    expect(towerB).toBeTruthy();
    expect(linked).toBeTruthy();

    const { assignments, warnings } = buildTowerAssignments(model, blockResult);
    const assignment = assignments.get(linked.id);
    expect(assignment.blockGuid).toBe(towerB.guid);
    expect(assignment.method).toBe("placement-fallback");
    expect(assignment.confident).toBe(false);
    expect(warnings.some((warning) => warning.includes("no readable product geometry"))).toBe(true);
    closeModel(model);
  });

  it("every candidate building (linked + unclassified) always receives an assignment -- never withheld", async () => {
    const model = await openFixture("multi_block_podium.ifc");
    const blockResult = detectProjectBlocks(model);
    expect(blockResult.mode).toBe("MULTI_BLOCK");

    const { towerGroups, assignments } = buildTowerAssignments(model, blockResult);
    const candidateCount = blockResult.linkedBuildings.length + blockResult.unclassifiedBuildings.length;
    expect(assignments.size).toBe(candidateCount);
    const totalAssigned = towerGroups.reduce((sum, g) => sum + g.linkedBuildingIds.length, 0);
    expect(totalAssigned).toBe(candidateCount);
    for (const [, a] of assignments) {
      expect(towerGroups.some((g) => g.block.guid === a.blockGuid)).toBe(true);
    }
    closeModel(model);
  });

  it("uses a unique repeated placement stack when a valid tower master has no product geometry", async () => {
    const source = fs
      .readFileSync(new URL("./fixtures/multi_block_podium.ifc", import.meta.url), "utf8")
      .replace(/^#2017=.*\r?\n/m, "")
      .replace("#5001=IFCCARTESIANPOINT((5000.,5000.,0.));", "#5001=IFCCARTESIANPOINT((30000.,0.,0.));")
      .replace("#6001=IFCCARTESIANPOINT((10000.,5000.,0.));", "#6001=IFCCARTESIANPOINT((30000.,0.,3000.));");
    const api = await createIfcApi();
    const model = openModel(api, Buffer.from(source));
    const blockResult = detectProjectBlocks(model);
    const towerB = blockResult.blocks.find((b) => b.name === "Tower B");
    const linked = blockResult.linkedBuildings.filter((b) => b.name.startsWith("Typical Unit"));
    const { assignments } = buildTowerAssignments(model, blockResult);

    expect(towerB.elementCount).toBe(0);
    expect(linked).toHaveLength(2);
    for (const building of linked) {
      const assignment = assignments.get(building.id);
      expect(assignment.blockGuid).toBe(towerB.guid);
      expect(assignment.method).toBe("placement-stack");
      expect(assignment.confident).toBe(true);
    }
    closeModel(model);
  });

  it("does not modify the IFC while building assignments", async () => {
    const model = await openFixture("multi_block_regression_wrong_tower.ifc");
    const blockResult = detectProjectBlocks(model);
    const before = model.deletedIds.size;
    buildTowerAssignments(model, blockResult);
    expect(model.deletedIds.size).toBe(before);
    closeModel(model);
  });

  it("caches the geometry pass for repeated detection on the same opened model", async () => {
    const model = await openFixture("multi_block_regression_wrong_tower.ifc");
    const blockResult = detectProjectBlocks(model);
    const streamAllMeshes = model.api.StreamAllMeshes.bind(model.api);
    let streamCount = 0;
    model.api.StreamAllMeshes = (...args) => {
      streamCount++;
      return streamAllMeshes(...args);
    };

    buildTowerAssignments(model, blockResult);
    buildTowerAssignments(model, detectProjectBlocks(model));

    expect(streamCount).toBe(1);
    closeModel(model);
  });

  it("real reference file: every linked building resolves to one of the 3 known towers", async () => {
    const refPath = "C:\\Users\\ISS\\OneDrive\\Documents\\Corenet X\\Example IFC files from Consultants\\24183_bck_str_cg03_submission-(2).ifc";
    if (!fs.existsSync(refPath)) return; // machine-specific, skipped elsewhere

    const KNOWN_TOWER_GUIDS = new Set(["1JV60H_kkRu437siSS0YFz", "1JNUhzL5ciEc1b3FXaTkJD", "2VttQrSTbWuFUsiW1aM5nw"]);

    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const blockResult = detectProjectBlocks(model);
    expect(blockResult.mode).toBe("MULTI_BLOCK");

    const { assignments } = buildTowerAssignments(model, blockResult);
    expect(assignments.size).toBe(blockResult.linkedBuildings.length + blockResult.unclassifiedBuildings.length);
    for (const [, a] of assignments) {
      expect(KNOWN_TOWER_GUIDS.has(a.blockGuid)).toBe(true);
    }
    closeModel(model);
  }, 15000);

  // Regression for the real repaired-file failure: both building placements
  // and product placement origins can disagree with the products' rendered
  // mesh positions. Ground truth below comes from the actual transformed mesh
  // footprint and matches what an IFC viewer displays in plan.
  it("real reference file: linked branches resolve to the tower containing their actual mesh footprint", async () => {
    const refPath = "C:\\Users\\ISS\\OneDrive\\Documents\\Corenet X\\Example IFC files from Consultants\\24183_bck_str_cg03_submission-(2).ifc";
    if (!fs.existsSync(refPath)) return; // machine-specific, skipped elsewhere

    // buildingGuid -> geometry-footprint tower guid.
    const EXPECTED = {
      "22$ZZvhUmHC1VTaNVFiHQI": "2VttQrSTbWuFUsiW1aM5nw",
      "2AojY$WgvZqqwmvSCgl203": "2VttQrSTbWuFUsiW1aM5nw",
      "2$jhrsDgzHJNhu93pIi8Mi": "1JV60H_kkRu437siSS0YFz",
      "1GmOjsheKsUHOuTx_MtICZ": "2VttQrSTbWuFUsiW1aM5nw",
    };

    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const blockResult = detectProjectBlocks(model);
    const { assignments } = buildTowerAssignments(model, blockResult);

    const candidates = [...blockResult.linkedBuildings, ...blockResult.unclassifiedBuildings];
    for (const [buildingGuid, expectedTowerGuid] of Object.entries(EXPECTED)) {
      const building = candidates.find((b) => b.guid === buildingGuid);
      expect(building, `building ${buildingGuid} not found among candidates`).toBeTruthy();
      const assignment = assignments.get(building.id);
      expect(assignment.blockGuid, `building ${buildingGuid}`).toBe(expectedTowerGuid);
      expect(assignment.method).toBe("geometry-footprint");
      expect(assignment.confident).toBe(true);
    }
    closeModel(model);
  }, 15000);

  it("real reference file: vertically repeated mesh footprints never change tower because of elevation", async () => {
    const refPath = "C:\\Users\\ISS\\OneDrive\\Documents\\Corenet X\\Example IFC files from Consultants\\24183_bck_str_cg03_submission-(2).ifc";
    if (!fs.existsSync(refPath)) return; // machine-specific, skipped elsewhere

    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const blockResult = detectProjectBlocks(model);
    const { assignments } = buildTowerAssignments(model, blockResult);

    const candidates = [...blockResult.linkedBuildings, ...blockResult.unclassifiedBuildings];
    const stacks = [
      ["0PIATwR4vBC5yqXCNEtU0M", "1bC1qL4BxLoI4jFiVUKRB2", "1JV60H_kkRu437siSS0YFz"],
      ["1SmubRHRlD9XsZGKpbnjrH", "3bDPBUhthSLvnmpReiZLJM", "1JNUhzL5ciEc1b3FXaTkJD"],
    ];
    for (const [lowerGuid, upperGuid, expectedTowerGuid] of stacks) {
      const lower = candidates.find((b) => b.guid === lowerGuid);
      const upper = candidates.find((b) => b.guid === upperGuid);
      expect(lower).toBeTruthy();
      expect(upper).toBeTruthy();
      expect(assignments.get(lower.id).blockGuid).toBe(expectedTowerGuid);
      expect(assignments.get(upper.id).blockGuid).toBe(expectedTowerGuid);
    }
    closeModel(model);
  }, 15000);

  it("real distinct-placement reference file: assigns both vertical stacks to their correct block", async () => {
    const refPath = "C:\\Users\\ISS\\Downloads\\Multi Block Export.ifc";
    if (!fs.existsSync(refPath)) return;

    const BLOCK_A = "2GpSE$G6cqQG$cxkhQKa9s";
    const BLOCK_B = "255Ewxp09I0A7CFuDkrVw1";
    const A_BRANCHES = new Set(["1QTWXF8WOshV8CYLES_fVB", "3GrA9SbsTTuqTQpgVW7vbF", "1Oi$d7JL53JMzV4VFThWYJ", "1rjuFUeiHsAR7oc9275wk1"]);
    const B_BRANCHES = new Set(["1u$Ytfoss_4v4hrQebbVOu", "2U63VV72C9R4Ypn$2$aBgp", "0VM4snCQYL47ZV4Rl8QaDC", "1kexj5GgNW0NobgizX7KS$", "3tvNjlZv62WOBefwKJooab", "1rDloBwcRRL2QmXdS5doju", "1pBsv$ayHW2x7NaEzyX$8i"]);
    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const blockResult = detectProjectBlocks(model);
    const { assignments } = buildTowerAssignments(model, blockResult);
    const candidates = [...blockResult.linkedBuildings, ...blockResult.unclassifiedBuildings];

    for (const building of candidates) {
      if (!A_BRANCHES.has(building.guid) && !B_BRANCHES.has(building.guid)) continue;
      const assignment = assignments.get(building.id);
      expect(assignment.blockGuid).toBe(A_BRANCHES.has(building.guid) ? BLOCK_A : BLOCK_B);
      expect(assignment.method).toBe("placement-stack");
      expect(assignment.confident).toBe(true);
    }
    closeModel(model);
  });
});
