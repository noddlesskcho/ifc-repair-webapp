/**
 * Assigns every candidate building (blockDetection's "linked" buildings --
 * small typical-unit/service/fragment IfcBuildings) to the block/tower it
 * most likely physically belongs to, for genuine multi-block projects.
 *
 * Why this exists: detector.js's matching only ever had ONE global "master"
 * building for the whole file. That is unsafe once a file has multiple real
 * towers -- a linked fragment could get matched against the WRONG tower's
 * storey names purely because two towers happen to share an elevation (which
 * is common: coordinated towers in one development usually DO share FFLs).
 * Each detected block must act as its own independent master, matched only
 * against the fragments that actually belong to it.
 *
 * Key empirical finding this design is built on (verified against the real
 * 417-building/3-tower reference file): spatial-container placements and even
 * individual product placement origins can be uninformative. Distinct linked
 * branches at different physical towers can expose identical placement-origin
 * signatures while their rendered geometry is tens of metres apart.
 *
 * Multi-block assignment therefore prefers one streamed geometry pass. It
 * builds a plan perimeter from each real tower's meshes and scores linked
 * branches by how much of their actual geometry lies within each perimeter.
 * A unique, repeated building-placement stack is the high-confidence fallback
 * for an otherwise valid tower whose reference ladder contains no products.
 * Shared or isolated placement origins remain review-only. Z is intentionally
 * excluded from tower identity; it belongs to the later level-matching step
 * and previously caused upper instances of one vertical stack to jump towers.
 */
import { getContainedElements, getLengthUnitScaleToMM, getLine, worldXYZ } from "./ifcModel.js";

/**
 * Every candidate building is ALWAYS assigned to its best-scoring tower --
 * there is no hard "too uncertain, don't assign" gate. Per an explicit
 * product decision: since nothing here is ever auto-repaired without
 * appearing in the reviewable table with an easy per-row change control (see
 * detector.js/reviewView.js), a best-guess assignment the user can override
 * is more useful than silently withholding one. `CONFIDENT_SCORE`/
 * `CONFIDENT_MARGIN` below only control the `confident` flag used to decide
 * how prominently a row should ask for a second look -- they never block an
 * assignment from being made.
 *
 * Tuned against the real 417-building/3-tower reference file: on a
 * well-coordinated multi-block file, the Z/storey-pattern signals score
 * almost identically across towers (expected -- coordinated towers share
 * elevations), so XY alone carries the real discrimination, and its
 * realistic margin between a correct winner and the runner-up tower is
 * modest (~5-15 points out of the ~90-point practical scale: 55 XY + 10
 * Z-overlap + 10 storey-pattern + 5 same-site), not the 30-40+ a naive
 * "just pick the highest score" read might expect. A large share of
 * candidates in that file score within a few points of a second tower --
 * genuinely close calls, not a scoring bug (verified by inspecting raw
 * distances directly) -- so expect a meaningful fraction of `confident:
 * false` rows on a file shaped like that one; that's expected, not an error.
 */
export const CONFIDENT_SCORE = 35;
export const CONFIDENT_MARGIN = 6;

/**
 * Minimum placement-vote margin used only by the geometry-less fallback.
 * A near-even placement split is never promoted to a confident result.
 */
const XY_CONFIDENT_MARGIN = 5;

/** Building placements within this distance are treated as the same exported instance origin. */
export const PLACEMENT_STACK_TOLERANCE_MM = 150;

/** One coincident building can be accidental; two repeated instances establish a vertical stack. */
const MIN_PLACEMENT_STACK_SUPPORT = 2;

// Tower identity is independent of tolerance and manual storey overrides, so
// keep the expensive mesh result for the lifetime of an opened model.
const assignmentCache = new WeakMap();

function cacheKey(blockResult) {
  const ids = (items) => items.map((item) => item.id).sort((a, b) => a - b).join(",");
  return `${ids(blockResult.blocks)}|${ids(blockResult.linkedBuildings)}|${ids(blockResult.unclassifiedBuildings)}`;
}

/**
 * Elements sampled per tower to build its XY envelope/centroid -- bounded so
 * this stays cheap regardless of file size (still placement lookups only,
 * no mesh geometry). Verified against the real reference file that a low
 * cap (200) sampled almost entirely from a single early storey, producing an
 * envelope far smaller than the tower's true footprint (23x18m vs. a real
 * ~35x30m once the full ~700-800 elements per tower are sampled) -- which
 * matters because building-level containment checks against that envelope
 * are only meaningful if the envelope is actually representative.
 */
export const TOWER_ELEMENT_SAMPLE_SIZE = 5000;

/**
 * An element whose resolved world XY lands within this many mm of its own
 * building's origin is excluded from that tower's envelope -- verified
 * against a real reference file that some elements carry no real per-element
 * placement offset at all and simply inherit their (uninformative) container
 * origin, which would otherwise drag the whole tower's centroid toward that
 * shared point and destroy separation between towers.
 */
const ORIGIN_ECHO_EPSILON_MM = 1;

/**
 * web-ifc's streamed render geometry is Y-up, so the plan plane is X/Z.
 * Geometry values may be in a different unit from the detector's millimetre
 * working values, but every footprint in one model uses the same unit and is
 * only compared with other footprints from that model.
 */
const GEOMETRY_POINT_EPSILON = 1e-9;
const GEOMETRY_CONFIDENT_INSIDE_RATIO = 0.8;
const GEOMETRY_CONFIDENT_INSIDE_MARGIN = 0.25;
const GEOMETRY_CONFIDENT_SCORE_MARGIN = 10;

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Monotone-chain convex hull. Points are plan-space {x, y}, where y is render Z. */
function convexHull(points) {
  const sorted = [...points]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((p, i, all) => i === 0 || Math.abs(p.x - all[i - 1].x) > GEOMETRY_POINT_EPSILON || Math.abs(p.y - all[i - 1].y) > GEOMETRY_POINT_EPSILON);
  if (sorted.length <= 2) return sorted;

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function pointInPolygon(point, polygon) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = (a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToPolygon(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;
  if (polygon.length === 0) return Infinity;
  if (polygon.length === 1) return Math.hypot(point.x - polygon[0].x, point.y - polygon[0].y);
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) best = Math.min(best, pointSegmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]));
  return best;
}

function newGeometryProfile() {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    elementCenters: [],
    perimeterPoints: [],
    meshCount: 0,
    hull: null,
  };
}

function updateProfileBounds(profile, x, y) {
  profile.minX = Math.min(profile.minX, x);
  profile.maxX = Math.max(profile.maxX, x);
  profile.minY = Math.min(profile.minY, y);
  profile.maxY = Math.max(profile.maxY, y);
}

/**
 * Streams geometry once and builds actual plan footprints for every tower and
 * candidate. This deliberately keys products by spatial containment only;
 * geometry is read, never mutated.
 */
function buildGeometryProfiles(model, buildings) {
  const buildingByElement = new Map();
  const profiles = new Map(buildings.map((b) => [b.id, newGeometryProfile()]));
  for (const building of buildings) {
    for (const elementId of candidateElementIds(model, building)) {
      if (!buildingByElement.has(elementId)) buildingByElement.set(elementId, building.id);
    }
  }

  let skippedMeshCount = 0;
  try {
    model.api.StreamAllMeshes(model.modelID, (mesh) => {
      const buildingId = buildingByElement.get(mesh.expressID);
      if (buildingId == null) return;
      const profile = profiles.get(buildingId);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      try {
        for (let i = 0; i < mesh.geometries.size(); i++) {
          const placed = mesh.geometries.get(i);
          let geometry = null;
          try {
            geometry = model.api.GetGeometry(model.modelID, placed.geometryExpressID);
            const vertices = model.api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const t = placed.flatTransformation;
            for (let j = 0; j < vertices.length; j += 6) {
              const vx = vertices[j];
              const vy = vertices[j + 1];
              const vz = vertices[j + 2];
              const x = t[0] * vx + t[4] * vy + t[8] * vz + t[12];
              const planY = t[2] * vx + t[6] * vy + t[10] * vz + t[14];
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
              minY = Math.min(minY, planY);
              maxY = Math.max(maxY, planY);
            }
          } finally {
            geometry?.delete?.();
          }
        }
      } catch {
        skippedMeshCount++;
        return;
      }

      if (!Number.isFinite(minX)) return;
      const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      profile.elementCenters.push(center);
      profile.perimeterPoints.push(
        { x: minX, y: minY },
        { x: minX, y: maxY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY }
      );
      updateProfileBounds(profile, minX, minY);
      updateProfileBounds(profile, maxX, maxY);
      profile.meshCount++;
    });
  } catch (error) {
    throw new Error(`IFC geometry could not be read for tower assignment: ${error?.message || String(error)}`);
  }

  for (const [buildingId, profile] of profiles) {
    if (profile.meshCount === 0) {
      profiles.delete(buildingId);
      continue;
    }
    profile.hull = convexHull(profile.perimeterPoints);
  }
  return { profiles, skippedMeshCount };
}

function boxOverlapRatio(candidate, tower) {
  const width = Math.max(candidate.maxX - candidate.minX, GEOMETRY_POINT_EPSILON);
  const height = Math.max(candidate.maxY - candidate.minY, GEOMETRY_POINT_EPSILON);
  const overlapX = Math.max(0, Math.min(candidate.maxX, tower.maxX) - Math.max(candidate.minX, tower.minX));
  const overlapY = Math.max(0, Math.min(candidate.maxY, tower.maxY) - Math.max(candidate.minY, tower.minY));
  return (overlapX * overlapY) / (width * height);
}

function geometryTowerScores(building, blocks, profiles) {
  const candidate = profiles.get(building.id);
  if (!candidate?.elementCenters.length) return { scores: null, missingTowerIds: [] };

  const scores = [];
  const missingTowerIds = [];
  for (const block of blocks) {
    const tower = profiles.get(block.id);
    if (!tower?.hull?.length) {
      missingTowerIds.push(block.id);
      continue;
    }
    let inside = 0;
    let distanceTotal = 0;
    for (const point of candidate.elementCenters) {
      const distance = distanceToPolygon(point, tower.hull);
      if (distance === 0) inside++;
      distanceTotal += distance;
    }
    const insideRatio = inside / candidate.elementCenters.length;
    const overlapRatio = boxOverlapRatio(candidate, tower);
    const meanDistance = distanceTotal / candidate.elementCenters.length;
    const score = 70 * insideRatio + 25 * overlapRatio + 5 / (1 + meanDistance);
    scores.push({ blockId: block.id, blockGuid: block.guid, score, insideRatio, overlapRatio, meanDistance });
  }
  return { scores: scores.sort((a, b) => b.score - a.score), missingTowerIds };
}

/** Placement-origin envelope retained only for the geometry-less fallback. */
function buildTowerEnvelope(model, block) {
  const elementIds = [];
  for (const storey of block.storeys) elementIds.push(...getContainedElements(model, storey.id));

  const points = [];
  for (const id of elementIds) {
    const line = getLine(model, id);
    if (!line?.ObjectPlacement) continue;
    const { x, y } = worldXYZ(model, line.ObjectPlacement);
    // Skip elements that carry no real per-element offset at all (see
    // ORIGIN_ECHO_EPSILON_MM doc) -- keeping them would drag the centroid
    // toward the tower's own uninformative container origin.
    if (block.x != null && Math.abs(x - block.x) < ORIGIN_ECHO_EPSILON_MM && Math.abs(y - block.y) < ORIGIN_ECHO_EPSILON_MM) continue;
    points.push({ x, y });
    if (points.length >= TOWER_ELEMENT_SAMPLE_SIZE) break;
  }
  if (points.length === 0) return null;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    centroidX: xs.reduce((a, b) => a + b, 0) / xs.length,
    centroidY: ys.reduce((a, b) => a + b, 0) / ys.length,
    sampleSize: points.length,
  };
}

function distanceToEnvelope(x, y, env) {
  const dx = Math.max(env.minX - x, 0, x - env.maxX);
  const dy = Math.max(env.minY - y, 0, y - env.maxY);
  return Math.hypot(dx, dy); // 0 when (x,y) falls inside the envelope
}

/**
 * A candidate's own element IDs (building-level containment plus every one
 * of its storeys' containment) -- the same shape buildTowerEnvelope() reads
 * for a tower, just scoped to one small candidate building instead of a
 * whole tower's storey list.
 */
function candidateElementIds(model, building) {
  const ids = getContainedElements(model, building.id);
  for (const storey of building.storeys) ids.push(...getContainedElements(model, storey.id));
  return ids;
}

/**
 * 0-55: per-element majority vote, not a single centroid-distance score.
 * Every one of the candidate's own elements with a resolvable placement
 * votes for whichever tower's envelope it is nearest to (0 distance if
 * inside); the score is each tower's share of that vote, scaled to 55.
 *
 * Replaced an earlier version of this signal that reduced a candidate down
 * to ONE mean (x,y) point first and scored that point's distance to each
 * envelope. Verified directly against the real reference file that the mean
 * point is a materially worse ground-truth proxy than the vote share:
 * several candidate buildings straddle the boundary between two towers'
 * envelopes (typical-unit/service buildings sitting between towers, or
 * whose two storeys resolve to slightly different physical spots), and for
 * those the mean point's distance ranking can flip to the WRONG tower --
 * including cases that scored as confidently wrong -- even though a
 * majority (in one observed case, 100%) of the building's own elements
 * individually land inside the correct tower's envelope. Per-element voting
 * doesn't have that failure mode, and its vote share also happens to double
 * as a much more honest confidence signal (a near-50/50 split IS genuine
 * ambiguity, not an artifact of how one mean point's distance compares
 * across boxes).
 */
function xyVoteScores(model, building, envelopes) {
  const known = envelopes.map((env, i) => ({ i, env })).filter((e) => e.env);
  const votes = envelopes.map(() => 0);
  if (known.length === 0) return votes;

  let total = 0;
  for (const id of candidateElementIds(model, building)) {
    const line = getLine(model, id);
    if (!line?.ObjectPlacement) continue;
    const { x, y } = worldXYZ(model, line.ObjectPlacement);
    let bestI = -1;
    let bestD = Infinity;
    for (const { i, env } of known) {
      const d = distanceToEnvelope(x, y, env);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI >= 0) {
      votes[bestI]++;
      total++;
    }
    if (total >= TOWER_ELEMENT_SAMPLE_SIZE) break;
  }
  if (total > 0) return votes.map((v) => 55 * (v / total));
  // None of this candidate's own elements carry a resolvable placement at
  // all (rare in real Revit exports, but happens in minimal/synthetic
  // files) -- fall back to the candidate's own building-level placement
  // rather than returning zero signal for every tower, since a tie on
  // Z/storey-pattern alone would otherwise make an otherwise-unambiguous
  // case look unresolvable.
  return xyFallbackFromBuildingPlacement(building, known, envelopes);
}

/** Last-resort XY signal when a candidate has no per-element placement to sample -- see xyVoteScores(). */
function xyFallbackFromBuildingPlacement(building, known, envelopes) {
  if (building.x == null) return envelopes.map(() => 0);
  const distances = known.map(({ i, env }) => ({ i, d: distanceToEnvelope(building.x, building.y, env) }));
  const epsilon = 500; // mm, avoids a division blow-up for a point essentially on top of a tower's envelope
  const inverses = distances.map((d) => 1 / (d.d + epsilon));
  const sumInverse = inverses.reduce((a, b) => a + b, 0);
  const scores = envelopes.map(() => 0);
  distances.forEach((d, idx) => {
    const share = sumInverse > 0 ? inverses[idx] / sumInverse : 1 / distances.length;
    scores[d.i] = Math.min(55, 50 * share + (d.d === 0 ? 5 : 0));
  });
  return scores;
}

/**
 * Scores every block from the candidate building's own resolved placement.
 * This is independent of tower product envelopes, so it remains available
 * when a legitimate reference-ladder building contains no products. An
 * exact match is only trusted later when it is unique and repeated by a
 * second candidate; otherwise these scores remain a reviewable best guess.
 */
function buildingPlacementEvidence(building, blocks, scaleToMM) {
  if (building.x == null || building.y == null) {
    return { scores: blocks.map((block) => ({ blockId: block.id, blockGuid: block.guid, score: 0 })), uniqueExactBlockId: null };
  }

  const distances = blocks.map((block) => ({
    blockId: block.id,
    blockGuid: block.guid,
    distanceMm:
      block.x == null || block.y == null
        ? Infinity
        : Math.hypot(building.x - block.x, building.y - block.y) * scaleToMM,
  }));
  const exact = distances.filter((entry) => entry.distanceMm <= PLACEMENT_STACK_TOLERANCE_MM);
  const finite = distances.filter((entry) => Number.isFinite(entry.distanceMm));
  const inverse = finite.map((entry) => 1 / (entry.distanceMm + 500));
  const sumInverse = inverse.reduce((sum, value) => sum + value, 0);
  const scoreById = new Map();
  finite.forEach((entry, index) => {
    const share = sumInverse > 0 ? inverse[index] / sumInverse : 1 / Math.max(finite.length, 1);
    scoreById.set(entry.blockId, Math.min(100, 55 * share + (entry.distanceMm <= PLACEMENT_STACK_TOLERANCE_MM ? 45 : 0)));
  });
  const scores = distances
    .map((entry) => ({ ...entry, score: scoreById.get(entry.blockId) || 0 }))
    .sort((a, b) => b.score - a.score);
  return { scores, uniqueExactBlockId: exact.length === 1 ? exact[0].blockId : null };
}

function scoreMargin(scores) {
  return (scores[0]?.score || 0) - (scores[1]?.score || 0);
}

/**
 * @param {object} model - opened ifcModel.js model handle
 * @param {object} blockResult - detectProjectBlocks() result (must be MULTI_BLOCK)
 * @returns {{
 *   towerGroups: Array<{ block: object, envelope: object|null, linkedBuildingIds: number[] }>,
 *   assignments: Map<number, { blockId: number, blockGuid: string, score: number, margin: number, confident: boolean, candidates: Array<{blockId:number, blockGuid:string, score:number}> }>,
 * }}
 */
export function buildTowerAssignments(model, blockResult) {
  const key = cacheKey(blockResult);
  const cached = assignmentCache.get(model);
  if (cached?.key === key) return cached.value;

  const blocks = blockResult.blocks;
  const envelopes = blocks.map((block) => buildTowerEnvelope(model, block));

  const towerGroups = blocks.map((block, i) => ({ block, envelope: envelopes[i], linkedBuildingIds: [] }));
  const assignments = new Map();

  const candidates = [...blockResult.linkedBuildings, ...blockResult.unclassifiedBuildings];
  const scaleToMM = getLengthUnitScaleToMM(model);
  const placementEvidence = new Map(candidates.map((building) => [building.id, buildingPlacementEvidence(building, blocks, scaleToMM)]));
  const placementStackSupport = new Map();
  for (const evidence of placementEvidence.values()) {
    if (evidence.uniqueExactBlockId == null) continue;
    placementStackSupport.set(evidence.uniqueExactBlockId, (placementStackSupport.get(evidence.uniqueExactBlockId) || 0) + 1);
  }
  const { profiles: geometryProfiles, skippedMeshCount } = buildGeometryProfiles(model, [...blocks, ...candidates]);
  const warnings = [];
  if (skippedMeshCount > 0) {
    warnings.push(
      `${skippedMeshCount} product mesh(es) could not be read. Tower assignments are marked for review because their footprints may be incomplete.`
    );
  }
  const missingTowerIds = blocks.filter((block) => !geometryProfiles.get(block.id)?.hull?.length).map((block) => block.id);
  if (missingTowerIds.length > 0) {
    warnings.push(
      `${missingTowerIds.length} master tower(s) had no readable product geometry. Unique repeated placement stacks are used where available; ambiguous assignments require review.`
    );
  }
  for (const building of candidates) {
    const geometryResult = geometryTowerScores(building, blocks, geometryProfiles);
    const geometryScores = geometryResult.scores;
    const placement = placementEvidence.get(building.id);
    const hasSupportedPlacementStack =
      placement.uniqueExactBlockId != null &&
      (placementStackSupport.get(placement.uniqueExactBlockId) || 0) >= MIN_PLACEMENT_STACK_SUPPORT;
    let scores;
    let confident;
    let method;

    if (geometryScores?.length && geometryResult.missingTowerIds.length === 0) {
      scores = geometryScores;
      const bestGeometry = scores[0];
      const secondGeometry = scores[1] ?? { score: 0, insideRatio: 0 };
      const scoreMargin = bestGeometry.score - secondGeometry.score;
      const insideMargin = bestGeometry.insideRatio - secondGeometry.insideRatio;
      confident =
        bestGeometry.insideRatio >= GEOMETRY_CONFIDENT_INSIDE_RATIO &&
        insideMargin >= GEOMETRY_CONFIDENT_INSIDE_MARGIN &&
        scoreMargin >= GEOMETRY_CONFIDENT_SCORE_MARGIN;
      method = "geometry-footprint";
    } else if (hasSupportedPlacementStack) {
      scores = placement.scores;
      confident = true;
      method = "placement-stack";
    } else {
      // Geometry-less shells are uncommon but valid. Retain a placement-only
      // best guess for review; vertical evidence is deliberately excluded so
      // a higher instance of the same component cannot jump towers.
      const xy = xyVoteScores(model, building, envelopes);
      const sortedXy = [...xy].sort((a, b) => b - a);
      const xyMargin = (sortedXy[0] ?? 0) - (sortedXy[1] ?? 0);
      const envelopeScores = blocks
        .map((block, i) => ({ blockId: block.id, blockGuid: block.guid, score: xy[i] }))
        .sort((a, b) => b.score - a.score);
      // When any tower lacks an envelope, envelope voting cannot fairly
      // compare every candidate. Use all-anchor building placements instead.
      // Otherwise keep whichever placement signal has the clearer margin.
      scores =
        missingTowerIds.length > 0 || scoreMargin(placement.scores) > scoreMargin(envelopeScores)
          ? placement.scores
          : envelopeScores;
      const fallbackBest = scores[0];
      const fallbackSecond = scores[1] ?? { score: 0 };
      const fallbackMargin = fallbackBest.score - fallbackSecond.score;
      confident =
        missingTowerIds.length === 0 &&
        skippedMeshCount === 0 &&
        fallbackBest.score >= CONFIDENT_SCORE &&
        fallbackMargin >= CONFIDENT_MARGIN &&
        xyMargin >= XY_CONFIDENT_MARGIN;
      method = "placement-fallback";
    }

    const best = scores[0];
    const secondBest = scores[1] ?? { score: 0 };
    const margin = best.score - secondBest.score;

    towerGroups.find((g) => g.block.id === best.blockId).linkedBuildingIds.push(building.id);
    assignments.set(building.id, {
      blockId: best.blockId,
      blockGuid: best.blockGuid,
      score: best.score,
      margin,
      confident,
      method,
      candidates: scores,
    });
  }

  const value = { towerGroups, assignments, warnings };
  assignmentCache.set(model, { key, value });
  return value;
}
