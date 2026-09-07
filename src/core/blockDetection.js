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
 * (storey count, resolved vertical extent, element count, and a small
 * progressive-name-pattern bonus) rather than any single signal or a fixed
 * threshold, since a low-rise block is still a genuine block, a valid master
 * ladder may contain no products itself, and a large file can have an
 * arbitrary base storey count.
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

/** Below this max/min score ratio, treat every eligible reference ladder as a block candidate rather than hunting for a gap. */
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
  const pos = line?.ObjectPlacement ? worldXYZ(model, line.ObjectPlacement) : null;

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
    x: pos?.x ?? null,
    y: pos?.y ?? null,
    z: pos?.z ?? null,
  };
}

/**
 * A deliberately small supporting signal for reference-storey ladders.
 * Names never identify a block on their own: this only distinguishes a
 * progressive sequence such as 1st/2nd/3rd Storey from repeated linked-file
 * labels such as Base Level/Top Level after structural scoring has already
 * established storey count and vertical extent.
 */
function storeyNameLadderStrength(profile) {
  if (profile.storeys.length < 3) return 0;
  const ordered = [...profile.storeys].sort((a, b) => a.resolvedGlobalZ - b.resolvedGlobalZ);
  const numbers = ordered.map((storey) => {
    const match = storey.normalizedName.match(/(?:^|\D)(\d+)(?:st|nd|rd|th)?(?:\D|$)/i);
    return match ? Number(match[1]) : null;
  });
  const numeric = numbers.filter(Number.isFinite);
  if (numeric.length >= Math.ceil(ordered.length * 0.6)) {
    let progressive = true;
    for (let i = 1; i < numeric.length; i++) {
      if (numeric[i] <= numeric[i - 1]) {
        progressive = false;
        break;
      }
    }
    if (progressive) return 1;
  }

  // Non-numeric ladders (Ground/Mezzanine/Roof, for example) still provide
  // weak evidence when most labels are distinct, but only half the bonus.
  const uniqueRatio = new Set(ordered.map((storey) => storey.normalizedName).filter(Boolean)).size / ordered.length;
  return uniqueRatio >= 0.8 ? 0.5 : 0;
}

function scoreOf(profile) {
  // storeyCount x verticalExtent is the primary discriminator (a tower has
  // both many storeys AND a large vertical span; a podium or typical-unit
  // sub-model is short on at least one axis). Element count breaks ties
  // between otherwise-similar candidates without dominating the score on its
  // own, since a busy but short/small building shouldn't outrank a tower.
  const structural = profile.storeyCount * Math.max(profile.verticalExtent, 1) * (1 + Math.log1p(profile.elementCount) / 20);
  return structural * (1 + 0.1 * storeyNameLadderStrength(profile));
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

    const emptyBuildings = profiles.filter((p) => p.elementCount === 0);
    const withContent = profiles.filter((p) => p.elementCount > 0);
    debugLog.push(`Empty (zero-element) buildings: ${emptyBuildings.length}`);

    // A single storey has no internal vertical range at all -- the spec's own
    // "linked/typical model" evidence list is "only 1-3 storeys, small local
    // vertical range", and one storey is the most extreme, unambiguous case
    // of that (not a "block/tower" candidate, which needs "storeys spanning
    // several elevations"). Buildings with two or more storeys enter the
    // comparative scoring regardless of product count: Revit can export a
    // real block's storey ladder as an empty IfcBuilding while its products
    // live entirely in sibling linked-instance buildings.
    const eligible = profiles.filter((p) => p.storeyCount >= 2);
    const tooSmallLinked = withContent.filter((p) => p.storeyCount < 2);
    const tooSmallUnclassified = emptyBuildings.filter((p) => p.storeyCount < 2);

    if (eligible.length === 0) {
      // A genuinely single-building, single-storey file is still a valid
      // SINGLE_BLOCK model. With several shallow buildings there is no
      // defensible reference ladder, so stop instead of guessing.
      if (profiles.length === 1) {
        const master = profiles[0];
        debugLog.push(
          `Building ${master.guid} (#${master.id}) is the only building; its shallow storey structure is treated as SINGLE_BLOCK.`
        );
        return {
          mode: "SINGLE_BLOCK",
          blocks: [master],
          baseBuildings: [],
          linkedBuildings: [],
          unclassifiedBuildings: [],
          evidence: debugLog,
          debugLog,
        };
      }

      debugLog.push("No building has two or more storeys; no reference ladder can be identified.");
      debugLog.push("Detected mode: UNKNOWN (cannot reliably distinguish block buildings)");
      return emptyResult("UNKNOWN", debugLog, { unclassifiedBuildings: tooSmallUnclassified, linkedBuildings: tooSmallLinked });
    }

    if (eligible.length === 1) {
      const only = eligible[0];
      debugLog.push(`Building ${only.guid} (#${only.id}): only building with a reference-storey ladder -> SINGLE_BLOCK`);
      return {
        mode: "SINGLE_BLOCK",
        blocks: [only],
        baseBuildings: [],
        linkedBuildings: tooSmallLinked,
        unclassifiedBuildings: tooSmallUnclassified,
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
    // every eligible reference ladder is a block candidate by default. Only fall
    // back to hunting for a relative-drop split once the scores actually
    // span a meaningful range; a spread that wide with no confident split is
    // the genuinely ambiguous case (-> UNKNOWN), not a uniform one.
    const spreadRatio = scored[scored.length - 1].score > 0 ? scored[0].score / scored[scored.length - 1].score : Infinity;

    let cluster;
    let rest;
    if (spreadRatio < UNIFORM_SPREAD_RATIO) {
      debugLog.push(
        `Score spread ${spreadRatio.toFixed(2)}x is below the uniform threshold (${UNIFORM_SPREAD_RATIO}x) -- treating all ` +
          `${scored.length} building(s) with reference ladders as block candidates.`
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
        return emptyResult("UNKNOWN", debugLog, {
          unclassifiedBuildings: [...eligible.filter((p) => p.elementCount === 0), ...tooSmallUnclassified],
          linkedBuildings: [...eligible.filter((p) => p.elementCount > 0), ...tooSmallLinked],
        });
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
    // Keep roles disjoint. Empty non-anchor shells remain visible for report
    // and assignment diagnostics, but are never described as linked product
    // buildings merely because they lost the comparative score split.
    const finalLinked = [...rest.filter((p) => p.elementCount > 0), ...tooSmallLinked];
    const finalUnclassified = [...rest.filter((p) => p.elementCount === 0), ...tooSmallUnclassified];

    if (cluster.length === 0) {
      debugLog.push("Detected mode: UNKNOWN (block candidates were all reclassified as base/podium)");
      return emptyResult("UNKNOWN", debugLog, { unclassifiedBuildings: finalUnclassified, baseBuildings, linkedBuildings: finalLinked });
    }

    if (cluster.length === 1) {
      debugLog.push(`Detected mode: SINGLE_BLOCK (building ${cluster[0].guid})`);
      return {
        mode: "SINGLE_BLOCK",
        blocks: cluster,
        baseBuildings,
        linkedBuildings: finalLinked,
        unclassifiedBuildings: finalUnclassified,
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
      unclassifiedBuildings: finalUnclassified,
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
