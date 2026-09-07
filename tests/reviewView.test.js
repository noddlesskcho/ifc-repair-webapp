import { describe, it, expect } from "vitest";
import { filterProposals, HIGH_CONFIDENCE_FFL_MM, proposalCategory, renderMasterElevationTabs, renderMasterElevations, renderProposalTable } from "../src/core/reviewView.js";

function proposal(overrides) {
  return {
    status: "high",
    sourceBuildingId: 1,
    sourceSiteId: 100,
    sourceBlockId: null,
    sourceBlockGuid: null,
    sourceBlockLabel: null,
    assignmentConfident: null,
    sourceStoreyId: 0,
    sourceStoreyGuid: "Storey-0",
    sourceStoreyName: "<Level>",
    elementCount: 18,
    sourceAbsoluteZ: 15500,
    targetAbsoluteZ: 11500,
    targetStoreyId: 2,
    targetStoreyGuid: "Master-Storey-GUID",
    targetStoreyName: "1st Storey",
    nameMatchesMaster: false,
    fflMatchesMaster: false,
    fflDifferenceMm: 4000,
    alreadyCorrect: false,
    repairStrategy: "rename",
    manualOverride: false,
    overrideFarFromDetected: false,
    autoTargetStoreyName: null,
    explanation: "Reference within interval",
    ...overrides,
  };
}

const masterStoreys = Array.from({ length: 24 }, (_, id) => ({ id, name: `Long master storey ${id}`, absoluteZ: id * 3000 }));
const linkedBranches = [
  { buildingId: 1, buildingGuid: "Branch-GUID", buildingName: "Unit A", siteId: 100, siteGuid: "Site-GUID", siteName: "Site One" },
];

function makeReport(proposals, overrides = {}) {
  return { blocksMode: "SINGLE_BLOCK", towerGroups: null, masterBuildingGuid: "Master-Building-GUID", masterStoreys, linkedBranches, proposals, ...overrides };
}

describe("proposalCategory", () => {
  it("categorizes already-correct rows as matched", () => {
    expect(proposalCategory(proposal({ alreadyCorrect: true }))).toBe("matched");
  });

  it("categorizes unmatched targets (no targetStoreyId) as review", () => {
    expect(proposalCategory(proposal({ targetStoreyId: null, fflDifferenceMm: null }))).toBe("review");
  });

  it("categorizes a small FFL gap as matched, a large one as review, purely per-row", () => {
    expect(proposalCategory(proposal({ fflDifferenceMm: HIGH_CONFIDENCE_FFL_MM }))).toBe("matched");
    expect(proposalCategory(proposal({ fflDifferenceMm: HIGH_CONFIDENCE_FFL_MM + 1 }))).toBe("review");
  });
});

describe("filterProposals", () => {
  it("filters by building or storey name/GUID within each category", () => {
    const report = makeReport([
      proposal({ sourceStoreyId: 1, fflDifferenceMm: 10 }),
      proposal({ sourceStoreyId: 2, targetStoreyId: null, fflDifferenceMm: null, sourceStoreyGuid: "Storey-2" }),
    ]);
    expect(filterProposals(report, "matched", "branch-guid")).toHaveLength(1);
    expect(filterProposals(report, "matched", "unit a")).toHaveLength(1);
    expect(filterProposals(report, "review", "storey-2")).toHaveLength(1);
    expect(filterProposals(report, "matched", "storey-2")).toHaveLength(0);
  });
});

describe("renderMasterElevations", () => {
  it("keeps full master level names and FFLs for a single-block report", () => {
    const html = renderMasterElevations(makeReport([]));
    expect(html.match(/<li>/g)).toHaveLength(24);
    expect(html).toContain("Long master storey 23");
    expect(html).toContain("FFL 69,000 mm");
  });

  it("shows only the active tower's list (not all towers stacked) for a MULTI_BLOCK report, defaulting to the first", () => {
    const towerGroups = [
      { blockId: 10, blockGuid: "Tower-A-GUID", blockLabel: "Tower A", masterStoreys: masterStoreys.slice(0, 3) },
      { blockId: 20, blockGuid: "Tower-B-GUID", blockLabel: "Tower B", masterStoreys: masterStoreys.slice(0, 2) },
    ];
    const report = makeReport([], { blocksMode: "MULTI_BLOCK", towerGroups });

    const defaultHtml = renderMasterElevations(report);
    expect(defaultHtml).toContain("Tower A");
    expect(defaultHtml).toContain("Tower-A-GUID");
    expect(defaultHtml).not.toContain("Tower B");

    const selectedHtml = renderMasterElevations(report, "Tower-B-GUID");
    expect(selectedHtml).toContain("Tower B");
    expect(selectedHtml).toContain("Tower-B-GUID");
    expect(selectedHtml).not.toContain("Tower A");
  });

  it("renders no tab strip for a single-block report or a lone tower, but one tab per tower once there are 2+", () => {
    expect(renderMasterElevationTabs(makeReport([]))).toBe("");

    const oneTower = [{ blockId: 10, blockGuid: "Tower-A-GUID", blockLabel: "Tower A", masterStoreys: masterStoreys.slice(0, 3) }];
    expect(renderMasterElevationTabs(makeReport([], { blocksMode: "MULTI_BLOCK", towerGroups: oneTower }))).toBe("");

    const towerGroups = [
      { blockId: 10, blockGuid: "Tower-A-GUID", blockLabel: "Tower A", masterStoreys: masterStoreys.slice(0, 3) },
      { blockId: 20, blockGuid: "Tower-B-GUID", blockLabel: "Tower B", masterStoreys: masterStoreys.slice(0, 2) },
    ];
    const report = makeReport([], { blocksMode: "MULTI_BLOCK", towerGroups });
    const tabs = renderMasterElevationTabs(report);
    expect(tabs).toContain("Tower A");
    expect(tabs).toContain("Tower B");
    expect(tabs.match(/<button/g)).toHaveLength(2);

    const activeTab = renderMasterElevationTabs(report, "Tower-B-GUID");
    expect(activeTab).toContain('data-block-guid="Tower-B-GUID" role="tab" aria-selected="true"');
    expect(activeTab).toContain('data-block-guid="Tower-A-GUID" role="tab" aria-selected="false"');
  });
});

describe("renderProposalTable", () => {
  it("groups rows by IfcBuilding (collapsed by default), shows elements count and description, and skips the target storey GUID", () => {
    const report = makeReport([proposal({ sourceStoreyId: 1, fflDifferenceMm: 4000 })]);
    const html = renderProposalTable(report, "review", "");

    expect(html).toContain("Unit A");
    expect(html).toContain("Branch-GUID");
    expect(html).toContain("&lt;Level&gt;");
    expect(html).toContain(">18<"); // elements count cell
    expect(html).not.toContain("Master-Storey-GUID"); // no target storey GUID column in the table
    expect(html).not.toContain("Storey-0");
    expect(html).toContain('<details class="building-group" data-building-id="1">'); // collapsed by default, no `open`
  });

  it("shows a matched row as read-only text with a small Change button, not an open dropdown", () => {
    const report = makeReport([proposal({ sourceStoreyId: 1, fflDifferenceMm: 10 })]);
    const html = renderProposalTable(report, "matched", "");
    expect(html).toContain("target-prefill");
    expect(html).toContain("row-change-button");
    expect(html).toContain('data-source-storey-id="1"');
  });

  it("shows an editable, pre-selected target dropdown directly for a needs-review row", () => {
    const report = makeReport([proposal({ sourceStoreyId: 1, fflDifferenceMm: 4000 })]);
    const html = renderProposalTable(report, "review", "");
    expect(html).toContain('data-source-storey-id="1"');
    expect(html).toMatch(/<option value="2"[^>]*selected[^>]*>/);
    expect(html).not.toContain("row-change-button");
  });

  it("marks an already-correct row read-only and visually de-emphasized", () => {
    const report = makeReport([proposal({ sourceStoreyId: 1, alreadyCorrect: true })]);
    const html = renderProposalTable(report, "matched", "");
    expect(html).toContain("row-no-change");
    expect(html).toContain("target-readonly");
  });

  it("does not show a strategy badge (removed), and still shows a far-from-detected warning on a manual override", () => {
    const report = makeReport([
      proposal({
        sourceStoreyId: 1,
        fflDifferenceMm: 10,
        repairStrategy: "merge",
        manualOverride: true,
        overrideFarFromDetected: true,
        autoTargetStoreyName: "1st Storey",
      }),
    ]);
    const html = renderProposalTable(report, "matched", "");
    expect(html).not.toContain("strategy-badge");
    expect(html).toContain("row-far-warning");
    expect(html).toContain("far from the automatically detected match");
  });

  it("shows same-parent collisions as review-required rows", () => {
    const report = makeReport([proposal({ sourceStoreyId: 1, sameParentCollision: true, status: "ambiguous", repairStrategy: null })]);
    const html = renderProposalTable(report, "review", "");
    expect(html).toContain("Review required");
    expect(html).not.toContain("Will merge into");
  });

  it("groups override options by tower with optgroups in a MULTI_BLOCK report", () => {
    const towerGroups = [
      { blockId: 10, blockGuid: "Tower-A-GUID", blockLabel: "Tower A", masterStoreys: [masterStoreys[0], masterStoreys[1]] },
      { blockId: 20, blockGuid: "Tower-B-GUID", blockLabel: "Tower B", masterStoreys: [masterStoreys[2]] },
    ];
    const report = makeReport(
      [proposal({ sourceStoreyId: 1, fflDifferenceMm: 4000, sourceBlockId: 10, sourceBlockGuid: "Tower-A-GUID", sourceBlockLabel: "Tower A" })],
      { blocksMode: "MULTI_BLOCK", towerGroups }
    );
    const html = renderProposalTable(report, "review", "");
    expect(html).toContain("<optgroup");
    expect(html).toContain("Tower A");
    expect(html).toContain("Tower B");
  });

  it("shows an uncertain-assignment badge for a low-confidence multi-block building", () => {
    const branches = [{ ...linkedBranches[0], blockId: 10, blockGuid: "Tower-A-GUID", blockLabel: "Tower A", assignmentConfident: false }];
    const report = makeReport(
      [proposal({ sourceStoreyId: 1, fflDifferenceMm: 4000, sourceBlockId: 10, sourceBlockGuid: "Tower-A-GUID", sourceBlockLabel: "Tower A" })],
      { blocksMode: "MULTI_BLOCK", towerGroups: [{ blockId: 10, blockGuid: "Tower-A-GUID", blockLabel: "Tower A", masterStoreys }], linkedBranches: branches }
    );
    const html = renderProposalTable(report, "review", "");
    expect(html).toContain("assignment-uncertain");
    expect(html).toContain("Best guess: Tower A");
  });

  it("sorts rows within a building group by the requested column", () => {
    const report = makeReport([
      proposal({ sourceStoreyId: 1, sourceStoreyName: "B Level", elementCount: 5, fflDifferenceMm: 10 }),
      proposal({ sourceStoreyId: 2, sourceStoreyName: "A Level", elementCount: 50, fflDifferenceMm: 10 }),
    ]);
    const byElementsAsc = renderProposalTable(report, "matched", "", { key: "elements", dir: 1 });
    expect(byElementsAsc.indexOf("B Level")).toBeLessThan(byElementsAsc.indexOf("A Level"));
    const byElementsDesc = renderProposalTable(report, "matched", "", { key: "elements", dir: -1 });
    expect(byElementsDesc.indexOf("A Level")).toBeLessThan(byElementsDesc.indexOf("B Level"));
  });

  it("shows an empty-state message when nothing matches the current tab/filter", () => {
    const report = makeReport([proposal({ sourceStoreyId: 1, fflDifferenceMm: 10 })]);
    expect(renderProposalTable(report, "matched", "nope")).toContain("No matches for the current filter.");
    expect(renderProposalTable(report, "review", "")).toContain("Nothing in this tab.");
  });

  it("filters by the Match column (yes/no) independently of the text search", () => {
    const report = makeReport([
      proposal({ sourceStoreyId: 1, sourceStoreyName: "Matches", fflDifferenceMm: 10, fflMatchesMaster: true }),
      proposal({ sourceStoreyId: 2, sourceStoreyName: "Off by a bit", fflDifferenceMm: 800, fflMatchesMaster: false }),
    ]);

    const yesOnly = renderProposalTable(report, "matched", "", null, "yes");
    expect(yesOnly).toContain(">Matches<");
    expect(yesOnly).not.toContain("Off by a bit");

    const noOnly = renderProposalTable(report, "matched", "", null, "no");
    expect(noOnly).not.toContain(">Matches<");
    expect(noOnly).toContain("Off by a bit");

    const all = renderProposalTable(report, "matched", "", null, null);
    expect(all).toContain(">Matches<");
    expect(all).toContain("Off by a bit");
  });
});
