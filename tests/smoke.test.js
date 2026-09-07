import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { analyze } from "../src/core/detector.js";

describe("smoke", () => {
  it("opens a fixture and analyzes it", async () => {
    const model = await openFixture("clean_master_only.ifc");
    const report = analyze(model, { sourceName: "clean_master_only.ifc" });
    expect(report.buildingCount).toBe(1);
    closeModel(model);
  });
});
