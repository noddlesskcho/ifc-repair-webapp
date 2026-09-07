/**
 * Detects how a Revit federated (linked-model) export was structured, before
 * any storey-name-fixing analysis runs.
 *
 * Revit's "Export linked files" option has two settings that produce very
 * different IFC spatial hierarchies for the exact same linked-model content:
 *
 *   "Same IFCSite"    -- every linked building (and the host/master
 *                         building) is aggregated under ONE shared IfcSite:
 *
 *                           IfcProject
 *                             IfcSite
 *                               IfcBuilding (host)
 *                               IfcBuilding (linked)
 *                               IfcBuilding (linked)
 *                               ...
 *
 *   "Same IFCProject"  -- each building (host and every linked instance)
 *                         gets its OWN distinct IfcSite, all siblings under
 *                         the project:
 *
 *                           IfcProject
 *                             IfcSite -> IfcBuilding (host)
 *                             IfcSite -> IfcBuilding (linked)
 *                             IfcSite -> IfcBuilding (linked)
 *                             ...
 *
 * This tool's storey-name-fixing workflow assumes the first shape. Rather
 * than trying to special-case the second shape further, the product
 * decision (see the workflow that calls this) is to detect it up front and
 * ask the user to re-export with "Same IFCSite" instead.
 *
 * Detection is based on the actual IfcRelAggregates graph -- which IfcSite
 * is each IfcBuilding's *direct* aggregate parent -- never on raw entity
 * counts alone. A file can legitimately contain extra IfcSite entities that
 * have no building under them at all (unrelated/leftover); those must not
 * cause a false "federated" classification. Wrapped end-to-end in a
 * try/catch: any unexpected structure returns "UNKNOWN" rather than
 * throwing, since this check must never crash the load flow.
 */
import { WebIFC, aggregateParentOf, getIdsOfType, getLine, guid as guidOf } from "./ifcModel.js";

/**
 * @param {object} model - an opened ifcModel.js model handle
 * @returns {{
 *   mode: "SAME_IFCPROJECT" | "SAME_IFCSITE" | "UNKNOWN",
 *   projectCount: number,
 *   siteCount: number,
 *   buildingCount: number,
 *   relevantSiteCount: number,
 *   unresolvedBuildingCount: number,
 *   siteBuildingMap: Array<{siteId: number, siteGuid: string, siteName: string, buildingIds: number[], buildingGuids: string[]}>,
 *   debugLog: string[],
 * }}
 */
export function detectFederatedExportStructure(model) {
  const debugLog = [];
  try {
    const projectIds = getIdsOfType(model, WebIFC.IFCPROJECT);
    const siteIds = getIdsOfType(model, WebIFC.IFCSITE);
    const buildingIds = getIdsOfType(model, WebIFC.IFCBUILDING);

    debugLog.push(`IfcProject count: ${projectIds.length}`);
    debugLog.push(`IfcSite count: ${siteIds.length}`);
    debugLog.push(`IfcBuilding count: ${buildingIds.length}`);

    const empty = (mode) => ({
      mode,
      projectCount: projectIds.length,
      siteCount: siteIds.length,
      buildingCount: buildingIds.length,
      relevantSiteCount: 0,
      unresolvedBuildingCount: 0,
      siteBuildingMap: [],
      debugLog,
    });

    // A well-formed federated export always has exactly one IfcProject.
    // Anything else is too unusual to classify confidently.
    if (projectIds.length !== 1) {
      debugLog.push("Detected mode: UNKNOWN (expected exactly one IfcProject)");
      return empty("UNKNOWN");
    }

    // Nothing to federate: the existing per-building/per-storey workflow
    // already handles "just one building" correctly on its own, and a
    // single building can never exhibit the duplicate-site pattern this
    // check exists to catch.
    if (buildingIds.length <= 1) {
      debugLog.push("Detected mode: SAME_IFCSITE (0 or 1 IfcBuilding -- nothing to federate)");
      return empty("SAME_IFCSITE");
    }

    // Each building's DIRECT aggregate parent -- the canonical chain is
    // IfcProject -> IfcRelAggregates -> IfcSite -> IfcRelAggregates ->
    // IfcBuilding, so the parent one hop up from a building should be a
    // site. A building whose direct parent isn't a site at all (unusual
    // nesting) is counted as unresolved, not silently attributed to
    // whichever site is closest.
    const buildingsBySite = new Map();
    let unresolvedBuildingCount = 0;
    for (const buildingId of buildingIds) {
      const parentId = aggregateParentOf(model, buildingId);
      const parentLine = parentId != null ? getLine(model, parentId) : null;
      if (parentLine?.type === WebIFC.IFCSITE) {
        if (!buildingsBySite.has(parentId)) buildingsBySite.set(parentId, []);
        buildingsBySite.get(parentId).push(buildingId);
      } else {
        unresolvedBuildingCount++;
      }
    }

    const siteBuildingMap = [...buildingsBySite.entries()].map(([siteId, ids]) => ({
      siteId,
      siteGuid: guidOf(model, siteId),
      siteName: getLine(model, siteId)?.Name?.value || "Unnamed",
      buildingIds: ids,
      buildingGuids: ids.map((id) => guidOf(model, id)),
    }));

    for (const entry of siteBuildingMap) {
      debugLog.push(`Site ${entry.siteGuid} (#${entry.siteId}) "${entry.siteName}":`);
      for (let i = 0; i < entry.buildingIds.length; i++) {
        debugLog.push(`    Building ${entry.buildingGuids[i]} (#${entry.buildingIds[i]})`);
      }
    }
    if (unresolvedBuildingCount > 0) {
      debugLog.push(`${unresolvedBuildingCount} building(s) have no direct parent IfcSite (unusual nesting).`);
    }

    const relevantSiteCount = siteBuildingMap.length;

    // "Relevant" sites are only ever ones that directly parent at least one
    // building -- an unrelated, building-less IfcSite elsewhere in the file
    // must never inflate this count (see the "extra unrelated sites" test).
    let mode;
    if (relevantSiteCount === 0) {
      // No building could be resolved to any site at all -- too unusual to
      // trust either way.
      mode = "UNKNOWN";
    } else if (relevantSiteCount === 1) {
      mode = "SAME_IFCSITE";
    } else {
      mode = "SAME_IFCPROJECT";
    }

    debugLog.push(`Detected mode: ${mode}`);

    return {
      mode,
      projectCount: projectIds.length,
      siteCount: siteIds.length,
      buildingCount: buildingIds.length,
      relevantSiteCount,
      unresolvedBuildingCount,
      siteBuildingMap,
      debugLog,
    };
  } catch (e) {
    debugLog.push(`Detection failed unexpectedly: ${e?.message || e}`);
    return {
      mode: "UNKNOWN",
      projectCount: 0,
      siteCount: 0,
      buildingCount: 0,
      relevantSiteCount: 0,
      unresolvedBuildingCount: 0,
      siteBuildingMap: [],
      debugLog,
    };
  }
}
