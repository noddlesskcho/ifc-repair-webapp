import { describe, expect, it } from "vitest";
import { closeModel, openFixture } from "./testHelpers.js";
import { analyze } from "../src/core/detector.js";
import { applyRepair } from "../src/core/repairer.js";

describe("applyRepair progress callback", () => {
  it("reports monotonically increasing processed/total for the update stage", async () => {
    const model = await openFixture("linked_branches_defect.ifc"); // 4 proposals, 4 elements each
    const report = analyze(model);

    const updateEvents = [];
    applyRepair(model, report, {
      onProgress: (p) => {
        if (p.stage === "update") updateEvents.push(p);
      },
    });

    expect(updateEvents).toHaveLength(4);
    expect(updateEvents.every((e) => e.total === 4)).toBe(true);
    expect(updateEvents.map((e) => e.processed)).toEqual([1, 2, 3, 4]);
    expect(updateEvents.every((e) => typeof e.detail === "string" && e.detail.length > 0)).toBe(true);

    closeModel(model);
  });

  it("never calls onProgress when there is nothing to update", async () => {
    const model = await openFixture("clean_master_only.ifc");
    const report = analyze(model);

    const events = [];
    applyRepair(model, report, { onProgress: (p) => events.push(p) });

    expect(events).toHaveLength(0);
    closeModel(model);
  });
});
