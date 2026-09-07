/**
 * Thin wrapper around web-ifc's IfcAPI: opening/saving models and a handful
 * of generic spatial-structure helpers used by detector.js and repairer.js.
 *
 * Everything here operates on raw express IDs, never on flattened/deep-copied
 * line objects, so writes (WriteLine/DeleteLine) stay cheap and precise --
 * exactly mirroring how the Python/IfcOpenShell version only ever touches
 * IfcRelContainedInSpatialStructure, never geometry or other attributes.
 */
import * as WebIFC from "web-ifc";

const REF = 5; // web-ifc's internal "this attribute is a reference handle" type tag

/**
 * @param {string} [wasmBaseUrl] - MUST be a fully-resolved absolute URL (not
 *   a bare relative path like "./"). A relative path resolves against
 *   whatever script happens to be evaluating it -- fine on the main thread,
 *   but wrong inside a Worker, which resolves relative to its own script
 *   URL, not the page's. Callers should compute
 *   `new URL(import.meta.env.BASE_URL, location.href).href` once and reuse
 *   that same absolute string everywhere (main thread and worker alike).
 */
export async function createIfcApi(wasmBaseUrl) {
  const api = new WebIFC.IfcAPI();
  if (wasmBaseUrl) {
    api.SetWasmPath(wasmBaseUrl, true);
  }
  await api.Init();
  return api;
}

export function openModel(api, arrayBuffer) {
  const modelID = api.OpenModel(new Uint8Array(arrayBuffer));
  if (modelID === -1 || modelID === undefined) {
    throw new Error("Failed to open IFC file (unrecognized or corrupt data).");
  }
  // web-ifc's GetLineIDsWithType index is a snapshot built at parse time and
  // does NOT reflect DeleteLine calls made within the same session (unlike
  // GetLine/inverse lookups, which are live). We track deletions ourselves
  // and filter getIdsOfType() below so repeated detection on an
  // already-repaired in-memory model doesn't see "ghost" deleted entities.
  return { api, modelID, deletedIds: new Set() };
}

/** Deletes a line and records it so getIdsOfType() stops returning it. */
export function deleteLine(model, id) {
  model.api.DeleteLine(model.modelID, id);
  model.deletedIds.add(id);
}

export function closeModel(model) {
  model.api.CloseModel(model.modelID);
}

export function saveModel(model) {
  return model.api.SaveModel(model.modelID);
}

/** IFC schema version string (e.g. "IFC4"), for display purposes. */
export function getSchema(model) {
  return model.api.GetModelSchema(model.modelID);
}

function toArray(vector) {
  const out = [];
  for (let i = 0; i < vector.size(); i++) out.push(vector.get(i));
  return out;
}

export function getIdsOfType(model, typeCode) {
  const raw = toArray(model.api.GetLineIDsWithType(model.modelID, typeCode));
  return model.deletedIds.size === 0 ? raw : raw.filter((id) => !model.deletedIds.has(id));
}

/**
 * Raw (non-flattened) line; reference attributes stay as {value, type}.
 *
 * Returns undefined for a deleted id instead of calling into wasm: web-ifc's
 * *forward* GetLine/inverse lookups are otherwise live (they do reflect
 * WriteLine attribute changes, e.g. a repointed RelatingStructure), but other
 * entities' cached inverse-attribute lists can still list an id after it was
 * DeleteLine'd -- dereferencing that stale reference must not crash callers.
 */
export function getLine(model, id, inversePropKey) {
  if (model.deletedIds.has(id)) return undefined;
  if (inversePropKey) {
    return model.api.GetLine(model.modelID, id, false, true, inversePropKey);
  }
  return model.api.GetLine(model.modelID, id);
}

/**
 * Every inverse relationship attribute on a line (no inversePropKey filter),
 * e.g. HasAssignments, ServicedBySystems, IsDefinedBy, ReferencedBy, etc. --
 * used to conservatively detect "this spatial structure still has some kind
 * of content/relationship we don't know how to preserve" before deleting it.
 */
export function getAllInverseAttributes(model, id) {
  if (model.deletedIds.has(id)) return undefined;
  return model.api.GetLine(model.modelID, id, false, true);
}

export function ref(id) {
  return { value: id, type: REF };
}

export function name(model, id) {
  const line = getLine(model, id);
  return line?.Name?.value || "Unnamed";
}

export function guid(model, id) {
  return getLine(model, id)?.GlobalId?.value;
}

/** Absolute Z by delegating to web-ifc's own placement-chain resolver. */
export function absoluteZ(model, placementRef) {
  if (!placementRef) return 0;
  const matrix = model.api.GetWorldTransformMatrix(model.modelID, placementRef.value);
  return matrix[14];
}

/** Absolute Z of a product (element or spatial structure) by its own express ID. */
export function absoluteZOf(model, id) {
  const line = getLine(model, id);
  return absoluteZ(model, line?.ObjectPlacement);
}

/** Full world X/Y/Z by delegating to the same placement-chain resolver as absoluteZ(). */
export function worldXYZ(model, placementRef) {
  if (!placementRef) return { x: 0, y: 0, z: 0 };
  const matrix = model.api.GetWorldTransformMatrix(model.modelID, placementRef.value);
  return { x: matrix[12], y: matrix[13], z: matrix[14] };
}

const SI_PREFIX_TO_METRES = {
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
  PICO: 1e-12,
  FEMTO: 1e-15,
  ATTO: 1e-18,
};

/** mm-per-1-of-this-unit for an IfcSIUnit or IfcConversionBasedUnit length unit entity. */
function resolveLengthUnitToMM(model, unitLine, depth = 0) {
  if (!unitLine || depth > 5) return 1; // depth guard against any malformed circular reference
  if (unitLine.type === WebIFC.IFCSIUNIT) {
    const metresPerUnit = SI_PREFIX_TO_METRES[unitLine.Prefix?.value] ?? 1;
    return metresPerUnit * 1000;
  }
  if (unitLine.type === WebIFC.IFCCONVERSIONBASEDUNIT) {
    const measure = getLine(model, unitLine.ConversionFactor?.value);
    const factor = measure?.ValueComponent?.value ?? 1;
    const baseUnit = getLine(model, measure?.UnitComponent?.value);
    return factor * resolveLengthUnitToMM(model, baseUnit, depth + 1);
  }
  return 1; // unrecognized unit type: assume already millimetres rather than guess wrong
}

/**
 * mm-per-1-model-unit for this file's length unit, resolved from
 * IfcProject.UnitsInContext. Elevations read via absoluteZ()/absoluteZOf()
 * are in the file's native units (whatever its IfcLocalPlacement values are
 * expressed in) -- multiply by this scale before comparing against
 * millimetre-denominated tolerances/thresholds. Falls back to 1 (assume
 * already millimetres, the overwhelmingly common case for Revit exports) if
 * no length unit can be resolved.
 */
export function getLengthUnitScaleToMM(model) {
  try {
    const projectIds = getIdsOfType(model, WebIFC.IFCPROJECT);
    if (projectIds.length === 0) return 1;
    const proj = getLine(model, projectIds[0]);
    const unitsRef = proj?.UnitsInContext;
    if (!unitsRef) return 1;
    const unitAssignment = getLine(model, unitsRef.value);
    for (const uRef of unitAssignment?.Units || []) {
      const u = getLine(model, uRef.value);
      if (u?.UnitType?.value === "LENGTHUNIT") return resolveLengthUnitToMM(model, u);
    }
  } catch {
    // fall through to the safe default below
  }
  return 1;
}

/** Element express IDs contained (via IfcRelContainedInSpatialStructure) in a spatial structure. */
export function getContainedElements(model, structureId) {
  const line = getLine(model, structureId, "ContainsElements");
  const relRefs = line?.ContainsElements || [];
  const elements = [];
  for (const r of relRefs) {
    const rel = getLine(model, r.value); // may be undefined: a stale inverse ref to a since-deleted/repointed rel
    if (!rel) continue;
    // web-ifc can retain the old inverse reference after RelatingStructure is
    // repointed in the current session. Verify the live forward reference so
    // an emptied source storey does not still appear to contain products.
    if (rel.RelatingStructure?.value !== structureId) continue;
    for (const e of rel.RelatedElements || []) elements.push(e.value);
  }
  return elements;
}

/** Repoints every complete containment relation from one spatial structure to another. */
export function repointContainedElements(model, sourceStructureId, targetStructureId) {
  const source = getLine(model, sourceStructureId, "ContainsElements");
  const relationIds = [];
  const elementIds = [];
  for (const relationRef of source?.ContainsElements || []) {
    const relation = getLine(model, relationRef.value);
    if (!relation || relation.RelatingStructure?.value !== sourceStructureId) continue;
    relationIds.push(relation.expressID);
    for (const elementRef of relation.RelatedElements || []) elementIds.push(elementRef.value);
    relation.RelatingStructure = ref(targetStructureId);
    model.api.WriteLine(model.modelID, relation);
  }
  return { relationIds, elementIds };
}

/** The single parent object decomposing `id` via IfcRelAggregates.RelatingObject, or null at the root. */
export function aggregateParentOf(model, id) {
  const line = getLine(model, id, "Decomposes");
  for (const relRef of line?.Decomposes || []) {
    const rel = getLine(model, relRef.value);
    if (rel?.RelatingObject?.value != null) return rel.RelatingObject.value;
  }
  return null;
}

/**
 * Walks up the spatial decomposition chain (IfcRelAggregates) from `id` to
 * find its containing IfcSite -- used to group linked branches by site
 * rather than by building, since one site can host several IfcBuildings
 * that must be reconciled together (see detector.js's per-site collision
 * check). Returns null if no ancestor IfcSite is found within a sane depth.
 */
export function getContainingSiteId(model, id) {
  let current = id;
  for (let depth = 0; depth < 12 && current != null; depth++) {
    const line = getLine(model, current);
    if (line?.type === WebIFC.IFCSITE) return current;
    current = aggregateParentOf(model, current);
  }
  return null;
}

/**
 * All IfcBuildingStorey express IDs decomposing (directly or nested) a
 * spatial structure, mirroring ifcopenshell.util.element.get_decomposition.
 */
export function getDecomposedStoreys(model, rootId) {
  const storeys = [];
  const stack = [rootId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    const line = getLine(model, id, "IsDecomposedBy");
    for (const relRef of line?.IsDecomposedBy || []) {
      const rel = getLine(model, relRef.value);
      if (!rel) continue;
      for (const childRef of rel.RelatedObjects || []) {
        if (seen.has(childRef.value)) continue;
        seen.add(childRef.value);
        const child = getLine(model, childRef.value);
        if (!child) continue;
        if (child.type === WebIFC.IFCBUILDINGSTOREY) storeys.push(child.expressID);
        stack.push(child.expressID);
      }
    }
  }
  return storeys;
}

/**
 * Removes `id` from every relationship entity reachable via the given
 * inverse attribute whose relationship type has a `RelatedObjects` array
 * (IfcRelAggregates.Decomposes, IfcRelDefinesByProperties.IsDefinedBy,
 * IfcRelAssociates*.HasAssociations all share this shape) -- deleting the
 * relationship entity itself if it becomes empty. Used before deleting a
 * spatial structure so it doesn't leave dangling references behind in
 * relationships that describe *it* (e.g. its own property sets), as opposed
 * to relationships that describe content still living under it.
 */
export function detachFromRelation(model, id, inversePropKey) {
  const { api, modelID } = model;
  const line = getLine(model, id, inversePropKey);
  for (const r of line?.[inversePropKey] || []) {
    const rel = getLine(model, r.value);
    if (!rel) continue;
    rel.RelatedObjects = (rel.RelatedObjects || []).filter((o) => o.value !== id);
    if (rel.RelatedObjects.length === 0) {
      deleteLine(model, r.value);
    } else {
      api.WriteLine(modelID, rel);
    }
  }
}

/** Removes childId from every IfcRelAggregates that decomposes it into a parent. */
export function detachFromAggregateParent(model, childId) {
  detachFromRelation(model, childId, "Decomposes");
}

/**
 * Allocates a fresh express ID for a brand-new line, seeded from the model's
 * current max ID and cached on `model` so repeated calls within one repair
 * session never collide (GetMaxExpressID doesn't advance until SaveModel).
 */
function nextExpressId(model) {
  if (model.nextId == null) model.nextId = model.api.GetMaxExpressID(model.modelID) + 1;
  return model.nextId++;
}

/**
 * Creates and writes a brand-new IfcRelContainedInSpatialStructure containing
 * `elementRefs` (an array of ref()s) under `targetStoreyId`, returning its
 * express ID. Used when a target storey has no existing containment
 * relationship to extend and the source relationship can't simply be
 * repointed (because only part of it is moving).
 */
export function createContainmentRel(model, targetStoreyId, elementRefs) {
  const id = nextExpressId(model);
  const line = {
    expressID: id,
    type: WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE,
    GlobalId: model.api.CreateIFCGloballyUniqueId(model.modelID),
    OwnerHistory: null,
    Name: null,
    Description: null,
    RelatedElements: elementRefs,
    RelatingStructure: ref(targetStoreyId),
  };
  model.api.WriteLine(model.modelID, line);
  return id;
}

export { WebIFC };
