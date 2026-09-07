import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { compareBlockStoreys, detectProjectBlocks } from "../src/core/blockDetection.js";
import { createIfcApi, openModel } from "../src/core/ifcModel.js";

describe("detectProjectBlocks", () => {
  it("classifies a single building as SINGLE_BLOCK", async () => {
    const model = await openFixture("clean_master_only.ifc");
    const result = detectProjectBlocks(model);
    expect(result.mode).toBe("SINGLE_BLOCK");
    expect(result.blocks).toHaveLength(1);
    closeModel(model);
  });

  it("does not let small typical-unit buildings turn a single tower into MULTI_BLOCK", async () => {
    const model = await openFixture("single_block_typical_units.ifc");
    const result = detectProjectBlocks(model);
    expect(result.mode).toBe("SINGLE_BLOCK");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].name).toBe("Master Tower");
    expect(result.linkedBuildings.map((b) => b.name).sort()).toEqual(["Typical Unit A", "Typical Unit B"]);
    expect(result.unclassifiedBuildings).toHaveLength(1);
    expect(result.unclassifiedBuildings[0].name).toBe("Empty Shell");
    closeModel(model);
  });

  it("detects 3 towers and separates the podium into baseBuildings, not blocks", async () => {
    const model = await openFixture("multi_block_podium.ifc");
    const result = detectProjectBlocks(model);
    expect(result.mode).toBe("MULTI_BLOCK");
    expect(result.blocks.map((b) => b.name).sort()).toEqual(["Tower A", "Tower B", "Tower C"]);
    expect(result.baseBuildings).toHaveLength(1);
    expect(result.baseBuildings[0].name).toBe("Podium");
    expect(result.linkedBuildings.map((b) => b.name).sort()).toEqual(["Typical Unit A", "Typical Unit B"]);
    closeModel(model);
  });

  it("keeps a complete zero-product storey ladder as a block candidate", async () => {
    const source = fs
      .readFileSync(new URL("./fixtures/multi_block_podium.ifc", import.meta.url), "utf8")
      .replace(/^#2017=.*\r?\n/m, ""); // Tower B's only product is no longer spatially contained.
    const api = await createIfcApi();
    const model = openModel(api, Buffer.from(source));
    const result = detectProjectBlocks(model);

    expect(result.mode).toBe("MULTI_BLOCK");
    expect(result.blocks.map((b) => b.name).sort()).toEqual(["Tower A", "Tower B", "Tower C"]);
    expect(result.blocks.find((b) => b.name === "Tower B").elementCount).toBe(0);
    expect(result.unclassifiedBuildings.some((b) => b.name === "Tower B")).toBe(false);
    closeModel(model);
  });

  it("protects a Revit-native host that would otherwise look like a linked branch", async () => {
    const source = fs
      .readFileSync(new URL("./fixtures/multi_block_podium.ifc", import.meta.url), "utf8")
      .replace("1TYPICALAAAAAAAAAAAAB1", "1AAAAAAAAAAAAAAAAAAAB0");
    const api = await createIfcApi();
    const model = openModel(api, Buffer.from(source));
    const result = detectProjectBlocks(model);

    expect(result.mode).toBe("MULTI_BLOCK");
    expect(result.hostBuildings.map((building) => building.name)).toEqual(["Typical Unit A"]);
    expect(result.linkedBuildings.some((building) => building.name === "Typical Unit A")).toBe(false);
    closeModel(model);
  });

  it("returns UNKNOWN rather than guessing when block scores decline smoothly with no confident gap", async () => {
    const model = await openFixture("ambiguous_blocks.ifc");
    const result = detectProjectBlocks(model);
    expect(result.mode).toBe("UNKNOWN");
    closeModel(model);
  });

  it("does not modify the IFC while detecting blocks", async () => {
    const model = await openFixture("multi_block_podium.ifc");
    const before = JSON.stringify(model.deletedIds.size);
    detectProjectBlocks(model);
    expect(JSON.stringify(model.deletedIds.size)).toBe(before);
    expect(model.deletedIds.size).toBe(0);
    closeModel(model);
  });
});

describe("compareBlockStoreys", () => {
  it("Case 1: same normalized name + same resolved FFL across blocks -> PASS", async () => {
    const model = await openFixture("multi_block_podium.ifc");
    const blocks = detectProjectBlocks(model);
    const result = compareBlockStoreys(model, blocks.blocks);
    expect(result.pass).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    closeModel(model);
  });

  it("Case 2: same normalized name + different resolved FFL -> conflict", async () => {
    const model = await openFixture("multi_block_same_name_diff_ffl.ifc");
    const blocks = detectProjectBlocks(model);
    expect(blocks.mode).toBe("MULTI_BLOCK");
    const result = compareBlockStoreys(model, blocks.blocks);
    expect(result.pass).toBe(false);
    const names = result.conflicts.map((c) => c.normalizedName).sort();
    expect(names).toEqual(["05 storey", "06 storey"]);
    closeModel(model);
  });

  it("Case 3 + Case 7: different names (and different storey counts) across blocks -> PASS, never forced to match", async () => {
    const model = await openFixture("multi_block_diff_name_same_ffl.ifc");
    const blocks = detectProjectBlocks(model);
    expect(blocks.mode).toBe("MULTI_BLOCK");
    const result = compareBlockStoreys(model, blocks.blocks);
    expect(result.pass).toBe(true);
    closeModel(model);
  });

  it("Case 8/9: comparison uses resolved global Z, never the raw authored Elevation attribute", async () => {
    const model = await openFixture("multi_block_resolved_z.ifc");
    const blocks = detectProjectBlocks(model);
    expect(blocks.mode).toBe("MULTI_BLOCK");
    const result = compareBlockStoreys(model, blocks.blocks);
    expect(result.pass).toBe(false);
    // "X STOREY": same authored Elevation (5000/5000) but different resolved Z (5000 vs 7000) -> flagged.
    const xConflict = result.conflicts.find((c) => c.normalizedName === "x storey");
    expect(xConflict).toBeTruthy();
    // "Y STOREY": different authored Elevation (8000 vs 1234) but same resolved Z (8000/8000) -> not flagged.
    expect(result.conflicts.find((c) => c.normalizedName === "y storey")).toBeUndefined();
    // "Z STOREY" (identical in both) is untouched either way.
    expect(result.conflicts.find((c) => c.normalizedName === "z storey")).toBeUndefined();
    closeModel(model);
  });

  it("real reference file: 3 known towers, 1 known base, and clean storey coordination", async () => {
    const refPath =
      "C:\\Users\\ISS\\OneDrive\\Documents\\Corenet X\\Example IFC files from Consultants\\24183_bck_str_cg03_submission-(2).ifc";
    if (!fs.existsSync(refPath)) return; // machine-specific, skipped elsewhere

    const KNOWN_TOWER_GUIDS = ["1JV60H_kkRu437siSS0YFz", "1JNUhzL5ciEc1b3FXaTkJD", "2VttQrSTbWuFUsiW1aM5nw"];
    const KNOWN_BASE_GUID = "1UQuhPxOz6TemH7tqtk5TT";

    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const blocks = detectProjectBlocks(model);

    expect(blocks.mode).toBe("MULTI_BLOCK");
    expect(blocks.blocks).toHaveLength(3);
    for (const guid of KNOWN_TOWER_GUIDS) expect(blocks.blocks.some((b) => b.guid === guid)).toBe(true);
    expect(blocks.baseBuildings.some((b) => b.guid === KNOWN_BASE_GUID)).toBe(true);

    const comparison = compareBlockStoreys(model, blocks.blocks);
    expect(comparison.pass).toBe(true);
    closeModel(model);
  }, 20000);

  it("real single-tower reference file (Master File.ifc) classifies as SINGLE_BLOCK", async () => {
    const masterPath = "C:\\Users\\ISS\\OneDrive\\Documents\\Corenet X\\IfcBuildingStorey Linked File\\Test File\\Master File.ifc";
    if (!fs.existsSync(masterPath)) return; // machine-specific, skipped elsewhere

    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(masterPath));
    const result = detectProjectBlocks(model);
    expect(result.mode).toBe("SINGLE_BLOCK");
    closeModel(model);
  });

  it("real distinct-placement reference file: detects the populated and empty tower ladders as two blocks", async () => {
    const refPath = "C:\\Users\\ISS\\Downloads\\Multi Block Export.ifc";
    if (!fs.existsSync(refPath)) return;

    const EXPECTED = new Set(["2GpSE$G6cqQG$cxkhQKa9s", "255Ewxp09I0A7CFuDkrVw1"]);
    const api = await createIfcApi();
    const model = openModel(api, fs.readFileSync(refPath));
    const result = detectProjectBlocks(model);

    expect(result.mode).toBe("MULTI_BLOCK");
    expect(new Set(result.blocks.map((b) => b.guid))).toEqual(EXPECTED);
    expect(result.blocks.find((b) => b.guid === "255Ewxp09I0A7CFuDkrVw1").elementCount).toBe(0);
    expect(result.hostBuildings.map((building) => building.guid)).toEqual(["2zLkFg$5fCX9SSV3Lq4366"]);
    expect(result.linkedBuildings).toHaveLength(11);
    closeModel(model);
  });
});
