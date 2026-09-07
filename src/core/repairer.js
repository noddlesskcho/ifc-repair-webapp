/**
 * Plans hierarchy-preserving linked-storey name updates.
 *
 * web-ifc corrupts the REAL-typed Elevation when an IfcBuildingStorey is
 * round-tripped through WriteLine in the version used by this app. Therefore
 * this module never mutates the model: it records verified changes and lets
 * stepPatcher.js replace only the Name and LongName tokens in the source IFC.
 */
import { getContainedElements, getLine } from "./ifcModel.js";
import { proposalNeedsAction as needsAction, selectRepairableProposals } from "./detector.js";

const attributeValue = (attribute) => attribute?.value ?? null;

function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

function sameIds(left, right) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function aggregateParents(model, id) {
  const line = getLine(model, id, "Decomposes");
  const parents = [];
  for (const relationRef of line?.Decomposes || []) {
    const relation = getLine(model, relationRef.value);
    if (relation?.RelatingObject?.value != null) parents.push(relation.RelatingObject.value);
  }
  return sorted(parents);
}

function elementSnapshot(model, id) {
  const line = getLine(model, id);
  return {
    id,
    guid: line?.GlobalId?.value ?? null,
    type: line ? model.api.GetNameFromTypeCode(line.type) : "Unknown",
    name: line?.Name?.value || "Unnamed",
    placementRef: line?.ObjectPlacement?.value ?? null,
  };
}

function commonChangeFields(model, proposal) {
  const source = getLine(model, proposal.sourceStoreyId);
  return {
    sourceStoreyId: proposal.sourceStoreyId,
    sourceStoreyGuid: source.GlobalId?.value ?? null,
    sourceBuildingId: proposal.sourceBuildingId,
    sourceBuildingName: proposal.sourceBuildingName,
    sourceSiteId: proposal.sourceSiteId,
    fromStoreyId: proposal.sourceStoreyId,
    fromStoreyName: attributeValue(source.Name) || "Unnamed",
    sourceAbsoluteZ: proposal.sourceAbsoluteZ,
    toStoreyId: proposal.targetStoreyId,
    toStoreyName: proposal.targetStoreyName,
    targetAbsoluteZ: proposal.targetAbsoluteZ,
    referenceBasis: proposal.referenceBasis,
    matchingMethod: proposal.matchingMethod,
    deltaZ: proposal.deltaZ ?? 0,
    nameMatchesMaster: proposal.nameMatchesMaster,
    fflMatchesMaster: proposal.fflMatchesMaster,
    fflDifferenceMm: proposal.fflDifferenceMm,
    manualOverride: proposal.manualOverride,
    confidence: proposal.status,
    elementCount: proposal.elementCount,
  };
}

function planRename(model, proposal) {
  const source = getLine(model, proposal.sourceStoreyId);
  const target = getLine(model, proposal.targetStoreyId);
  if (!source || !target) throw new Error("A matched source or master storey no longer exists.");

  const elementIds = getContainedElements(model, proposal.sourceStoreyId);
  return {
    ...commonChangeFields(model, proposal),
    fromLongName: attributeValue(source.LongName),
    fromElevation: attributeValue(source.Elevation),
    sourcePlacementRef: source.ObjectPlacement?.value ?? null,
    sourceParentIds: aggregateParents(model, proposal.sourceStoreyId),
    containedElementIds: [...elementIds],
    elementSnapshots: elementIds.map((id) => elementSnapshot(model, id)),
    toStoreyGuid: target.GlobalId?.value ?? null,
    toLongName: attributeValue(target.LongName),
    targetElevation: attributeValue(target.Elevation),
    targetPlacementRef: target.ObjectPlacement?.value ?? null,
    action: "storey-metadata-updated",
  };
}

export function applyRepair(model, report, { selectedStoreyIds = null, onProgress } = {}) {
  const actionable = report.proposals.filter(needsAction);
  const effectiveSelection =
    selectedStoreyIds || new Set(selectRepairableProposals(report).map((proposal) => proposal.sourceStoreyId));
  const renameProposals = [];
  const skipped = [];

  for (const proposal of actionable) {
    if (!effectiveSelection.has(proposal.sourceStoreyId)) skipped.push(proposal);
    else renameProposals.push(proposal);
  }

  const renameChanges = renameProposals.map((proposal, index) => {
    const change = planRename(model, proposal);
    onProgress?.({
      stage: "update",
      processed: index + 1,
      total: renameProposals.length,
      detail: `${proposal.sourceBuildingName} · ${proposal.sourceStoreyName}`,
    });
    return change;
  });

  return {
    changes: renameChanges,
    renameChanges,
    mergeChanges: [],
    skipped,
    removedEntities: [],
    storeysUpdated: renameChanges.length,
    elementsAffected: renameChanges.reduce((sum, change) => sum + change.elementCount, 0),
    elementsMoved: 0,
  };
}

/** Builds a complete per-element report while retaining source containment. */
export function buildElementAudit(model, report, result) {
  const audit = [];

  for (const change of result.changes) {
    for (const element of change.elementSnapshots) {
      audit.push({
        elementExpressId: element.id,
        elementGuid: element.guid,
        elementType: element.type,
        elementName: element.name,
        placementRef: element.placementRef,
        fromBuildingName: change.sourceBuildingName,
        fromStoreyId: change.fromStoreyId,
        fromStoreyName: change.fromStoreyName,
        toStoreyId: change.toStoreyId,
        toStoreyName: change.toStoreyName,
        referenceBasis: change.referenceBasis,
        matchingMethod: change.matchingMethod,
        sourceAbsoluteZ: change.sourceAbsoluteZ,
        targetAbsoluteZ: change.targetAbsoluteZ,
        deltaZ: change.deltaZ,
        nameMatchesMaster: change.nameMatchesMaster,
        fflMatchesMaster: change.fflMatchesMaster,
        fflDifferenceMm: change.fflDifferenceMm,
        confidence: change.confidence,
        action: change.action,
      });
    }
  }

  const describeUntouched = (proposal, action) => {
    for (const elementId of proposal.elementIds) {
      const element = elementSnapshot(model, elementId);
      audit.push({
        elementExpressId: element.id,
        elementGuid: element.guid,
        elementType: element.type,
        elementName: element.name,
        placementRef: element.placementRef,
        fromBuildingName: proposal.sourceBuildingName,
        fromStoreyId: proposal.sourceStoreyId,
        fromStoreyName: proposal.sourceStoreyName,
        toStoreyId: proposal.alreadyCorrect ? proposal.targetStoreyId : null,
        toStoreyName: proposal.alreadyCorrect ? proposal.targetStoreyName : null,
        referenceBasis: proposal.referenceBasis,
        matchingMethod: proposal.matchingMethod,
        sourceAbsoluteZ: proposal.sourceAbsoluteZ,
        targetAbsoluteZ: proposal.targetAbsoluteZ ?? null,
        deltaZ: proposal.deltaZ ?? null,
        nameMatchesMaster: proposal.nameMatchesMaster,
        fflMatchesMaster: proposal.fflMatchesMaster,
        fflDifferenceMm: proposal.fflDifferenceMm,
        confidence: proposal.status,
        action,
      });
    }
  };

  for (const proposal of result.skipped) describeUntouched(proposal, "skipped");
  for (const proposal of report.proposals) {
    if (proposal.elementCount === 0) continue;
    if (proposal.alreadyCorrect) describeUntouched(proposal, "already-correct");
    else if (proposal.status === "unmatched") describeUntouched(proposal, "unresolved-unmatched");
    else if (proposal.status === "ambiguous") describeUntouched(proposal, "unresolved-ambiguous");
  }
  return audit;
}

/** Verifies the text-patched output preserves hierarchy and element identity. */
export function validateRepair(model, result) {
  let failure = null;
  for (const change of result.renameChanges) {
    const storey = getLine(model, change.sourceStoreyId);
    if (!storey || storey.GlobalId?.value !== change.sourceStoreyGuid) {
      failure = `Linked storey '${change.fromStoreyName}' no longer has its original identity.`;
      break;
    }
    if (attributeValue(storey.Name) !== change.toStoreyName || attributeValue(storey.LongName) !== change.toLongName) {
      failure = `Linked storey '${change.fromStoreyName}' was not renamed to '${change.toStoreyName}'.`;
      break;
    }
    if ((storey.ObjectPlacement?.value ?? null) !== change.sourcePlacementRef || attributeValue(storey.Elevation) !== change.fromElevation) {
      failure = `Linked storey '${change.toStoreyName}' placement or elevation was modified.`;
      break;
    }
    if (!sameIds(aggregateParents(model, change.sourceStoreyId), change.sourceParentIds)) {
      failure = `Linked storey '${change.toStoreyName}' changed parent building/site hierarchy.`;
      break;
    }
    if (!sameIds(getContainedElements(model, change.sourceStoreyId), change.containedElementIds)) {
      failure = `Products under linked storey '${change.toStoreyName}' changed containment.`;
      break;
    }
    for (const before of change.elementSnapshots) {
      const after = getLine(model, before.id);
      if (!after || after.GlobalId?.value !== before.guid || (after.ObjectPlacement?.value ?? null) !== before.placementRef) {
        failure = `Product ${before.guid || `#${before.id}`} changed identity or placement.`;
        break;
      }
    }
    if (failure) break;
  }

  return [{
    name: "Linked storey renames preserve hierarchy",
    performed: true,
    passed: failure === null,
    detail: failure ?? `${result.renameChanges.length} linked storey name(s) updated; GUID, Elevation, ObjectPlacement, parent hierarchy and containment preserved.`,
  }];
}
