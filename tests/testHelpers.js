import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeModel, createIfcApi, openModel, saveModel } from "../src/core/ifcModel.js";
import { applyRepair } from "../src/core/repairer.js";
import { patchIfcStoreyNames } from "../src/core/stepPatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture(filename) {
  const filePath = path.join(__dirname, "fixtures", filename);
  return fs.readFileSync(filePath);
}

export async function openFixture(filename) {
  const api = await createIfcApi();
  const buffer = loadFixture(filename);
  return openModel(api, buffer);
}

export async function reopenFromBytes(bytes) {
  const api = await createIfcApi();
  return openModel(api, bytes);
}

/**
 * Runs the exact same pipeline repairWorker.js runs in production: merge
 * mutations are applied directly to `model` in-place by applyRepair(), then
 * the model is saved and the rename changes are patched onto those bytes as
 * raw STEP text, then the result is reopened fresh. Renames are NEVER
 * verifiable on the original in-memory `model` -- only on `reloaded` --
 * because this module deliberately never writes a rename into the model
 * directly (see repairer.js's file header for the round-trip corruption
 * this avoids). Callers are responsible for closing both `model` (already
 * consumed once bytes are produced) and `reloaded` when done with them.
 */
export async function runRepairPipeline(model, report, opts = {}) {
  const result = applyRepair(model, report, opts);
  const mergedBytes = saveModel(model);
  const bytes = patchIfcStoreyNames(mergedBytes, result.renameChanges);
  const reloaded = await reopenFromBytes(bytes);
  return { result, reloaded, bytes };
}

export { closeModel, saveModel };
