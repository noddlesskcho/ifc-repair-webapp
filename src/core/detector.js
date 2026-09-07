/**
 * Detection of linked-model spatial branches in a Revit-exported IFC file.
 *
 * Background
 * ----------
 * In Revit, a repeated unit (e.g. an apartment) is often built once in a
 * linked model, then linked into the master model and copied onto several
 * storeys. When the master model is exported to IFC, Revit sometimes fails
 * to place the linked unit's elements directly under the master building's
 * storeys. Instead it exports each linked instance as its own IfcBuilding
 * (sibling of the master building, under the same or a different IfcSite),
 * carrying its own internal storeys (Base Level, 1st Storey, etc.) that are
 * just copies of the *linked* model's levels -- not the master building's
 * storeys.
 *
 * The internal storey names are not trustworthy: a linked unit placed on
 * the 4th storey of the master building may still contain elements under an
 * internal storey literally called "Base Level" or "1st Storey". The only
 * reliable signal is elevation, resolved via IfcAPI.GetWorldTransformMatrix
 * (which walks the full IfcLocalPlacement chain) and converted to
 * millimetres via the file's own IfcUnitAssignment.
 *
 * Assignment rule (interval containment, not nearest-neighbour)
 * ---------------------------------------------------------------
 * Given master storeys sorted by elevation, an element belongs to the
 * master storey M such that:
 *
 *     M.elevation <= bottomReferenceElevation < nextMaster.elevation
 *
 * An element extending upward past that interval still belongs to the
 * storey containing its *bottom* -- this is deliberately NOT "nearest
 * storey by distance". A gap of several metres between a linked storey and
 * its matched master storey is expected and correct as long as no other
 * master storey elevation falls in between.
 *
 * Four distinct concepts (never conflated)
 * -----------------------------------------
 *   1. An actual, verified base/bottom reference for an element (e.g. an
 *      authored base-offset property) -- not something this tool can derive
 *      for arbitrary element types without full geometry evaluation, so in
 *      practice this tier is not currently populated.
 *   2. The resolved containing *linked* storey's own elevation -- always
 *      available, used as the fallback reference ("Source storey
 *      reference"). This is an explicit fallback, never described as a
 *      verified element base.
 *   3. The element's own IfcLocalPlacement origin -- real data, but NOT
 *      assumed to represent the element's bottom (an insertion point can
 *      sit mid-height, e.g. for MEP/proxy elements). It is used only as a
 *      cross-check against the fallback, to catch and flag contradictions
 *      -- never as the primary matching reference by itself.
 *   4. The lowest point of an element's actual geometry -- would require
 *      full mesh evaluation; not computed here.
 *
 * Reference basis / confidence
 * -----------------------------
 * Every proposal carries `referenceBasis: "source-storey-reference"` because
 * the containing linked storey is the selected reference policy.
 * The selected policy explicitly uses the containing linked storey as the
 * reference. An unambiguous interval therefore qualifies as high confidence
 * under that policy; it is not a claim about the individual element's base.
 *
 * Grouping
 * --------
 * All elements in one linked storey share the same fallback reference (the
 * storey's own elevation) and are proposed as a single group/proposal.
 *
 * A per-element cross-check against the fallback was deliberately NOT
 * implemented: an element's raw IfcLocalPlacement origin commonly differs
 * from its containing storey's elevation for completely ordinary reasons
 * (e.g. a wall's base sits above its storey's reference by a slab
 * thickness, an MEP proxy's insertion point sits mid-height) -- this is
 * *expected* variation within a correctly-identified storey, not evidence
 * the element belongs to a different one. Verified empirically against both
 * a synthetic fixture and a real Revit export: treating "own placement
 * resolves to a different interval" as a contradiction produced false
 * positives on ordinary, correctly-placed elements in both. Since this tool
 * has no way to distinguish a legitimate local offset from a genuine
 * misplacement without full geometry evaluation, it does not attempt to --
 * per the "use reliable base-reference info where available" rule, raw
 * placement origin does not qualify as reliable evidence, so every element
 * uses the storey fallback. The `referenceBasis`/`contradictsOwnPlacement`
 * fields stay in the proposal shape as an extension point for a genuinely
 * reliable per-element signal in the future (e.g. an authored base-offset
 * property), should one become available.
 *
 * Tolerance
 * ---------
 * `storeyMatchTolerance` (default 150mm) is used ONLY to snap a reference
 * that lands very close to a master-storey boundary onto that boundary --
 * never to bridge a large elevation gap for an interior interval match
 * (interior matches have no distance cap at all; a reference thousands of
 * millimetres above its matched storey's elevation, but still below the
 * next storey's elevation, is a perfectly valid match).
 *
 * The default was raised from 50mm after a real user-reported file showed
 * this is not an edge case: every single interval-fallback match in that
 * file (167 of 167) sat exactly 50mm or 100mm below the NEXT master
 * storey's elevation, never randomly scattered -- a routine Revit authoring
 * offset (screed/topping/formwork allowance on the source storey's own
 * reference), not evidence the element belongs to the storey below. 150mm
 * comfortably covers both observed clusters while staying far under the
 * smallest real storey-to-storey gap seen in practice (~1200mm), so it
 * can't accidentally make two adjacent boundaries ambiguous.
 */
import {
  WebIFC,
  absoluteZ,
  getContainedElements,
  getContainingSiteId,
  getDecomposedStoreys,
  getIdsOfType,
  getLengthUnitScaleToMM,
  getLine,
  guid,
  name as entityName,
} from "./ifcModel.js";
import { buildTowerAssignments } from "./towerAssignment.js";
import { compareBlockStoreys } from "./blockDetection.js";

export const DEFAULT_STOREY_MATCH_TOLERANCE = 150; // mm: boundary-snapping tolerance only (see file header's "Tolerance" section)

const EXACT_EPSILON_MM = 1e-6; // float-precision guard, not a real-world tolerance
const DUPLICATE_ELEVATION_EPSILON_MM = 1e-6;

function buildStoreyInfo(model, buildingId, storeyId, scaleToMM) {
  const line = getLine(model, storeyId);
  const hasPlacement = line.ObjectPlacement != null;
  return {
    id: storeyId,
    guid: guid(model, storeyId),
    name: line.Name?.value || "Unnamed",
    elevationAttribute: line.Elevation?.value ?? null,
    absoluteZ: hasPlacement ? absoluteZ(model, line.ObjectPlacement) * scaleToMM : 0,
    hasPlacement,
    buildingId,
    buildingName: entityName(model, buildingId),
    elementCount: getContainedElements(model, storeyId).length,
  };
}

/**
 * Classifies a single elevation `z` (mm) against sorted master storeys.
 * Returns one of:
 *   { intervalStatus: "no-master-storeys" }
 *   { intervalStatus: "ambiguous-boundary", ambiguousCandidates }
 *   { intervalStatus: "below-lowest", lower: <lowest storey's Z> }
 *   { intervalStatus: "above-highest", lower: <topmost storey's Z> }
 *   { intervalStatus: "matched", matchingMethod, target, lower, upper }
 */
function classifyInterval(z, masterStoreysSorted, tolerance) {
  if (masterStoreysSorted.length === 0) {
    return { intervalStatus: "no-master-storeys", matchingMethod: null, target: null, lower: null, upper: null, ambiguousCandidates: null };
  }

  const nearBoundary = masterStoreysSorted
    .map((s) => ({ s, distance: Math.abs(s.absoluteZ - z) }))
    .filter((c) => c.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance);

  if (nearBoundary.length > 1) {
    return {
      intervalStatus: "ambiguous-boundary",
      matchingMethod: null,
      target: null,
      lower: null,
      upper: null,
      ambiguousCandidates: nearBoundary.map((c) => ({
        storeyId: c.s.id,
        storeyGuid: c.s.guid,
        storeyName: c.s.name,
        absoluteZ: c.s.absoluteZ,
        distance: c.distance,
      })),
    };
  }

  let target;
  let matchingMethod;
  if (nearBoundary.length === 1) {
    target = nearBoundary[0].s;
    matchingMethod = nearBoundary[0].distance < EXACT_EPSILON_MM ? "exact" : "boundary-snap";
  } else {
    let candidate = null;
    for (const s of masterStoreysSorted) {
      if (s.absoluteZ <= z) candidate = s;
      else break; // sorted ascending
    }
    if (!candidate) {
      return {
        intervalStatus: "below-lowest",
        matchingMethod: null,
        target: null,
        lower: masterStoreysSorted[0].absoluteZ,
        upper: null,
        ambiguousCandidates: null,
      };
    }
    const isTopmost = candidate === masterStoreysSorted[masterStoreysSorted.length - 1];
    if (isTopmost) {
      // Already excluded the "within tolerance of this boundary" case above,
      // so z is meaningfully above the topmost storey with no upper bound.
      return {
        intervalStatus: "above-highest",
        matchingMethod: null,
        target: null,
        lower: candidate.absoluteZ,
        upper: null,
        ambiguousCandidates: null,
      };
    }
    target = candidate;
    matchingMethod = "interval";
  }

  const idx = masterStoreysSorted.indexOf(target);
  const upper = idx < masterStoreysSorted.length - 1 ? masterStoreysSorted[idx + 1].absoluteZ : null;
  return { intervalStatus: "matched", matchingMethod, target, lower: target.absoluteZ, upper, ambiguousCandidates: null };
}

/**
 * Confidence describes matching under the source-storey reference policy.
 * Exact, boundary-snap and unique interior intervals are eligible by default.
 * Ambiguous or unresolved references remain excluded.
 */
function statusOf(intervalStatus) {
  if (intervalStatus === "ambiguous-boundary" || intervalStatus === "contradiction") return "ambiguous";
  if (intervalStatus !== "matched") return "unmatched"; // below-lowest, above-highest, no-master-storeys, missing-placement
  // Exact, boundary-snap and unique interval matches are all trusted under the
  // source-storey reference policy. Tower confidence is gated separately.
  return "high";
}

function fmt(z) {
  return Number.isFinite(z) ? Math.round(z * 100) / 100 : z;
}

function normalizedStoreyName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function explanationOf(referenceZ, referenceBasis, classification, storeyName) {
  const refLabel = "Source storey reference";
  const z = fmt(referenceZ);
  switch (classification.intervalStatus) {
    case "matched": {
      const range =
        classification.upper != null
          ? `${fmt(classification.lower)}–${fmt(classification.upper)} mm`
          : `${fmt(classification.lower)} mm and above (top storey, no upper bound)`;
      const method =
        classification.matchingMethod === "exact"
          ? "matches exactly"
          : classification.matchingMethod === "boundary-snap"
            ? "is within tolerance of the boundary of"
            : "falls within";
      return `${refLabel} ${z} mm ${method} ${classification.target.name}: ${range}.`;
    }
    case "ambiguous-boundary":
      return (
        `${refLabel} ${z} mm is within tolerance of ${classification.ambiguousCandidates.length} master storeys ` +
        `(${classification.ambiguousCandidates.map((c) => `${c.storeyName} at ${fmt(c.absoluteZ)} mm`).join(", ")}) ` +
        "-- ambiguous, needs manual review."
      );
    case "below-lowest":
      return `${refLabel} ${z} mm is below the lowest master storey (${fmt(classification.lower)} mm) -- not auto-matched.`;
    case "above-highest":
      return `${refLabel} ${z} mm is above the highest master storey (${fmt(classification.lower)} mm) with no defined upper boundary -- not auto-matched.`;
    case "no-master-storeys":
      return "The master building has no storeys to match against.";
    case "missing-placement":
      return `Storey '${storeyName}' has no resolvable placement -- cannot determine a reference elevation.`;
    default:
      return "";
  }
}

function baseProposal(source, buildingId, siteId) {
  return {
    sourceStoreyId: source.id,
    sourceStoreyGuid: source.guid,
    sourceStoreyName: source.name,
    sourceBuildingId: buildingId,
    sourceBuildingName: source.buildingName,
    sourceSiteId: siteId,
    // Populated only in MULTI_BLOCK mode (see analyzeMultiBlock()): which
    // detected tower this storey's containing building was assigned to, and
    // how confident that spatial assignment was (see towerAssignment.js).
    sourceBlockId: null,
    sourceBlockGuid: null,
    sourceBlockLabel: null,
    assignmentConfident: null,
    sourceAbsoluteZ: source.absoluteZ,
    elementIds: [],
    elementCount: 0,
    referenceBasis: "source-storey-reference",
    referenceAbsoluteZ: source.absoluteZ,
    matchingMethod: null,
    intervalStatus: null,
    toleranceUsed: false,
    intervalLowerZ: null,
    intervalUpperZ: null,
    targetStoreyId: null,
    targetStoreyGuid: null,
    targetStoreyName: null,
    targetAbsoluteZ: null,
    deltaZ: null,
    nameMatchesMaster: false,
    fflMatchesMaster: false,
    fflDifferenceMm: null,
    alreadyCorrect: false,
    ambiguousCandidates: null,
    contradictsOwnPlacement: false,
    ownPlacementAbsoluteZ: null,
    ownPlacementTargetStoreyName: null,
    status: "unmatched",
    explanation: "",
    // Repairs only ever rename this storey in place. A genuine duplicate
    // target within the same immediate IfcBuilding is held for review.
    repairStrategy: null,
    sameParentCollision: false,
    // Populated only when a caller passes `overrides` to analyze().
    manualOverride: false,
    autoTargetStoreyId: null,
    autoTargetStoreyName: null,
    overrideFarFromDetected: false,
  };
}

function applyClassification(proposal, classification, referenceZ, tolerance) {
  proposal.intervalStatus = classification.intervalStatus;
  proposal.matchingMethod = classification.matchingMethod;
  proposal.toleranceUsed = classification.matchingMethod === "boundary-snap";
  proposal.intervalLowerZ = classification.lower;
  proposal.intervalUpperZ = classification.upper;
  proposal.ambiguousCandidates = classification.ambiguousCandidates;
  if (classification.intervalStatus === "matched") {
    proposal.targetStoreyId = classification.target.id;
    proposal.targetStoreyGuid = classification.target.guid;
    proposal.targetStoreyName = classification.target.name;
    proposal.targetAbsoluteZ = classification.target.absoluteZ;
    proposal.deltaZ = referenceZ - classification.target.absoluteZ;
    proposal.nameMatchesMaster =
      normalizedStoreyName(proposal.sourceStoreyName) === normalizedStoreyName(classification.target.name);
    proposal.fflDifferenceMm = Math.abs(proposal.deltaZ);
    proposal.fflMatchesMaster = proposal.fflDifferenceMm <= tolerance;
    // The repair updates linked storey identity only. A matching Name means
    // no edit is needed even when the source storey's physical reference is
    // inside (rather than exactly on) the matched master storey interval.
    proposal.alreadyCorrect = proposal.nameMatchesMaster;
    proposal.repairStrategy = "rename";
    proposal.autoTargetStoreyId = classification.target.id;
    proposal.autoTargetStoreyName = classification.target.name;
  }
  proposal.explanation = explanationOf(referenceZ, proposal.referenceBasis, classification, proposal.sourceStoreyName);
  if (proposal.alreadyCorrect) {
    proposal.explanation =
      `Already correct: source storey name matches '${classification.target.name}'. ` +
      `Source placement is ${fmt(proposal.fflDifferenceMm)} mm above the master FFL and remains unchanged.`;
  }
  proposal.status = statusOf(classification.intervalStatus);
  return proposal;
}

function getOverrideTarget(overrides, sourceStoreyId) {
  if (!overrides) return undefined;
  if (overrides instanceof Map) return overrides.get(sourceStoreyId);
  return overrides[sourceStoreyId] ?? overrides[String(sourceStoreyId)];
}

/**
 * Applies caller-supplied manual target reassignments on top of the
 * automatic classification. `overrides` maps sourceStoreyId -> a master
 * storey id to force as the target (or is omitted/null for "use the
 * automatic result"). Recomputes every derived field (name/FFL match,
 * confidence, explanation) against the chosen target exactly as the
 * automatic path would, then flags how far the manual choice sits from
 * whatever was automatically detected -- e.g. picking "Roof Level" when the
 * tool detected "1st Storey" is a real, human-visible red flag, not a
 * rounding nuance, and the review table must say so rather than silently
 * accepting it.
 */
function applyOverrides(proposals, overrides, masterStoreysSorted, tolerance) {
  if (!overrides) return;
  const byId = new Map(masterStoreysSorted.map((m) => [m.id, m]));

  for (const p of proposals) {
    const overrideTargetId = getOverrideTarget(overrides, p.sourceStoreyId);
    if (overrideTargetId == null) continue;
    const target = byId.get(overrideTargetId);
    if (!target) continue; // stale/unknown master storey id -- ignore rather than crash

    const autoTargetId = p.autoTargetStoreyId;
    p.targetStoreyId = target.id;
    p.targetStoreyGuid = target.guid;
    p.targetStoreyName = target.name;
    p.targetAbsoluteZ = target.absoluteZ;
    p.deltaZ = p.referenceAbsoluteZ - target.absoluteZ;
    p.nameMatchesMaster = normalizedStoreyName(p.sourceStoreyName) === normalizedStoreyName(target.name);
    p.fflDifferenceMm = Math.abs(p.deltaZ);
    p.fflMatchesMaster = p.fflDifferenceMm <= tolerance;
    p.alreadyCorrect = false; // an explicit manual choice always means "apply this"
    p.intervalStatus = "matched";
    p.matchingMethod = "manual-override";
    p.status = "high"; // a deliberate human choice is trusted for repair eligibility
    p.repairStrategy = "rename";
    p.sameParentCollision = false;
    p.manualOverride = true;
    p.ambiguousCandidates = null;

    if (autoTargetId != null) {
      const autoIdx = masterStoreysSorted.findIndex((m) => m.id === autoTargetId);
      const chosenIdx = masterStoreysSorted.findIndex((m) => m.id === target.id);
      p.overrideFarFromDetected = autoIdx >= 0 && chosenIdx >= 0 && Math.abs(autoIdx - chosenIdx) > 1;
    } else {
      p.overrideFarFromDetected = false;
    }

    const farNote = p.overrideFarFromDetected
      ? ` This is several levels away from the automatically detected match -- please double-check before repairing.`
      : "";
    p.explanation = p.autoTargetStoreyName
      ? `Manually set to '${target.name}' (${fmt(target.absoluteZ)} mm), overriding the detected match ` +
        `'${p.autoTargetStoreyName}'.${farNote}`
      : `Manually set to '${target.name}' (${fmt(target.absoluteZ)} mm); no automatic match was found.${farNote}`;
  }
}

/** Holds only genuine same-parent duplicate target names for manual review. */
function applySameParentCollisionReview(proposals, warnings) {
  const matched = proposals.filter((p) => p.targetStoreyId != null && p.elementCount > 0);
  const byBuilding = new Map();
  for (const p of matched) {
    if (!byBuilding.has(p.sourceBuildingId)) byBuilding.set(p.sourceBuildingId, []);
    byBuilding.get(p.sourceBuildingId).push(p);
  }

  for (const buildingProposals of byBuilding.values()) {
    const byName = new Map();
    for (const p of buildingProposals) {
      const key = normalizedStoreyName(p.targetStoreyName);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(p);
    }
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const names = group.map((p) => `'${p.sourceStoreyName}'`).join(", ");
      const targetName = group[0].targetStoreyName;
      const buildingName = group[0].sourceBuildingName || "Unnamed";
      for (const p of group) {
        p.status = "ambiguous";
        p.sameParentCollision = true;
        p.alreadyCorrect = false;
        p.repairStrategy = null;
        p.explanation =
          `Review required: ${names} under the same source building '${buildingName}' all resolve to ` +
          `'${targetName}'. Choose distinct target levels before repair; no hierarchy or containment will be changed.`;
      }
      warnings.push(
        `Source building '${buildingName}': ${names} all match '${targetName}' -- manual review is required before repair.`
      );
    }
  }
}

/**
 * Builds the proposal for one linked storey: a single fallback-based group
 * covering all of its elements (see the "Grouping" note above the file
 * header for why no per-element cross-check is attempted).
 */
function proposeForStorey(model, source, buildingId, siteId, masterStoreys, tolerance) {
  const elementIds = getContainedElements(model, source.id);
  if (elementIds.length === 0) return [];

  if (!source.hasPlacement) {
    const p = baseProposal(source, buildingId, siteId);
    p.elementIds = elementIds;
    p.elementCount = elementIds.length;
    p.intervalStatus = "missing-placement";
    p.status = "unmatched";
    p.explanation = explanationOf(source.absoluteZ, p.referenceBasis, { intervalStatus: "missing-placement" }, source.name);
    return [p];
  }

  const classification = classifyInterval(source.absoluteZ, masterStoreys, tolerance);
  const p = baseProposal(source, buildingId, siteId);
  p.elementIds = elementIds;
  p.elementCount = elementIds.length;
  applyClassification(p, classification, source.absoluteZ, tolerance);
  return [p];
}

/** True only for proposals repairer.js is ever allowed to act on. */
export function proposalNeedsAction(p) {
  return p.targetStoreyId != null && p.elementCount > 0 && !p.alreadyCorrect && p.status === "high" && !p.sameParentCollision;
}

/**
 * The single source of truth for "which proposals will actually be repaired
 * given these settings" -- shared by the main-thread preview (mapping list,
 * counts) and the repair worker, so they can never disagree.
 *
 * "unmatched"/"ambiguous" proposals are never included. All unambiguous
 * matches are eligible under the source-storey reference policy.
 *
 * On a MULTI_BLOCK file, a proposal whose source building couldn't be
 * confidently assigned to a tower (towerAssignment.js's best-guess, not a
 * hard gate -- see its file header) is excluded here even if the elevation
 * match itself is confident: an FFL match to the right *name* means nothing
 * if the guess about *which tower* was wrong. Per the original spec this
 * gate exists for: "do not rename it, show it in a review screen, require
 * the user to select." A manual override on that row (the user has looked
 * at it and picked/confirmed a target) lifts this exclusion -- that IS the
 * required confirmation.
 */
export function selectRepairableProposals(report) {
  return report.proposals.filter((p) => {
    if (!proposalNeedsAction(p)) return false;
    if (p.assignmentConfident === false && !p.manualOverride) return false;
    return p.status === "high";
  });
}

function buildMasterStoreys(model, buildingId, scaleToMM) {
  return getDecomposedStoreys(model, buildingId)
    .map((sId) => buildStoreyInfo(model, buildingId, sId, scaleToMM))
    .sort((a, b) => a.absoluteZ - b.absoluteZ);
}

export function analyze(
  model,
  { storeyMatchTolerance = DEFAULT_STOREY_MATCH_TOLERANCE, sourceName = "", overrides = null, blocks = null } = {}
) {
  if (blocks?.mode === "MULTI_BLOCK") {
    return analyzeMultiBlock(model, blocks, { storeyMatchTolerance, sourceName, overrides });
  }

  const scaleToMM = getLengthUnitScaleToMM(model);
  const warnings = [];
  const buildingIds = getIdsOfType(model, WebIFC.IFCBUILDING);
  if (buildingIds.length === 0) {
    throw new Error("No IfcBuilding found in this IFC file.");
  }

  const storeysByBuilding = new Map();
  for (const bId of buildingIds) storeysByBuilding.set(bId, getDecomposedStoreys(model, bId));

  function score(bId) {
    const storeys = storeysByBuilding.get(bId);
    let total = getContainedElements(model, bId).length;
    for (const s of storeys) total += getContainedElements(model, s).length;
    return [storeys.length, total];
  }

  // A supplied preflight result is authoritative. Running a second master
  // selector here previously allowed preflight to identify one building but
  // repair to silently switch to another (notably when an empty reference
  // ladder had more storeys). The fallback remains only for direct API
  // callers that do not provide block detection.
  let master = blocks?.mode === "SINGLE_BLOCK" ? blocks.blocks[0]?.id : null;
  if (master == null) {
    master = buildingIds[0];
    let masterScore = score(master);
    for (const bId of buildingIds.slice(1)) {
      const s = score(bId);
      if (s[0] > masterScore[0] || (s[0] === masterScore[0] && s[1] > masterScore[1])) {
        master = bId;
        masterScore = s;
      }
    }
  }

  const masterStoreys = buildMasterStoreys(model, master, scaleToMM);

  if (masterStoreys.length === 0) {
    warnings.push(
      `Master building '${entityName(model, master)}' has no IfcBuildingStorey children; elevation matching will be unreliable.`
    );
  }

  for (let i = 1; i < masterStoreys.length; i++) {
    if (Math.abs(masterStoreys[i].absoluteZ - masterStoreys[i - 1].absoluteZ) < DUPLICATE_ELEVATION_EPSILON_MM) {
      warnings.push(
        `Master storeys '${masterStoreys[i - 1].name}' and '${masterStoreys[i].name}' share the same elevation ` +
          `(${fmt(masterStoreys[i].absoluteZ)} mm) -- references near this elevation may be reported as ambiguous.`
      );
    }
  }

  const linkedBranches = [];
  const proposals = [];

  const candidateBuildingIds =
    blocks?.mode === "SINGLE_BLOCK"
      ? [...new Set([...blocks.linkedBuildings, ...blocks.unclassifiedBuildings].map((building) => building.id))]
      : buildingIds.filter((bId) => bId !== master);

  for (const bId of candidateBuildingIds) {
    const storeyIds = storeysByBuilding.get(bId);
    const storeyInfos = storeyIds.map((sId) => buildStoreyInfo(model, bId, sId, scaleToMM));
    const directElements = getContainedElements(model, bId);
    const buildingLine = getLine(model, bId);
    const siteId = getContainingSiteId(model, bId);

    const branch = {
      buildingId: bId,
      buildingGuid: guid(model, bId),
      buildingName: entityName(model, bId),
      buildingAbsoluteZ: buildingLine.ObjectPlacement ? absoluteZ(model, buildingLine.ObjectPlacement) * scaleToMM : 0,
      storeys: storeyInfos,
      directElementCount: directElements.length,
      siteId,
      siteGuid: siteId != null ? guid(model, siteId) : null,
      siteName: siteId != null ? entityName(model, siteId) : null,
    };
    linkedBranches.push(branch);

    if (directElements.length > 0) {
      warnings.push(
        `Building '${branch.buildingName}' has ${directElements.length} element(s) contained directly ` +
          "(not under any storey); these are not covered by storey-level name repair and will be left untouched."
      );
    }

    for (const si of storeyInfos) {
      proposals.push(...proposeForStorey(model, si, bId, siteId, masterStoreys, storeyMatchTolerance));
    }
  }

  applyOverrides(proposals, overrides, masterStoreys, storeyMatchTolerance);
  applySameParentCollisionReview(proposals, warnings);

  // Pushed after overrides/collision resolution so manually-resolved rows do
  // not leave stale warnings and collision warnings are not duplicated.
  for (const p of proposals) {
    if (p.elementCount > 0 && p.intervalStatus !== "matched") {
      warnings.push(`Storey '${p.sourceStoreyName}' in '${p.sourceBuildingName}': ${p.explanation}`);
    }
  }

  const actionableProposals = proposals.filter(proposalNeedsAction);
  const totalElementsAffected = actionableProposals.reduce((a, p) => a + p.elementCount, 0);
  const repairNeeded = proposals.some(proposalNeedsAction);
  const alreadyCorrectStoreys = proposals.filter((p) => p.alreadyCorrect);
  const alreadyCorrectElements = alreadyCorrectStoreys.reduce((sum, p) => sum + p.elementCount, 0);

  return {
    sourceName,
    blocksMode: "SINGLE_BLOCK",
    towerGroups: null,
    buildingCount: buildingIds.length,
    masterBuildingId: master,
    masterBuildingGuid: guid(model, master),
    masterBuildingName: entityName(model, master),
    masterStoreys,
    linkedBranches,
    proposals,
    warnings,
    repairNeeded,
    totalStoreysToUpdate: actionableProposals.length,
    totalElementsAffected,
    // Compatibility alias for older report consumers. No products are moved.
    totalElementsToMove: totalElementsAffected,
    alreadyCorrectStoreys: alreadyCorrectStoreys.length,
    alreadyCorrectElements,
    storeyMatchTolerance,
    lengthUnitScaleToMM: scaleToMM,
  };
}

/**
 * The MULTI_BLOCK counterpart to the single-global-master analyze() above:
 * every detected block/tower gets its OWN master storey list and is matched
 * only against the fragments towerAssignment.js assigned to it -- never
 * against another tower's names, even when two towers share an elevation
 * (see towerAssignment.js's file header for why that matters and how the
 * per-tower physical position is derived).
 */
function analyzeMultiBlock(model, blockResult, { storeyMatchTolerance, sourceName, overrides }) {
  const scaleToMM = getLengthUnitScaleToMM(model);
  const warnings = [];
  const storeyNameComparison = compareBlockStoreys(model, blockResult.blocks);
  for (const conflict of storeyNameComparison.conflicts) {
    const details = conflict.entries
      .map((entry) => `${entry.blockLabel} '${entry.name}' at ${fmt(entry.resolvedGlobalZ)} mm`)
      .join("; ");
    warnings.push(
      `Storey name '${conflict.normalizedName}' is reused at different FFLs across blocks (${details}). ` +
        "The name was treated as supporting information only; verify the physically derived tower assignments."
    );
  }
  const { towerGroups: rawGroups, assignments, warnings: assignmentWarnings = [] } = buildTowerAssignments(model, blockResult);
  warnings.push(...assignmentWarnings);

  const linkedBranches = [];
  const proposals = [];
  const towerGroups = [];

  for (const group of rawGroups) {
    const blockBuildingId = group.block.id;
    const blockGuid = group.block.guid;
    const blockLabel = group.block.name && group.block.name !== "Unnamed" ? group.block.name : `Block ${blockGuid.slice(0, 8)}`;
    const masterStoreys = buildMasterStoreys(model, blockBuildingId, scaleToMM);
    towerGroups.push({ blockId: blockBuildingId, blockGuid, blockLabel, masterStoreys });

    if (masterStoreys.length === 0) {
      warnings.push(`Block '${blockLabel}' (master ${blockGuid}) has no IfcBuildingStorey children; elevation matching will be unreliable.`);
    }
    for (let i = 1; i < masterStoreys.length; i++) {
      if (Math.abs(masterStoreys[i].absoluteZ - masterStoreys[i - 1].absoluteZ) < DUPLICATE_ELEVATION_EPSILON_MM) {
        warnings.push(
          `Block '${blockLabel}': storeys '${masterStoreys[i - 1].name}' and '${masterStoreys[i].name}' share the same ` +
            `elevation (${fmt(masterStoreys[i].absoluteZ)} mm) -- references near this elevation may be reported as ambiguous.`
        );
      }
    }

    for (const bId of group.linkedBuildingIds) {
      const assignment = assignments.get(bId);
      const storeyIds = getDecomposedStoreys(model, bId);
      const storeyInfos = storeyIds.map((sId) => buildStoreyInfo(model, bId, sId, scaleToMM));
      const directElements = getContainedElements(model, bId);
      const buildingLine = getLine(model, bId);
      const siteId = getContainingSiteId(model, bId);

      const branch = {
        buildingId: bId,
        buildingGuid: guid(model, bId),
        buildingName: entityName(model, bId),
        buildingAbsoluteZ: buildingLine.ObjectPlacement ? absoluteZ(model, buildingLine.ObjectPlacement) * scaleToMM : 0,
        storeys: storeyInfos,
        directElementCount: directElements.length,
        siteId,
        siteGuid: siteId != null ? guid(model, siteId) : null,
        siteName: siteId != null ? entityName(model, siteId) : null,
        blockId: blockBuildingId,
        blockGuid,
        blockLabel,
        assignmentConfident: assignment?.confident ?? null,
        assignmentMethod: assignment?.method ?? null,
      };
      linkedBranches.push(branch);

      if (directElements.length > 0) {
        warnings.push(
          `Building '${branch.buildingName}' has ${directElements.length} element(s) contained directly ` +
            "(not under any storey); these are not covered by storey-level name repair and will be left untouched."
        );
      }

      for (const si of storeyInfos) {
        const storeyProposals = proposeForStorey(model, si, bId, siteId, masterStoreys, storeyMatchTolerance);
        for (const p of storeyProposals) {
          p.sourceBlockId = blockBuildingId;
          p.sourceBlockGuid = blockGuid;
          p.sourceBlockLabel = blockLabel;
          p.assignmentConfident = assignment?.confident ?? null;
        }
        proposals.push(...storeyProposals);
      }
    }
  }

  // Overrides can target any tower's storey, not just the one the source
  // building was assigned to (the user may be correcting a wrong assignment)
  // -- resolve against the union of every tower's master storeys.
  const allMasterStoreys = towerGroups.flatMap((g) => g.masterStoreys).sort((a, b) => a.absoluteZ - b.absoluteZ);
  applyOverrides(proposals, overrides, allMasterStoreys, storeyMatchTolerance);
  applySameParentCollisionReview(proposals, warnings);

  for (const p of proposals) {
    if (p.elementCount > 0 && p.intervalStatus !== "matched") {
      warnings.push(`Storey '${p.sourceStoreyName}' in '${p.sourceBuildingName}' (block '${p.sourceBlockLabel}'): ${p.explanation}`);
    }
  }

  const actionableProposals = proposals.filter(proposalNeedsAction);
  const totalElementsAffected = actionableProposals.reduce((a, p) => a + p.elementCount, 0);
  const repairNeeded = proposals.some(proposalNeedsAction);
  const alreadyCorrectStoreys = proposals.filter((p) => p.alreadyCorrect);
  const alreadyCorrectElements = alreadyCorrectStoreys.reduce((sum, p) => sum + p.elementCount, 0);

  return {
    sourceName,
    blocksMode: "MULTI_BLOCK",
    towerGroups,
    buildingCount: blockResult.blocks.length + blockResult.linkedBuildings.length + blockResult.baseBuildings.length + blockResult.unclassifiedBuildings.length,
    masterBuildingId: null,
    masterBuildingGuid: null,
    masterBuildingName: null,
    masterStoreys: allMasterStoreys,
    linkedBranches,
    proposals,
    warnings,
    storeyNameComparison,
    repairNeeded,
    totalStoreysToUpdate: actionableProposals.length,
    totalElementsAffected,
    totalElementsToMove: totalElementsAffected,
    alreadyCorrectStoreys: alreadyCorrectStoreys.length,
    alreadyCorrectElements,
    storeyMatchTolerance,
    lengthUnitScaleToMM: scaleToMM,
  };
}
