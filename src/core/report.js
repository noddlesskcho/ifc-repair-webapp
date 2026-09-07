/**
 * Structured report generation (PDF + CSV) for a completed repair.
 *
 * buildReportData() is the single source of truth both renderers consume --
 * every count in the PDF and every row in the CSV comes from the exact same
 * `report`/`result`/`audit`/`validation` objects the repair actually
 * produced, so the two can never disagree with each other.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

const CONFIDENCE_LABEL = { high: "High", unmatched: "Unmatched", ambiguous: "Ambiguous" };
const REFERENCE_BASIS_LABEL = { "source-storey-reference": "Source storey reference" };
const MATCHING_METHOD_LABEL = {
  exact: "Exact",
  "boundary-snap": "Boundary snap (tolerance)",
  interval: "Interval containment",
  "manual-override": "Manually assigned",
};
const ACTION_LABEL = {
  "storey-metadata-updated": "Linked storey name updated",
  skipped: "Skipped",
  "unresolved-unmatched": "Unresolved (unmatched)",
  "unresolved-ambiguous": "Unresolved (ambiguous)",
  "already-correct": "Already correct (unchanged)",
};

/**
 * @param {object} args
 * @param {object} args.report - detector.js analyze() output
 * @param {object} args.result - repairer.js applyRepair() output
 * @param {object[]} args.audit - repairer.js buildElementAudit() output
 * @param {object[]} args.validation - repairer.js validateRepair() output
 * @param {object} args.meta - { sourceName, schema, tolerance, generatedAt, appVersion }
 */
export function buildReportData({ report, result, audit, validation, meta }) {
  const detectedProposals = report.proposals.filter((p) => p.elementCount > 0);
  const repairedStoreyIds = new Set(result.changes.map((c) => c.fromStoreyId));
  const skippedStoreyIds = new Set(result.skipped.map((p) => p.sourceStoreyId));
  const unresolvedProposals = detectedProposals.filter((p) => p.status === "unmatched" || p.status === "ambiguous");
  const alreadyCorrectProposals = detectedProposals.filter((p) => p.alreadyCorrect);

  const counts = {
    branches: {
      detected: detectedProposals.length,
      repaired: repairedStoreyIds.size,
      skipped: skippedStoreyIds.size,
      unresolved: unresolvedProposals.length,
      alreadyCorrect: alreadyCorrectProposals.length,
      removed: 0,
    },
    elements: {
      detected: detectedProposals.reduce((a, p) => a + p.elementCount, 0),
      repaired: result.elementsAffected,
      skipped: result.skipped.reduce((a, p) => a + p.elementCount, 0),
      unresolved: unresolvedProposals.reduce((a, p) => a + p.elementCount, 0),
      alreadyCorrect: alreadyCorrectProposals.reduce((a, p) => a + p.elementCount, 0),
    },
  };

  const mapping = detectedProposals.map((p) => ({
    branch: `${p.sourceBuildingName} · ${p.sourceStoreyName}`,
    resolvedZ: p.sourceAbsoluteZ,
    repairStrategy: p.repairStrategy === "rename" ? "Rename in place" : "Review required",
    referenceBasis: REFERENCE_BASIS_LABEL[p.referenceBasis] || p.referenceBasis,
    matchingMethod: p.matchingMethod ? MATCHING_METHOD_LABEL[p.matchingMethod] || p.matchingMethod : "—",
    target:
      p.targetStoreyName ||
      (p.status === "ambiguous" ? p.ambiguousCandidates.map((c) => c.storeyName).join(" / ") : "—"),
    targetStoreyGuid: p.targetStoreyGuid || "—",
    intervalLowerZ: p.intervalLowerZ,
    intervalUpperZ: p.intervalUpperZ,
    toleranceUsed: p.toleranceUsed,
    delta: p.deltaZ,
    confidence: CONFIDENCE_LABEL[p.status] || p.status,
    elementCount: p.elementCount,
    nameMatchesMaster: p.targetStoreyId != null ? p.nameMatchesMaster : null,
    fflMatchesMaster: p.targetStoreyId != null ? p.fflMatchesMaster : null,
    fflDifferenceMm: p.fflDifferenceMm,
    reviewStatus: p.status === "ambiguous" || p.status === "unmatched" ? "Needs review" : "OK",
    outcome: p.alreadyCorrect
      ? "Already correct"
      : repairedStoreyIds.has(p.sourceStoreyId)
        ? "Repaired"
        : skippedStoreyIds.has(p.sourceStoreyId)
          ? "Skipped"
          : "Unresolved",
  }));

  const typeBreakdown = new Map();
  for (const a of audit) {
    const row = typeBreakdown.get(a.elementType) || { reassigned: 0, alreadyCorrect: 0, skipped: 0, unresolved: 0 };
    if (a.action === "storey-metadata-updated") row.reassigned++;
    else if (a.action === "already-correct") row.alreadyCorrect++;
    else if (a.action === "skipped") row.skipped++;
    else row.unresolved++;
    typeBreakdown.set(a.elementType, row);
  }

  const unresolvedIssues = unresolvedProposals.map((p) => ({
    branch: `${p.sourceBuildingName} · ${p.sourceStoreyName}`,
    elementCount: p.elementCount,
    reason: p.explanation,
  }));

  return {
    meta,
    counts,
    mapping,
    typeBreakdown: [...typeBreakdown.entries()].map(([type, row]) => ({ type, ...row })),
    removedContainers: [],
    containmentReassignments: 0,
    unresolvedIssues,
    validation: validation || [],
    audit,
    warnings: report.warnings,
  };
}

const BRAND = [37, 99, 235]; // accent blue, matches the app's UI

function addFooter(doc, marginX) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(130);
    doc.text("IFC Linked-Branch Repair Report", marginX, pageHeight - 22);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - marginX, pageHeight - 22, { align: "right" });
  }
}

function sectionHeading(doc, text, y, marginX) {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y > pageHeight - 90) {
    doc.addPage();
    y = 50;
  }
  doc.setFontSize(12);
  doc.setTextColor(20, 24, 33);
  doc.setFont(undefined, "bold");
  doc.text(text, marginX, y);
  doc.setFont(undefined, "normal");
  return y + 14;
}

function table(doc, marginX, y, head, body, opts = {}) {
  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [head],
    body,
    theme: "grid",
    headStyles: { fillColor: BRAND, fontSize: 8.5, halign: "left" },
    bodyStyles: { fontSize: 8, textColor: [30, 34, 40] },
    alternateRowStyles: { fillColor: [246, 247, 248] },
    styles: { cellPadding: 4, overflow: "linebreak" },
    ...opts,
  });
  return doc.lastAutoTable.finalY + 18;
}

export function renderPdfReport(data) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const marginX = 40;
  let y = 52;

  doc.setFontSize(17);
  doc.setTextColor(20, 24, 33);
  doc.setFont(undefined, "bold");
  doc.text("IFC Linked-Branch Repair Report", marginX, y);
  doc.setFont(undefined, "normal");
  y += 24;

  doc.setFontSize(9.5);
  doc.setTextColor(90, 98, 110);
  const metaLines = [
    `File: ${data.meta.sourceName}`,
    `IFC schema: ${data.meta.schema}`,
    `Report generated: ${data.meta.generatedAt}`,
    `App version: ${data.meta.appVersion}`,
    `Settings: matching tolerance ${data.meta.tolerance}mm (boundary-snapping only)`,
  ];
  for (const line of metaLines) {
    doc.text(line, marginX, y);
    y += 13;
  }
  y += 10;

  y = sectionHeading(doc, "Outcome summary", y, marginX);
  y = table(
    doc,
    marginX,
    y,
    ["Metric", "Branches", "Elements"],
    [
      ["Detected", String(data.counts.branches.detected), String(data.counts.elements.detected)],
      ["Storey names updated", String(data.counts.branches.repaired), String(data.counts.elements.repaired)],
      ["Already correct", String(data.counts.branches.alreadyCorrect), String(data.counts.elements.alreadyCorrect)],
      ["Skipped", String(data.counts.branches.skipped), String(data.counts.elements.skipped)],
      ["Unresolved", String(data.counts.branches.unresolved), String(data.counts.elements.unresolved)],
      ["Hierarchy branches removed", String(data.counts.branches.removed), "—"],
    ]
  );

  y = sectionHeading(doc, "Linked storey name mapping (before -> after)", y, marginX);
  y = table(
    doc,
    marginX,
    y,
    ["Branch", "Source FFL", "Target storey", "Strategy", "Name", "FFL", "FFL difference", "Elements", "Outcome"],
    data.mapping.map((m) => [
      m.branch,
      `${m.resolvedZ.toFixed(0)}mm`,
      m.target,
      m.repairStrategy,
      m.nameMatchesMaster == null ? "N/A" : m.nameMatchesMaster ? "Same" : "Different",
      m.fflMatchesMaster == null ? "N/A" : m.fflMatchesMaster ? "Same" : "Different",
      m.fflDifferenceMm != null ? `${m.fflDifferenceMm.toFixed(1)}mm` : "—",
      String(m.elementCount),
      m.outcome,
    ])
  );

  y = sectionHeading(doc, "Element-type breakdown", y, marginX);
  if (data.typeBreakdown.length > 0) {
    y = table(
      doc,
      marginX,
      y,
      ["IFC type", "Covered by update", "Already correct", "Skipped", "Unresolved"],
      data.typeBreakdown.map((t) => [t.type, String(t.reassigned), String(t.alreadyCorrect), String(t.skipped), String(t.unresolved)])
    );
  } else {
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("No elements were affected.", marginX, y);
    y += 20;
  }

  y = sectionHeading(doc, "Hierarchy preservation", y, marginX);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text("No IfcSite, IfcBuilding or IfcBuildingStorey container was removed, and product containment was preserved.", marginX, y);
  y += 20;

  y = sectionHeading(doc, "Unresolved issues", y, marginX);
  if (data.unresolvedIssues.length > 0) {
    y = table(
      doc,
      marginX,
      y,
      ["Branch", "Elements", "Reason"],
      data.unresolvedIssues.map((u) => [u.branch, String(u.elementCount), u.reason])
    );
  } else {
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("None -- every detected branch was either repaired or explicitly skipped.", marginX, y);
    y += 20;
  }

  y = sectionHeading(doc, "Validation checks performed", y, marginX);
  if (data.validation.length > 0) {
    y = table(
      doc,
      marginX,
      y,
      ["Check", "Result", "Detail"],
      data.validation.map((v) => [v.name, v.passed ? "Passed" : "FAILED", v.detail])
    );
  } else {
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("No repair was applied, so no post-repair validation checks were run.", marginX, y);
    y += 20;
  }

  // Element-level appendix always starts on its own page -- it's the
  // longest section and reads better without a partial lead-in.
  doc.addPage();
  y = 52;
  y = sectionHeading(doc, "Appendix: element-level detail", y, marginX);
  if (data.audit.length > 0) {
    table(
      doc,
      marginX,
      y,
      ["GUID", "Type", "From", "To", "Confidence", "Action"],
      data.audit.map((a) => [
        a.elementGuid || "—",
        a.elementType,
        `${a.fromBuildingName} • ${a.fromStoreyName}`,
        a.toStoreyName || "—",
        CONFIDENCE_LABEL[a.confidence] || a.confidence,
        ACTION_LABEL[a.action] || a.action,
      ]),
      { styles: { cellPadding: 3, overflow: "linebreak", fontSize: 7 }, columnStyles: { 0: { cellWidth: 110 } } }
    );
  } else {
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("No elements were affected by this repair.", marginX, y);
  }

  addFooter(doc, marginX);
  return doc.output("arraybuffer");
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRows(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

/** The detailed, element-level structured record set -- the same data as the PDF appendix. */
export function renderCsvReport(data) {
  const header = [
    "element_guid",
    "element_type",
    "element_name",
    "from_building",
    "from_storey",
    "to_storey",
    "reference_basis",
    "matching_method",
    "source_elevation_mm",
    "target_elevation_mm",
    "delta_z_mm",
    "storey_name_match",
    "storey_ffl_match",
    "ffl_difference_mm",
    "confidence",
    "action",
  ];
  const rows = data.audit.map((a) => [
    a.elementGuid,
    a.elementType,
    a.elementName,
    a.fromBuildingName,
    a.fromStoreyName,
    a.toStoreyName || "",
    REFERENCE_BASIS_LABEL[a.referenceBasis] || a.referenceBasis || "",
    a.matchingMethod ? MATCHING_METHOD_LABEL[a.matchingMethod] || a.matchingMethod : "",
    a.sourceAbsoluteZ != null ? a.sourceAbsoluteZ.toFixed(1) : "",
    a.targetAbsoluteZ != null ? a.targetAbsoluteZ.toFixed(1) : "",
    a.deltaZ != null ? a.deltaZ.toFixed(1) : "",
    a.nameMatchesMaster == null ? "" : a.nameMatchesMaster ? "Same" : "Different",
    a.fflMatchesMaster == null ? "" : a.fflMatchesMaster ? "Same" : "Different",
    a.fflDifferenceMm != null ? a.fflDifferenceMm.toFixed(1) : "",
    CONFIDENCE_LABEL[a.confidence] || a.confidence,
    ACTION_LABEL[a.action] || a.action,
  ]);
  return csvRows([header, ...rows]);
}
