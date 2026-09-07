/**
 * Runs the actual repair off the main thread so the UI stays responsive on
 * larger files. Re-opens its own independent web-ifc instance from a copy
 * of the file bytes (a WASM model handle can't cross a thread boundary),
 * re-runs detection with the settings it was given, applies the repair with
 * progress callbacks, runs the post-repair validation checks, and posts back
 * the repaired bytes plus the report/result/validation data.
 *
 * Progress stages, in order:
 *   open      -- parsing the IFC (indeterminate: web-ifc has no per-byte
 *                 progress callback for this)
 *   analyze   -- detection (indeterminate: typically sub-second even for
 *                 large files, and not meaningfully chunkable)
 *   update    -- collecting verified storey-name changes (measurable)
 *   save      -- patching the two storey-name fields in the original bytes
 *   validate  -- reopening the output and checking hierarchy preservation
 */
import { closeModel, createIfcApi, openModel } from "../core/ifcModel.js";
import { analyze, selectRepairableProposals } from "../core/detector.js";
import { detectProjectBlocks } from "../core/blockDetection.js";
import { applyRepair, buildElementAudit, validateRepair } from "../core/repairer.js";
import { patchIfcStoreyNames } from "../core/stepPatcher.js";

self.onmessage = async (event) => {
  if (event.data?.type !== "run") return;
  const { buffer, wasmBaseUrl, tolerance, sourceName, overrides } = event.data.payload;

  let model = null;
  try {
    self.postMessage({ type: "progress", stage: "open" });
    const api = await createIfcApi(wasmBaseUrl);
    model = openModel(api, buffer);

    self.postMessage({ type: "progress", stage: "analyze" });
    // Re-derived here (cheap -- placement lookups only, no mesh geometry;
    // sub-second even on the large real files this app targets) rather than
    // passed through postMessage, so this worker's analysis is guaranteed to
    // match the model it actually reopened, independent of the main thread's
    // own copy of the result. The main thread already ran the hard
    // federation/block-conflict gates before ever allowing a repair to start;
    // this call only needs the classification, not to re-gate anything.
    const blocks = detectProjectBlocks(model);
    const report = analyze(model, { storeyMatchTolerance: tolerance, sourceName, overrides, blocks });

    const selected = new Set(selectRepairableProposals(report).map((p) => p.sourceStoreyId));

    const result = applyRepair(model, report, {
      selectedStoreyIds: selected,
      onProgress: (p) => self.postMessage({ type: "progress", ...p }),
    });

    const audit = buildElementAudit(model, report, result);

    self.postMessage({ type: "progress", stage: "save" });
    // applyRepair is non-mutating. Patch the original bytes directly instead
    // of serializing the entire web-ifc model.
    const bytes = patchIfcStoreyNames(new Uint8Array(buffer), result.renameChanges);

    closeModel(model);
    model = openModel(api, bytes);

    self.postMessage({ type: "progress", stage: "validate" });
    const validation = validateRepair(model, result);
    closeModel(model);
    model = null;
    self.postMessage({ type: "done", bytes, report, result, audit, validation }, [bytes.buffer]);
  } catch (e) {
    if (model) {
      try {
        closeModel(model);
      } catch {
        /* already broken; nothing more to clean up */
      }
    }
    self.postMessage({ type: "error", message: e?.stack || e?.message || String(e) });
  }
};
