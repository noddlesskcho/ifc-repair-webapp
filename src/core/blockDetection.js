/**
 * Detects how many actual block/tower IfcBuildings a loaded IFC represents,
 * and (for a multi-block project) whether the blocks use IfcBuildingStorey
 * names consistently -- before any storey-name-fixing analysis runs.
 *
 * Raw IfcBuilding count cannot answer "how many blocks": a consultant export
 * can contain hundreds of IfcBuilding entities that are really a shared
 * podium/base, PPVC or typical-unit sub-models, lift/stair/refuse-chute
 * models, or empty spatial shells -- not separate towers. This module
 * identifies the actual block/tower buildings using comparative evidence
 * (storey count, resolved vertical extent, element count) rather than any
 * single signal or a fixed threshold, since a low-rise block is still a
 * genuine block and a large file can have an arbitrary base storey count.
 *
 * Deliberately does NOT use full triangulated mesh geometry (web-ifc's only
 * geometry API, StreamAllMeshes/GetFlatMesh, fully triangulates -- too
 * expensive to run per-building on files with hundreds of megabytes and
 * hundreds of buildings, which this app already has to handle). Every signal
 * here reuses cheap, already-proven placement-chain resolution
 * (GetWorldTransformMatrix, the same call absoluteZ() makes) plus spatial-
 * structure containment counts -- no new IFC parsing.
 *
 * Wrapped end-to-end in a try/catch: any unexpected structure returns
 * "UNKNOWN" rather than throwing or guessing, since a false MULTI_BLOCK (or
 * false SINGLE_BLOCK) result would be worse than asking the user to check
 * manually.
 */
import { WebIFC, absoluteZ, getContainedElements, getDecomposedStoreys, getIdsOfType, getLengthUnitScaleToMM, getLine, guid as guidOf, name as entityName, worldXYZ } from "./ifcModel.js";

/** 0.01 m, expressed in this app's native mm working unit (see getLengthUnitScaleToMM). */
export const FFL_TOLERANCE_MM = 10;

/**
 * Minimum relative drop between consecutive (sorted descending) block scores
 * required to trust a split between "block candidates" and "everything else".
 * A tuning knob for the clustering confidence, not a domain rule like "10
 * storeys" -- kept as a named constant so it can be adjusted without hunting
 * through the algorithm.
 */
export const BLOCK_GAP_CONFIDENCE_RATIO = 0.35;

/** A block-candidate whose own storey count is below this fraction of the cluster's max is podium-eligible. */
const PODIUM_STOREY_RATIO = 0.5;

/** Below this max/min score ratio, treat every building-with-content as a block candidate rather than hunting for a gap. */
const UNIFORM_SPREAD_RATIO = 3;

/**
 * For comparison purposes only -- never used to modify the actual IFC name.
 * Trims, collapses internal whitespace, and lowercases. Deliberately does not
 * strip digits or level identifiers: "03 STOREY" and "04 STOREY" must stay
 * distinct.
 */
export function normalizeStoreyName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function rangesOverlap(aMin, aMax, bMin, bMax) {
  return aMin <= bMax && bMin <= aMax;
}

function buildStoreyProfile(model, storeyId, scaleToMM) {
  const line = getLine(model, storeyId);
  return {
    id: storeyId,
    guid: guidOf(model, storeyId),
    name: line?.Name?.value || "Unnamed",
    normalizedName: normalizeStoreyName(line?.Name?.value),
    authoredElevation: line?.Elevation?.value ?? null,
    resolvedGlobalZ: line?.ObjectPlacement ? absoluteZ(model, line.ObjectPlacement) * scaleToMM : 0,
  };
}

function buildBuildingProfile(model, buildingId, scaleToMM) {
  const line = getLine(model, buildingId);
  const storeyIds = getDecomposedStoreys(model, buildingId);
  const storeys = storeyIds.map((id) => buildStoreyProfile(model, id, scaleToMM));

  let elementCount = getContainedElements(model, buildingId).length;
  for (const id of storeyIds) elementCount += getContainedElements(model, id).length;

  const zs = storeys.map((s) => s.resolvedGlobalZ);
  const zMin = zs.length ? Math.min(...zs) : null;
  const zMax = zs.length ? Math.max(...zs) : null;
  const pos = line?.ObjectPlacement ? worldXYZ(model, line.ObjectPlacement) : { x: 0, y: 0, z: 0 };

  return {
    id: buildingId,
    guid: guidOf(model, buildingId),
    name: entityName(model, buildingId),
    storeyCount: storeys.length,
    storeys,
    elementCount,
    zMin,
    zMax,
    verticalExtent: zMin != null ? zMax - zMin : 0,
    x: pos.x,
    y: pos.y,
    z: pos.z,
  };
}

function scoreOf(profile) {
  // storeyCount x verticalExtent is the primary discriminator (a tower has
  // both many storeys AND a large vertical span; a podium or typical-unit
  // sub-model is short on at least one axis). Element count breaks ties
  // between otherwise-similar candidates without dominating the score on its
  // own, since a busy but short/small building shouldn't outrank a tower.
  return profile.storeyCount * Math.max(profile.verticalExtent, 1) * (1 + Math.log1p(profile.elementCount) / 20);
}

function emptyResult(mode, debugLog, extra = {}) {
  return {
    mode,
    blocks: [],
    baseBuildings: [],
    linkedBuildings: [],
    unclassifiedBuildings: [],
    evidence: debugLog,
    debugLog,
    ...extra,
  };
}

export function detectProjectBlocks(model) {
  const debugLog = [];
  try {
    const scaleToMM = getLengthUnitScaleToMM(model);
    const buildingIds = getIdsOfType(model, WebIFC.IFCBUILDING);
    debugLog.push(`IfcBuilding count: ${buildingIds.length}`);

    if (buildingIds.length === 0) {
      debugLog.push("Detected mode: UNKNOWN (no IfcBuilding found)");
      return emptyResult("UNKNOWN", debugLog);
    }

    const profiles = buildingIds.map((id) => buildBuildingProfile(model, id, scaleToMM));

    const unclassifiedBuildings = profiles.filter((p) => p.elementCount === 0);
    const withContent = profiles.filter((p) => p.elementCount > 0);
    debugLog.push(`Empty (zero-element) buildings: ${unclassifiedBuildings.length}`);

    // A single storey has no internal vertical range at all -- the spec's own
    // "linked/typical model" evidence list is "only 1-3 storeys, small local
    // vertical range", and one storey is the most extreme, unambiguous case
    // of that (not a "block/tower" candidate, which needs "storeys spanning
    // several elevations"). A building this small never enters scoring, even
    // if it happens to hold real elements -- a Revit linked-branch copy
    // commonly does.
    const eligible = withContent.filter((p) => p.storeyCount >= 2);
    const tooSmall = withContent.filter((p) => p.storeyCount < 2);

    if (eligible.length === 0) {
      // Nothing with real content is even eligible. This is the common
      // "master building holds no elements directly -- its real content all
      // lives in linked branches" shape (exactly what this tool's existing
      // storey fixer already exists to repair): fall back to the same
      // structural signal detector.js's own master-building selection uses
      // (most storeys) among the zero-element buildings, rather than
      // reporting UNKNOWN just because nothing *with elements* stood out.
      const masterCandidates = unclassifiedBuildings.filter((p) => p.storeyCount >= 2);
      const maxStoreys = masterCandidates.length ? Math.max(...masterCandidates.map((p) => p.storeyCount)) : 0;
      const winners = masterCandidates.filter((p) => p.storeyCount === maxStoreys);

      if (winners.length === 1) {
        const master = winners[0];
        debugLog.push(
          `No building with elements has >=2 storeys. Building ${master.guid} (#${master.id}) is the sole zero-element ` +
            `building with the most storeys (${master.storeyCount}) -- treated as the structural master -> SINGLE_BLOCK.`
        );
        return {
          mode: "SINGLE_BLOCK",
          blocks: [master],
          baseBuildings: [],
          linkedBuildings: tooSmall,
          unclassifiedBuildings: unclassifiedBuildings.filter((p) => p !== master),
          evidence: debugLog,
          debugLog,
        };
      }

      debugLog.push(
        winners.length > 1
          ? `${winners.length} zero-element buildings tie for the most storeys (${maxStoreys}) -- cannot pick a structural master.`
          : "No building (with or without elements) has >=2 storeys."
      );
      debugLog.push("Detected mode: UNKNOWN (cannot reliably distinguish block buildings)");
      return emptyResult("UNKNOWN", debugLog, { unclassifiedBuildings, linkedBuildings: tooSmall });
    }

    if (eligible.length === 1) {
      const only = eligible[0];
      debugLog.push(`Building ${only.guid} (#${only.id}): only eligible building with content -> SINGLE_BLOCK`);
      return {
        mode: "SINGLE_BLOCK",
        blocks: [only],
        baseBuildings: [],
        linkedBuildings: tooSmall,
        unclassifiedBuildings,
        evidence: debugLog,
        debugLog,
      };
    }

    const scored = eligible
      .map((p) => ({ profile: p, score: scoreOf(p) }))
      .sort((a, b) => b.score - a.score);

    for (const s of scored) {
      debugLog.push(
        `Building ${s.profile.guid} (#${s.profile.id}): ${s.profile.storeyCount} storeys, ` +
          `vertical extent ${Math.round(s.profile.verticalExtent)}mm, ${s.profile.elementCount} element(s), score ${Math.round(s.score)}`
      );
    }

    // A gap only means something when there's a wide spread to split -- with
    // no wide spread at all (e.g. two similarly-sized towers and nothing else
    // in the file), there's no "insignificant" subgroup to separate from, so
    // every building with content is a block candidate by default. Only fall
    // back to hunting for a relative-drop split once the scores actually
    // span a meaningful range; a spread that wide with no confident split is
    // the genuinely ambiguous case (-> UNKNOWN), not a uniform one.
    const spreadRatio = scored[scored.length - 1].score > 0 ? scored[0].score / scored[scored.length - 1].score : Infinity;

    let cluster;
    let rest;
    if (spreadRatio < UNIFORM_SPREAD_RATIO) {
      debugLog.push(
        `Score spread ${spreadRatio.toFixed(2)}x is below the uniform threshold (${UNIFORM_SPREAD_RATIO}x) -- treating all ` +
          `${scored.length} building(s) with content as block candidates.`
      );
      cluster = scored.map((s) => s.profile);
      rest = [];
    } else {
      let splitIndex = -1;
      let bestDrop = 0;
      for (let i = 0; i < scored.length - 1; i++) {
        const drop = (scored[i].score - scored[i + 1].score) / scored[i].score;
        if (drop > bestDrop) {
          bestDrop = drop;
          splitIndex = i;
        }
      }

      if (splitIndex === -1 || bestDrop < BLOCK_GAP_CONFIDENCE_RATIO) {
        debugLog.push(
          `Score spread ${spreadRatio.toFixed(2)}x, but no confident gap found (best relative drop ${(bestDrop * 100).toFixed(1)}%, need >= ${BLOCK_GAP_CONFIDENCE_RATIO * 100}%).`
        );
        debugLog.push("Detected mode: UNKNOWN (cannot reliably distinguish block buildings)");
        return emptyResult("UNKNOWN", debugLog, { unclassifiedBuildings, linkedBuildings: [...eligible, ...tooSmall] });
      }

      debugLog.push(
        `Largest relative score drop ${(bestDrop * 100).toFixed(1)}% after rank ${splitIndex + 1} -- treating the top ` +
          `${splitIndex + 1} building(s) as block candidates.`
      );

      cluster = scored.slice(0, splitIndex + 1).map((s) => s.profile);
      rest = scored.slice(splitIndex + 1).map((s) => s.profile);
    }
    const baseBuildings = [];

    const maxStoreysInCluster = Math.max(...cluster.map((p) => p.storeyCount));
    const survivors = [];
    for (const candidate of cluster) {
      const isShort = candidate.storeyCount < maxStoreysInCluster * PODIUM_STOREY_RATIO;
      const overlapsARealTower = cluster.some(
        (other) =>
          other !== candidate &&
          other.storeyCount >= maxStoreysInCluster * PODIUM_STOREY_RATIO &&
          rangesOverlap(candidate.zMin ?? 0, candidate.zMax ?? 0, other.zMin ?? 0, other.zMax ?? 0)
      );
      if (isShort && overlapsARealTower) {
        debugLog.push(
          `Building ${candidate.guid} (#${candidate.id}): storeyCount ${candidate.storeyCount} is below ` +
            `${PODIUM_STOREY_RATIO * 100}% of cluster max (${maxStoreysInCluster}) and its Z-range overlaps a taller ` +
            "cluster member -- reclassified as base/podium."
        );
        baseBuildings.push(candidate);
      } else {
        survivors.push(candidate);
      }
    }
    cluster = survivors;
    const finalLinked = [...rest, ...tooSmall];

    if (cluster.length === 0) {
      debugLog.push("Detected mode: UNKNOWN (block candidates were all reclassified as base/podium)");
      return emptyResult("UNKNOWN", debugLog, { unclassifiedBuildings, baseBuildings, linkedBuildings: finalLinked });
    }

    if (cluster.length === 1) {
      debugLog.push(`Detected mode: SINGLE_BLOCK (building ${cluster[0].guid})`);
      return {
        mode: "SINGLE_BLOCK",
        blocks: cluster,
        baseBuildings,
        linkedBuildings: finalLinked,
        unclassifiedBuildings,
        evidence: debugLog,
        debugLog,
      };
    }

    debugLog.push(`Detected mode: MULTI_BLOCK (${cluster.length} blocks)`);
    return {
      mode: "MULTI_BLOCK",
      blocks: cluster,
      baseBuildings,
      linkedBuildings: finalLinked,
      unclassifiedBuildings,
      evidence: debugLog,
      debugLog,
    };
  } catch (e) {
    debugLog.push(`Block detection failed unexpectedly: ${e?.message || e}`);
    return emptyResult("UNKNOWN", debugLog);
  }
}

/**
 * Compares IfcBuildingStorey names/resolved FFLs across the actual block
 * buildings returned by detectProjectBlocks() (only meaningful when
 * mode === "MULTI_BLOCK"). The unsafe condition this looks for is
 * specifically: the SAME normalized storey name used at a DIFFERENT resolved
 * global Z across two or more blocks -- not merely "the blocks have
 * different storey lists" (that alone is fine; see Case 3/Case 7 in the
 * spec this implements).
 */
export function compareBlockStoreys(model, blocks) {
  const debugLog = [];
  const blockLabel = (b, i) => b.name && b.name !== "Unnamed" ? b.name : `Block ${i + 1}`;

  const flattened = [];
  blocks.forEach((block, i) => {
    const label = blockLabel(block, i);
    for (const storey of block.storeys) {
      if (!storey.normalizedName) continue;
      flattened.push({ blockId: block.id, blockGuid: block.guid, blockLabel: label, ...storey });
    }
  });

  const byName = new Map();
  for (const entry of flattened) {
    if (!byName.has(entry.normalizedName)) byName.set(entry.normalizedName, []);
    byName.get(entry.normalizedName).push(entry);
  }

  const conflicts = [];
  for (const [normalizedName, entries] of byName) {
    const distinctBlocks = new Set(entries.map((e) => e.blockId));
    if (distinctBlocks.size < 2) continue;

    const sorted = [...entries].sort((a, b) => a.resolvedGlobalZ - b.resolvedGlobalZ);
    const clusters = [];
    for (const entry of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && entry.resolvedGlobalZ - last[last.length - 1].resolvedGlobalZ <= FFL_TOLERANCE_MM) {
        last.push(entry);
      } else {
        clusters.push([entry]);
      }
    }

    if (clusters.length > 1) {
      debugLog.push(
        `Normalized name "${normalizedName}": ${clusters.length} distinct FFL clusters across ${distinctBlocks.size} blocks -- ` +
          `${entries.map((e) => `${e.blockLabel}=${Math.round(e.resolvedGlobalZ)}mm`).join(", ")}`
      );
      conflicts.push({ normalizedName, entries });
    } else {
      debugLog.push(`Normalized name "${normalizedName}": consistent FFL across ${distinctBlocks.size} blocks -- OK.`);
    }
  }

  debugLog.push(conflicts.length === 0 ? "Block storey coordination: PASS" : `Block storey coordination: ${conflicts.length} conflict(s) found`);

  return { pass: conflicts.length === 0, conflicts, debugLog };
}

export { WebIFC };
