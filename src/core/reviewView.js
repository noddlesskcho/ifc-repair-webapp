const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const formatElevation = (z) => (Number.isFinite(z) ? `${z.toLocaleString("en-GB", { maximumFractionDigits: 2 })} mm` : "Unavailable");
const branchMapCache = new WeakMap();

function branchesById(report) {
  let branches = branchMapCache.get(report);
  if (!branches) {
    branches = new Map(report.linkedBranches.map((branch) => [branch.buildingId, branch]));
    branchMapCache.set(report, branches);
  }
  return branches;
}

/** A row's proposed level is shown as read-only text with a small "Change" button below this FFL gap -- above it, an editable dropdown is shown directly since the match already needs a closer look. */
export const HIGH_CONFIDENCE_FFL_MM = 1000;

/**
 * Two buckets only: "matched" (already correct, or a confident FFL match)
 * vs. "review" (no target at all, a large FFL gap, or -- on a MULTI_BLOCK
 * file -- an unconfirmed tower assignment). That last case is deliberate: a
 * confident FFL match to the right *name* means nothing if the guess about
 * *which tower* it belongs to was wrong, so it must surface here rather than
 * hide inside "Matched" behind a small badge (see detector.js's
 * selectRepairableProposals, which excludes these from automatic repair for
 * the same reason -- a manual override lifts both). These drive the two
 * clickable summary chips in step 2 -- no separate tab strip anymore.
 */
export function proposalCategory(p) {
  if (p.alreadyCorrect) return "matched";
  if (p.sameParentCollision || p.status === "ambiguous" || p.status === "unmatched") return "review";
  if (p.targetStoreyId == null) return "review";
  if (p.assignmentConfident === false && !p.manualOverride) return "review";
  return p.fflDifferenceMm != null && p.fflDifferenceMm <= HIGH_CONFIDENCE_FFL_MM ? "matched" : "review";
}

export function filterProposals(report, category, query) {
  const needle = query.trim().toLowerCase();
  const branches = branchesById(report);
  return report.proposals.filter((p) => {
    if (p.elementCount === 0 || proposalCategory(p) !== category) return false;
    if (!needle) return true;
    const branch = branches.get(p.sourceBuildingId);
    return [branch?.buildingGuid, branch?.siteGuid, branch?.blockGuid, branch?.buildingName, branch?.siteName, p.sourceStoreyGuid, p.sourceStoreyName]
      .some((v) => v?.toLowerCase().includes(needle));
  });
}

function renderOneElevationList(storeys) {
  return `<ol class="master-levels">${storeys.slice().sort((a, b) => b.absoluteZ - a.absoluteZ).map((s) =>
    `<li><strong>${escape(s.name)}</strong><span class="level-rule" aria-hidden="true"></span><span>FFL ${escape(formatElevation(s.absoluteZ))}</span></li>`).join("")}</ol>`;
}

/**
 * One elevation list for single-block. For multi-block, shows only ONE
 * tower's list at a time -- `activeBlockGuid` selects which (defaulting to
 * the first tower when unset/not found) -- paired with
 * renderMasterElevationTabs() below so the caller can switch between towers
 * instead of scrolling through all of them stacked in one long list.
 */
export function renderMasterElevations(report, activeBlockGuid = null) {
  if (report.blocksMode === "MULTI_BLOCK") {
    const groups = report.towerGroups || [];
    const active = groups.find((g) => g.blockGuid === activeBlockGuid) ?? groups[0];
    if (!active) return "";
    return `<div class="tower-elevation-group">
      <h4 class="tower-elevation-title">${escape(active.blockLabel)} <span class="group-sub">&middot; ${escape(active.blockGuid)}</span></h4>
      ${renderOneElevationList(active.masterStoreys)}
    </div>`;
  }
  return renderOneElevationList(report.masterStoreys);
}

/** Tab strip for switching which tower's master elevation list renderMasterElevations() shows. Empty string when there's nothing to switch between. */
export function renderMasterElevationTabs(report, activeBlockGuid = null) {
  const groups = report.towerGroups;
  if (report.blocksMode !== "MULTI_BLOCK" || !groups || groups.length < 2) return "";
  const active = groups.find((g) => g.blockGuid === activeBlockGuid) ?? groups[0];
  return `<div class="elevation-tower-tabs" role="tablist">${groups
    .map(
      (g) =>
        `<button type="button" class="elevation-tower-tab${g.blockGuid === active.blockGuid ? " active" : ""}" ` +
        `data-block-guid="${escape(g.blockGuid)}" role="tab" aria-selected="${g.blockGuid === active.blockGuid}">${escape(g.blockLabel)}</button>`
    )
    .join("")}</div>`;
}

function yesNo(value) {
  if (value == null) return `<span class="yn yn-na">N/A</span>`;
  return value ? `<span class="yn yn-yes">Yes</span>` : `<span class="yn yn-no">No</span>`;
}

/** Groups options by tower/master building once there's more than one master to choose from, so it's clear which building each candidate level belongs to. */
function targetSelect(report, p) {
  const sorted = report.masterStoreys.slice().sort((a, b) => b.absoluteZ - a.absoluteZ);
  const option = (s) => `<option value="${s.id}" ${s.id === p.targetStoreyId ? "selected" : ""}>${escape(s.name)} (${escape(formatElevation(s.absoluteZ))})</option>`;
  const placeholder = p.targetStoreyId == null ? `<option value="" selected disabled>— Select a level —</option>` : "";

  let optionsHtml;
  if (report.blocksMode === "MULTI_BLOCK" && report.towerGroups?.length > 1) {
    const byId = new Map(sorted.map((s) => [s.id, s]));
    optionsHtml = report.towerGroups
      .map((g) => {
        const opts = g.masterStoreys
          .slice()
          .sort((a, b) => b.absoluteZ - a.absoluteZ)
          .filter((s) => byId.has(s.id))
          .map(option)
          .join("");
        return `<optgroup label="${escape(g.blockLabel)} (${escape(g.blockGuid)})">${opts}</optgroup>`;
      })
      .join("");
  } else {
    optionsHtml = sorted.map(option).join("");
  }

  return `<select class="proposed-level-select" data-source-storey-id="${p.sourceStoreyId}" aria-label="Proposed level for ${escape(p.sourceStoreyName)}">${placeholder}${optionsHtml}</select>`;
}

/** Short, plain-language line replacing the old verbose per-row explanation -- the full technical explanation still exists on the proposal for the PDF/CSV report. */
function shortDescription(report, p) {
  if (p.alreadyCorrect) return "Already correct -- no change needed.";
  if (p.sameParentCollision) return "Review required: multiple levels under this source building resolve to the same target level.";
  if (p.targetStoreyId == null) return "No confident match found -- please choose a level manually.";
  if (p.manualOverride) {
    return `Manually set to <strong>${escape(p.targetStoreyName)}</strong>.`;
  }
  const diff = p.fflDifferenceMm != null ? escape(formatElevation(p.fflDifferenceMm)) : "an unknown amount";
  if (p.fflDifferenceMm != null && p.fflDifferenceMm <= HIGH_CONFIDENCE_FFL_MM) {
    return `Matched to <strong>${escape(p.targetStoreyName)}</strong> -- within ${diff} of that level's FFL.`;
  }
  return `Matched to <strong>${escape(p.targetStoreyName)}</strong> -- ${diff} off that level's FFL. Please confirm.`;
}

function proposalRow(report, p) {
  const rowClasses = ["proposal-row"];
  if (p.alreadyCorrect) rowClasses.push("row-no-change");
  if (p.manualOverride) rowClasses.push("row-manual");
  if (p.overrideFarFromDetected) rowClasses.push("row-far-warning");

  const warningNote = p.overrideFarFromDetected
    ? `<p class="row-warning">⚠ This level is far from the automatically detected match${p.autoTargetStoreyName ? ` ('${escape(p.autoTargetStoreyName)}')` : ""} -- please confirm this is correct.</p>`
    : "";

  // High-confidence, not-yet-overridden matches read as plain text with a
  // small "Change" affordance rather than an always-open dropdown -- reduces
  // visual noise for the common case while keeping override one click away.
  const isHighConfidencePrefill = !p.alreadyCorrect && !p.manualOverride && proposalCategory(p) === "matched";
  const targetCell = p.alreadyCorrect
    ? `<span class="target-readonly">${escape(p.targetStoreyName)}</span>`
    : isHighConfidencePrefill
      ? `<span class="target-readonly target-prefill">${escape(p.targetStoreyName)}</span>
         <button type="button" class="row-change-button" data-source-storey-id="${p.sourceStoreyId}" title="Change the proposed level">Change</button>
         <div class="row-change-select" hidden>${targetSelect(report, p)}</div>`
      : targetSelect(report, p);

  return `<tr class="${rowClasses.join(" ")}" data-source-storey-id="${p.sourceStoreyId}">
    <td><strong>${escape(p.sourceStoreyName)}</strong><span class="cell-sub">Source FFL ${escape(formatElevation(p.sourceAbsoluteZ))}</span></td>
    <td class="cell-count">${p.elementCount}</td>
    <td>${targetCell}${warningNote}</td>
    <td>${yesNo(p.targetStoreyId == null ? null : p.fflMatchesMaster)}${p.fflDifferenceMm != null ? `<span class="cell-sub">${escape(formatElevation(p.fflDifferenceMm))} diff.</span>` : ""}</td>
    <td class="cell-description">${shortDescription(report, p)}</td>
  </tr>`;
}

/** Building-group header: name, GUID, and (multi-block) which tower it's assigned to and how confidently. */
function buildingGroupLabel(report, branch) {
  const parts = [`<strong>${escape(branch.buildingName)}</strong>`, `<span class="group-sub">${escape(branch.buildingGuid)}</span>`];
  if (report.blocksMode === "MULTI_BLOCK") {
    if (branch.assignmentConfident === false) {
      parts.push(`<span class="assignment-badge assignment-uncertain">Best guess: ${escape(branch.blockLabel)} -- please confirm</span>`);
    } else if (branch.blockLabel) {
      parts.push(`<span class="assignment-badge assignment-confident">${escape(branch.blockLabel)}</span>`);
    }
    if (branch.assignmentMethod === "placement-fallback") {
      parts.push(`<span class="assignment-badge assignment-uncertain">Placement fallback</span>`);
    }
  }
  return parts.join(" ");
}

const SORT_ACCESSORS = {
  level: (p) => p.sourceStoreyName?.toLowerCase() || "",
  elements: (p) => p.elementCount,
  proposed: (p) => p.targetStoreyName?.toLowerCase() || "",
};

function sortRows(rows, sortState) {
  if (!sortState?.key) {
    return rows.slice().sort((a, b) => b.sourceAbsoluteZ - a.sourceAbsoluteZ);
  }
  const accessor = SORT_ACCESSORS[sortState.key];
  const dir = sortState.dir === -1 ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function sortableHeader(label, key, sortState) {
  const active = sortState?.key === key;
  const arrow = active ? (sortState.dir === -1 ? " ▾" : " ▴") : "";
  return `<th scope="col" class="sortable-header${active ? " sort-active" : ""}" data-sort-key="${key}">${escape(label)}${arrow}</th>`;
}

/** null/undefined -> "N/A" (no target at all); otherwise the boolean fflMatchesMaster the "Match" cell already renders via yesNo(). */
function matchValueOf(p) {
  if (p.targetStoreyId == null) return null;
  return !!p.fflMatchesMaster;
}

/** Cycles All -> Yes -> No -> All on click, mirroring the sort headers' toggle-on-click style. */
function matchHeader(matchFilter) {
  const label = matchFilter === "yes" ? "Match: Yes ✕" : matchFilter === "no" ? "Match: No ✕" : "Match";
  const active = matchFilter === "yes" || matchFilter === "no";
  return `<th scope="col" class="sortable-header match-header${active ? " sort-active" : ""}" data-match-filter-toggle="1" title="Click to filter by match">${escape(label)}</th>`;
}

/**
 * Renders one tab's proposals as a table grouped into per-IfcBuilding
 * sections. `expandedBuildingIds` (a Set of building ids, or null/undefined
 * for "all collapsed") lets the caller preserve which sections were manually
 * expanded across a re-render (e.g. after a sort-header click) instead of
 * every section snapping shut every time this function's output replaces the
 * DOM.
 */
export function renderProposalTable(report, category, query, sortState = null, matchFilter = null, expandedBuildingIds = null) {
  let rows = filterProposals(report, category, query);
  if (matchFilter === "yes") rows = rows.filter((p) => matchValueOf(p) === true);
  else if (matchFilter === "no") rows = rows.filter((p) => matchValueOf(p) === false);

  if (!rows.length) {
    const matchFilterActive = matchFilter === "yes" || matchFilter === "no";
    const reason = query.trim() || matchFilterActive ? "No matches for the current filter." : "Nothing in this tab.";
    // The Match column's own filter toggle lives in the table header, which
    // doesn't exist once every row is filtered out -- without an explicit
    // way back, a "Match: No" filter that (correctly) zeroes out every row
    // would otherwise strand the user with no visible control to reset it.
    const clearButton = matchFilterActive
      ? ` <button type="button" class="mapping-empty-clear" data-match-filter-clear="1">Clear match filter</button>`
      : "";
    return `<p class="mapping-empty">${reason}${clearButton}</p>`;
  }

  const branchByBuildingId = branchesById(report);
  const byBuilding = new Map();
  for (const p of rows) {
    if (!byBuilding.has(p.sourceBuildingId)) byBuilding.set(p.sourceBuildingId, []);
    byBuilding.get(p.sourceBuildingId).push(p);
  }

  const sections = [...byBuilding.entries()]
    .map(([buildingId, buildingRows]) => {
      const sorted = sortRows(buildingRows, sortState);
      const branch = branchByBuildingId.get(buildingId);
      const open = expandedBuildingIds?.has(buildingId) ? " open" : "";
      return `<details class="building-group" data-building-id="${buildingId}"${open}>
        <summary class="building-group-title"><span class="group-chevron" aria-hidden="true"></span>${branch ? buildingGroupLabel(report, branch) : escape(buildingRows[0]?.sourceBuildingName)}</summary>
        <div class="proposal-table-scroll">
          <table class="proposal-table">
            <thead><tr>
              ${sortableHeader("Level", "level", sortState)}
              ${sortableHeader("Elements", "elements", sortState)}
              ${sortableHeader("Proposed level", "proposed", sortState)}
              ${matchHeader(matchFilter)}
              <th scope="col">Description</th>
            </tr></thead>
            <tbody>${sorted.map((p) => proposalRow(report, p)).join("")}</tbody>
          </table>
        </div>
      </details>`;
    })
    .join("");

  return sections;
}
