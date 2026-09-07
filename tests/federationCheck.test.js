import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { detectFederatedExportStructure } from "../src/core/federationCheck.js";
import { WebIFC, createIfcApi, getIdsOfType, getLine, openModel } from "../src/core/ifcModel.js";

// tests/fixtures/federated_same_project.ifc: 1 IfcProject -> 3 IfcSite, each
// with exactly one direct IfcBuilding child ("Same IFCProject" Revit export
// pattern). tests/fixtures/federated_extra_sites.ifc: 1 IfcProject -> 1
// relevant IfcSite hosting 2 buildings, plus 2 unrelated, building-less
// IfcSite entities also decomposing the project directly ("Same IFCSite"
// pattern, deliberately polluted with irrelevant sites to prove the
// detector isn't fooled by raw site count).

describe("detectFederatedExportStructure", () => {
  it("classifies one project -> one site -> multiple buildings as SAME_IFCSITE", async () => {
    const model = await openFixture("linked_branches_defect.ifc"); // 1 site, 5 buildings
    const result = detectFederatedExportStructure(model);

    expect(result.mode).toBe("SAME_IFCSITE");
    expect(result.projectCount).toBe(1);
    expect(result.buildingCount).toBe(5);
    expect(result.relevantSiteCount).toBe(1);
    expect(result.siteBuildingMap).toHaveLength(1);
    expect(result.siteBuildingMap[0].buildingIds).toHaveLength(5);

    closeModel(model);
  });

  it("classifies one project -> multiple sites -> one building each as SAME_IFCPROJECT", async () => {
    const model = await openFixture("federated_same_project.ifc");
    const result = detectFederatedExportStructure(model);

    expect(result.mode).toBe("SAME_IFCPROJECT");
    expect(result.projectCount).toBe(1);
    expect(result.siteCount).toBe(3);
    expect(result.buildingCount).toBe(3);
    expect(result.relevantSiteCount).toBe(3);
    expect(result.siteBuildingMap).toHaveLength(3);
    for (const entry of result.siteBuildingMap) expect(entry.buildingIds).toHaveLength(1);

    closeModel(model);
  });

  it("does not misclassify a file with only one building as federated", async () => {
    const model = await openFixture("clean_master_only.ifc"); // 1 building total
    const result = detectFederatedExportStructure(model);

    expect(result.mode).toBe("SAME_IFCSITE");
    expect(result.buildingCount).toBe(1);

    closeModel(model);
  });

  it("ignores unrelated, building-less sites and does not classify based on raw site count", async () => {
    const model = await openFixture("federated_extra_sites.ifc"); // 3 sites total, only 1 hosts buildings
    const result = detectFederatedExportStructure(model);

    expect(result.mode).toBe("SAME_IFCSITE");
    expect(result.siteCount).toBe(3); // raw count is high...
    expect(result.relevantSiteCount).toBe(1); // ...but only one site actually parents a building
    expect(result.siteBuildingMap).toHaveLength(1);
    expect(result.siteBuildingMap[0].buildingIds).toHaveLength(2);

    closeModel(model);
  });

  it("returns UNKNOWN rather than crashing when a building's IfcRelAggregates is missing/unusual", async () => {
    // Start from a normal federated file, then sever every IfcSite -> IfcBuilding
    // IfcRelAggregates (so no building's direct parent can be resolved to a
    // site at all), simulating a malformed/unusual hierarchy.
    const model = await openFixture("federated_same_project.ifc");
    for (const relId of getIdsOfType(model, WebIFC.IFCRELAGGREGATES)) {
      const rel = getLine(model, relId);
      const relatingType = rel?.RelatingObject?.value != null ? getLine(model, rel.RelatingObject.value)?.type : null;
      if (relatingType === WebIFC.IFCSITE) {
        model.api.DeleteLine(model.modelID, relId);
        model.deletedIds.add(relId);
      }
    }

    const result = detectFederatedExportStructure(model);
    expect(result.mode).toBe("UNKNOWN");
    expect(result.unresolvedBuildingCount).toBe(3);
    expect(() => detectFederatedExportStructure(model)).not.toThrow();

    closeModel(model);
  });

  it("does not modify the IFC while detecting SAME_IFCPROJECT", async () => {
    const model = await openFixture("federated_same_project.ifc");
    const beforeBuildings = getIdsOfType(model, WebIFC.IFCBUILDING);
    const beforeSites = getIdsOfType(model, WebIFC.IFCSITE);

    detectFederatedExportStructure(model);

    expect(getIdsOfType(model, WebIFC.IFCBUILDING)).toEqual(beforeBuildings);
    expect(getIdsOfType(model, WebIFC.IFCSITE)).toEqual(beforeSites);
    closeModel(model);
  });

  it("real UPL.ifc file: each linked building under its own distinct site classifies as SAME_IFCPROJECT", async () => {
    const uplPath = "C:\\Users\\ISS\\Downloads\\main-development\\UPL.ifc";
    if (!fs.existsSync(uplPath)) return; // machine-specific, skipped elsewhere
    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(uplPath));
    const result = detectFederatedExportStructure(model);
    expect(result.mode).toBe("SAME_IFCPROJECT");
    expect(result.projectCount).toBe(1);
    expect(result.buildingCount).toBeGreaterThan(1);
    expect(result.relevantSiteCount).toBe(result.buildingCount); // one distinct site per building in this file
    closeModel(model);
  });
});
