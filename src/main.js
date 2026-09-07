import "./style.css";
import { closeModel, createIfcApi, getSchema, openModel } from "./core/ifcModel.js";
import { analyze, DEFAULT_STOREY_MATCH_TOLERANCE, proposalNeedsAction } from "./core/detector.js";
import { detectFederatedExportStructure } from "./core/federationCheck.js";
import { compareBlockStoreys, detectProjectBlocks } from "./core/blockDetection.js";
import { filterProposals, renderMasterElevationTabs, renderMasterElevations, renderProposalTable } from "./core/reviewView.js";
import { buildReportData, renderCsvReport, renderPdfReport } from "./core/report.js";

const el = (id) => document.getElementById(id);
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const WARN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l7 12.5H1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6v3.5M8 11.5h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

// -- element refs ---------------------------------------------------------

const dropzone = el("dropzone");
const fileInput = el("file-input");
const chooseFileButton = el("choose-file-button");
const loadUploadGroup = el("load-upload-group");
const federationWarning = el("federation-warning");
const blockWarning = el("block-warning");
const preflightSummary = el("preflight-summary");
const loadStatus = el("load-status");
const loadSpinner = el("load-spinner");
const loadStatusText = el("load-status-text");
const loadProgressBars = el("load-progress-bars");
const robotLoad = el("robot-load");
const loadProgressBarFill = el("load-progress-bar-fill");
const loadProgressPercent = el("load-progress-percent");
const sampleCleanLink = el("sample-clean");
const sampleLinkedLink = el("sample-linked");
const step1Full = el("step-1-full");
const step1Collapsed = el("step-1-collapsed");
const fileCardName = el("file-card-name");
const fileCardMeta = el("file-card-meta");
const changeFileButton = el("change-file-button");

const step2 = el("step-2");
const detectionChips = el("detection-chips");
const detectionWarnings = el("detection-warnings");
const detectionCalmState = el("detection-calm-state");
const detectionDiagramBlock = el("detection-diagram-block");
const elevationDiagramContainer = el("elevation-diagram-container");
const detectionMappingBlock = el("detection-mapping-block");
const mappingList = el("mapping-list");
const confirmUncertainBlock = el("confirm-uncertain-block");
const confirmUncertainText = el("confirm-uncertain-text");
const confirmUncertainButton = el("confirm-uncertain-button");
const advancedSettingsBlock = document.querySelector(".advanced-settings");
const advancedSettingsToggle = el("advanced-settings-toggle");
const advancedSettingsPanel = el("advanced-settings-panel");
const advancedSettingsHint = el("advanced-settings-hint");
const toleranceInput = el("tolerance-input");
const guidFilter = el("guid-filter");
/** "matched" | "review" -- which of the two clickable summary chips is active (see reviewView.js's proposalCategory). */
let mappingCategory = "matched";
/** Active column sort within each building's table, or null for the default (elevation, descending). */
let mappingSort = null;
/** "yes" | "no" | null (all) -- filters rows by the Match column (see reviewView.js's matchValueOf). */
let mappingMatchFilter = null;
/** Building ids whose section is manually expanded, preserved across re-renders (e.g. a sort-header click) so they don't snap shut every time. */
let expandedBuildingIds = new Set();
/** Active tower's blockGuid for the Master elevation map tabs (multi-block only; null picks the first tower). */
let elevationTowerTab = null;
let guidFilterTimer = null;
guidFilter.addEventListener("input", () => {
  clearTimeout(guidFilterTimer);
  guidFilterTimer = setTimeout(renderMappingList, 150);
});

// The "Matched levels"/"Needs review" summary chips double as the filter --
// no separate tab strip.
detectionChips.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip-clickable");
  if (!chip) return;
  mappingCategory = chip.dataset.category;
  renderMappingList();
  renderChipActiveStates();
});

// Clicking a sortable column header (Level/Elements/Proposed level) toggles
// that column's sort within each building's own table; clicking the same
// header again reverses direction.
mappingList.addEventListener("click", (event) => {
  if (event.target.closest("[data-match-filter-clear]")) {
    mappingMatchFilter = null;
    renderMappingList();
    return;
  }
  const header = event.target.closest(".sortable-header");
  if (!header) return;
  if (header.dataset.matchFilterToggle) {
    mappingMatchFilter = mappingMatchFilter === "yes" ? "no" : mappingMatchFilter === "no" ? null : "yes";
    renderMappingList();
    return;
  }
  const key = header.dataset.sortKey;
  mappingSort = mappingSort?.key === key ? { key, dir: -mappingSort.dir } : { key, dir: 1 };
  renderMappingList();
});

// <details> sections stay open/closed across a re-render (e.g. after a sort
// click replaces mappingList's whole innerHTML) by tracking which building
// ids are expanded ourselves and re-applying it on render -- without this,
// every section snaps shut on every re-render since renderProposalTable()
// otherwise always starts them closed. The native "toggle" event does not
// bubble, so this listener must be registered on the capture phase.
mappingList.addEventListener(
  "toggle",
  (event) => {
    const details = event.target.closest(".building-group");
    if (!details) return;
    const buildingId = Number(details.dataset.buildingId);
    if (details.open) expandedBuildingIds.add(buildingId);
    else expandedBuildingIds.delete(buildingId);
  },
  true
);

// A manual level override can ripple beyond the row it's made on -- it may
// resolve or create a duplicate-name collision within a tower (see
// detector.js's applySiteCollisionStrategy), change which tab a row belongs
// in, or affect the summary chips -- so re-run detection and re-render the
// whole step, not just patch this one row's cell.
mappingList.addEventListener("change", (event) => {
  const select = event.target.closest(".proposed-level-select");
  if (!select) return;
  const sourceStoreyId = Number(select.dataset.sourceStoreyId);
  const targetStoreyId = Number(select.value);
  levelOverrides = { ...levelOverrides, [sourceStoreyId]: targetStoreyId };
  if (runDetection()) renderStep2();
});

// A high-confidence row shows its proposed level as read-only text with a
// small "Change" button (see reviewView.js's proposalRow) instead of an
// always-open dropdown -- clicking it just reveals that row's hidden select.
mappingList.addEventListener("click", (event) => {
  const button = event.target.closest(".row-change-button");
  if (!button) return;
  const cell = button.closest("td");
  const select = cell?.querySelector(".row-change-select");
  if (!select) return;
  select.hidden = false;
  button.hidden = true;
  cell.querySelector(".target-prefill")?.setAttribute("hidden", "");
});
const repairProgressBlock = el("repair-progress-block");
const robotProgress = el("robot-progress");
const progressBarFill = el("progress-bar-fill");
const progressOperation = el("progress-operation");
const progressPercent = el("progress-percent");
const repairError = el("repair-error");
const repairButton = el("repair-button");
const pendingConfirmationNote = el("pending-confirmation-note");

const step3 = el("step-3");
const step3Status = el("step-3-status");
const exportButton = el("export-button");
const exportPdfButton = el("export-pdf-button");
const exportCsvButton = el("export-csv-button");

const stepperItems = [...document.querySelectorAll(".stepper-item")];

// -- state ------------------------------------------------------------------

/** @type {{api: any, modelID: number, deletedIds: Set<number>} | null} */
let model = null;
let originalBuffer = null; // kept so the worker can re-open its own independent copy
let sourceName = "";
let schema = "";
let report = null;
let currentStep = 1;
let ifcApi = null;
/** User-chosen target overrides, keyed by sourceStoreyId -> master storey id. Reset whenever a new file is loaded. */
let levelOverrides = {};
/** The detectProjectBlocks() result for the currently-loaded file (null once no file, or SINGLE_BLOCK-irrelevant). Threaded into analyze() so tower-aware matching (see detector.js) is used for MULTI_BLOCK files. */
let currentBlockResult = null;

let worker = null;
let repairing = false;
/** @type {{report: object, result: object, audit: object[], validation: object[], bytes: Uint8Array} | null} */
let repairOutcome = null;
let progressState = { stage: null, processed: null, total: null };
let progressTimer = null;

function setLoadStatus(text, { error = false, spinning = false } = {}) {
  loadStatus.hidden = false;
  loadStatusText.textContent = text;
  loadStatus.classList.toggle("error", error);
  loadSpinner.hidden = !spinning;
}

/** Nothing worth telling the user right now -- the dropzone itself already invites loading a file. */
function clearLoadStatus() {
  loadStatus.hidden = true;
}

/**
 * Blocks the workflow when the loaded IFC was exported with Revit's "Same
 * IFCProject" linked-model setting (each linked building under its own
 * distinct IfcSite) instead of "Same IFCSite" (one shared site) -- the only
 * shape the storey-name-fixing workflow below this gate is designed for.
 * Deliberately offers only a way to pick a different file, never a way to
 * proceed anyway: this validation exists specifically to stop processing.
 */
function showFederationWarning() {
  loadUploadGroup.hidden = true;
  clearLoadStatus();
  federationWarning.hidden = false;
  federationWarning.innerHTML = `${WARN_ICON}<div>
    <div class="calm-state-title">Unsupported IFC Export Structure</div>
    <div class="calm-state-detail">
      This IFC appears to have been exported using <strong>Export linked files in same IFCProject</strong>.
      CORENET X requires the Revit linked model to be exported using <strong>Export linked files in same IFCSite</strong>.
      Please re-export the IFC from Revit using Same IFCSite, then load the new IFC file again.
      <button id="federation-select-another" class="button primary" type="button">Select Another IFC</button>
    </div>
  </div>`;
}

function clearFederationWarning() {
  federationWarning.hidden = true;
  federationWarning.innerHTML = "";
  loadUploadGroup.hidden = false;
}

federationWarning.addEventListener("click", (event) => {
  if (event.target.id === "federation-select-another") {
    clearFederationWarning();
    fileInput.click();
  }
});

/**
 * Blocks the workflow when block/tower detection (see core/blockDetection.js)
 * could not confidently distinguish actual block buildings from podium/
 * linked-unit/empty-shell buildings. Deliberately offers only a way to pick a
 * different file, same rationale as showFederationWarning().
 */
function showBlockUnknownWarning() {
  loadUploadGroup.hidden = true;
  clearLoadStatus();
  blockWarning.hidden = false;
  blockWarning.innerHTML = `${WARN_ICON}<div>
    <div class="calm-state-title">Unable to Determine Project Structure</div>
    <div class="calm-state-detail">
      This tool could not reliably determine how many actual block/tower buildings this IFC contains.
      Processing it automatically could produce incorrect results.
      <p class="federation-warning-note">Please review the file, or select another IFC.</p>
      <button id="block-select-another" class="button primary" type="button">Select Another IFC</button>
    </div>
  </div>`;
}

/**
 * Blocks the workflow when two or more detected blocks use the same
 * (normalized) IfcBuildingStorey name at different resolved FFLs -- the
 * "unsafe condition" this stage exists to catch. Never offers a way to
 * continue anyway: this is a hard gate, and renaming/coordinating levels is
 * left to the user, not auto-guessed.
 */
function showBlockConflictWarning(blocks, comparison) {
  loadUploadGroup.hidden = true;
  clearLoadStatus();
  blockWarning.hidden = false;
  const rows = comparison.conflicts
    .flatMap((c) => c.entries.map((e) => ({ ...e, normalizedName: c.normalizedName })))
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.blockLabel)}</td><td>${(e.resolvedGlobalZ / 1000).toFixed(3)} m</td></tr>`
    )
    .join("");
  blockWarning.innerHTML = `${WARN_ICON}<div>
    <div class="calm-state-title">Level Naming Inconsistency</div>
    <div class="calm-state-detail">
      The IFC contains multiple blocks. The same BuildingStorey name is used at different FFLs across the blocks.
      This does not follow the expected CORENET X level naming approach.
      <p class="federation-warning-note">Please review and coordinate the level naming before continuing.</p>
      <div class="proposal-table-scroll">
        <table class="block-conflict-table">
          <thead><tr><th>Storey Name</th><th>Block</th><th>FFL</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <button id="block-select-another" class="button primary" type="button">Select Another IFC</button>
    </div>
  </div>`;
}

function clearBlockWarning() {
  blockWarning.hidden = true;
  blockWarning.innerHTML = "";
}

blockWarning.addEventListener("click", (event) => {
  if (event.target.id === "block-select-another") {
    clearBlockWarning();
    loadUploadGroup.hidden = false;
    fileInput.click();
  }
});

/**
 * Shown once both hard gates (federation, block detection) have already
 * passed -- a final human checkpoint before Review & Repair, rather than
 * auto-advancing straight there. Requires the acknowledgement checkbox
 * before "Continue" is enabled; never itself blocks the workflow the way
 * showFederationWarning()/showBlockConflictWarning() do.
 */
function showPreflightSummary(blocks, seconds) {
  loadUploadGroup.hidden = true;
  clearLoadStatus();
  preflightSummary.hidden = false;

  const row = (icon, text, tone = "") => `<li class="${tone}">${icon}<span>${text}</span></li>`;
  const rows = [row(CHECK_ICON, "Export structure: Same IFCSite")];
  if (blocks.mode === "SINGLE_BLOCK") {
    rows.push(row(CHECK_ICON, "Single block detected."));
  } else {
    rows.push(
      row(
        WARN_ICON,
        `This file has multiple blocks (${blocks.blocks.length} detected). It is not recommended to have all blocks in one ` +
          `file, but you may proceed with caution. IFC data alone can't always prove which block a linked/fragment building ` +
          `physically belongs to -- see the next step for details.`,
        "tone-warn"
      )
    );
  }
  const rowsHtml = rows.join("");

  preflightSummary.innerHTML = `
    <h3 class="block-title">Before you continue</h3>
    <p class="preflight-loaded-note">Loaded in ${escapeHtml(seconds)}s.</p>
    <ul class="preflight-checklist">${rowsHtml}</ul>
    <p class="preflight-disclaimer">
      This tool proposes each level match by resolving where things actually sit in 3D space (elevation, and for
      multi-block files, physical position) -- not by storey names, which Revit linked-model exports often get wrong.
      Please spot-check the proposed matches on the next page before repairing.
    </p>
    <label class="preflight-ack">
      <input type="checkbox" id="preflight-ack-checkbox" />
      I understand and have reviewed the notes above
    </label>
    <div class="step-actions">
      <button id="preflight-continue" class="button primary" type="button" disabled>Continue to Review &amp; Repair</button>
      <button id="preflight-change-file" class="button ghost" type="button">Choose a different file</button>
    </div>`;
}

function clearPreflightSummary() {
  preflightSummary.hidden = true;
  preflightSummary.innerHTML = "";
}

preflightSummary.addEventListener("change", (event) => {
  if (event.target.id === "preflight-ack-checkbox") {
    el("preflight-continue").disabled = !event.target.checked;
  }
});
preflightSummary.addEventListener("click", (event) => {
  if (event.target.id === "preflight-continue" && !event.target.disabled) {
    clearPreflightSummary();
    loadUploadGroup.hidden = false;
    goToStep(2);
  } else if (event.target.id === "preflight-change-file") {
    clearPreflightSummary();
    loadUploadGroup.hidden = false;
    fileInput.click();
  }
});

/**
 * Lets the browser paint the "loading" state before a blocking WASM call.
 * Deliberately setTimeout, not requestAnimationFrame: rAF is throttled/paused
 * indefinitely for background or unfocused tabs, which would hang the load
 * forever if the user switches tabs while a file is parsing.
 */
function nextPaint() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drives a progress-bar robot: when `pct` is a real 0-100 number, walks it to
 * that position along its scene (matching the bar underneath) with its legs
 * animating; when `pct` is null (no file loading yet, or an indeterminate
 * stage), it stays in place and does its lively idle routine (hop/tumble/
 * flip) so it never reads as frozen or merely decorative. Robot position is
 * driven here in JS rather than a fixed CSS loop specifically so it always
 * reflects the real percentage.
 */
function setRobotProgress(robotEl, pct) {
  if (typeof pct === "number" && Number.isFinite(pct)) {
    robotEl.classList.remove("waiting");
    robotEl.classList.add("walking");
    const scene = robotEl.parentElement;
    // `offsetWidth` is an HTMLElement-only property -- undefined on an <svg>
    // root in some engines, which would silently turn this into NaN.
    const robotWidth = robotEl.getBoundingClientRect().width || 60;
    const maxLeft = Math.max(0, scene.clientWidth - robotWidth);
    const clampedPct = Math.min(100, Math.max(0, pct));
    // The robot's leading edge (its "tip", facing the direction of travel)
    // should land exactly at clampedPct% of the scene width -- the same
    // point the bar fill's edge is at -- not its own left edge. Solving for
    // `left` such that `left + robotWidth == clampedPct% of sceneWidth`
    // keeps the two in sync at every percentage instead of only at 0/100
    // (the old formula placed the robot's LEFT edge at that fraction of
    // maxLeft, which put its tip up to a full robot-width ahead of the bar
    // for any percentage short of 100).
    const sceneWidth = scene.clientWidth;
    const tipTarget = (clampedPct / 100) * sceneWidth;
    robotEl.style.left = `${Math.min(maxLeft, Math.max(0, tipTarget - robotWidth))}px`;
  } else {
    robotEl.classList.remove("walking");
    robotEl.classList.add("waiting");
  }
}

function resetRobotProgress(robotEl) {
  robotEl.classList.remove("walking", "celebrate");
  robotEl.classList.add("waiting");
  robotEl.style.left = "0px";
}

/**
 * A fully-resolved absolute URL to the site root, safe to reuse both on the
 * main thread and inside a Worker: a relative path resolves against
 * whatever script evaluates it, which differs between the two contexts.
 */
function wasmBaseUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.href).href;
}

async function init() {
  setLoadStatus("Initializing IFC engine…", { spinning: true });
  await nextPaint();
  ifcApi = await createIfcApi(wasmBaseUrl());
  clearLoadStatus();
}

goToStep(1); // render initial stepper/panel state before the (async) wasm init
init().catch((e) => {
  setLoadStatus(`Failed to initialize IFC engine: ${e.message}`, { error: true });
  console.error(e);
});

// -- step navigation --------------------------------------------------------

function goToStep(n) {
  currentStep = n;
  renderStepper();
  renderStep1();
  step2.hidden = n !== 2;
  step3.hidden = n !== 3;
  if (n === 2) {
    let reopenedModel = false;
    if (!model && originalBuffer && ifcApi) {
      model = openModel(ifcApi, originalBuffer);
      currentBlockResult = detectProjectBlocks(model);
      reopenedModel = true;
    }
    resetProgressUI();
    if (!report || reopenedModel) runDetection();
    renderStep2();
  }
  if (n === 3) renderStep3();
}

function renderStepper() {
  for (const item of stepperItems) {
    const n = Number(item.dataset.step);
    item.classList.toggle("is-completed", n < currentStep);
    item.classList.toggle("is-current", n === currentStep);
    item.classList.toggle("is-pending", n > currentStep);
  }
}

for (const item of stepperItems) {
  item.addEventListener("click", () => {
    const n = Number(item.dataset.step);
    if (n < currentStep && !repairing) goToStep(n);
  });
}

// -- step 1: load -----------------------------------------------------------

function renderStep1() {
  if (currentStep === 1) {
    step1Full.hidden = false;
    step1Collapsed.hidden = true;
  } else {
    step1Full.hidden = true;
    step1Collapsed.hidden = false;
    fileCardName.textContent = sourceName;
    fileCardMeta.textContent = schema;
  }
}

chooseFileButton.addEventListener("click", () => fileInput.click());
changeFileButton.addEventListener("click", () => {
  if (!repairing) goToStep(1);
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer.files?.[0];
  if (file) loadFile(file.name, file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file.name, file);
});

sampleCleanLink.addEventListener("click", (e) => {
  e.preventDefault();
  loadSample("samples/clean_master_only.ifc", "clean_master_only.ifc (sample)");
});
sampleLinkedLink.addEventListener("click", (e) => {
  e.preventDefault();
  loadSample("samples/linked_branches_defect.ifc", "linked_branches_defect.ifc (sample)");
});

/**
 * Reads a local File with real, byte-level progress (FileReader reports
 * `loaded`/`total` as the browser streams it off disk) -- meaningful for a
 * large IFC file, unlike a plain `file.arrayBuffer()` which only resolves
 * once, at the very end, with nothing to show in between.
 */
function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read the file"));
    reader.readAsArrayBuffer(file);
  });
}

/** Same idea as readFileWithProgress(), but for a fetched (sample) file. */
async function fetchWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length")) || 0;
  if (!resp.body || total === 0) return await resp.arrayBuffer(); // no length/stream available -- fall back silently

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer.buffer;
}

let loadProgressState = { stage: null, loaded: 0, total: 0 };
let loadRequestId = 0;

// Same one-continuous-percentage approach as the repair progress bar (see
// STAGE_RANGE/overallRepairPct below) -- only "reading" has real byte-level
// loaded/total, the rest are stage-transition markers, so each stage claims
// a fixed slice of one 0-100% range instead of showing per-stage jargon
// text with the bar going indeterminate between them.
const LOAD_STAGE_RANGE = {
  reading: [0, 55],
  parsing: [55, 75],
  "validating-structure": [75, 85],
  "validating-blocks": [85, 95],
  detecting: [95, 100],
};

function overallLoadPct(stage, loaded, total) {
  const range = LOAD_STAGE_RANGE[stage];
  if (!range) return 0;
  const [lo, hi] = range;
  if (stage === "reading" && total > 0) {
    return lo + (hi - lo) * Math.min(1, loaded / total);
  }
  return lo;
}

function renderLoadProgress() {
  const { stage, loaded, total } = loadProgressState;
  const pct = Math.round(overallLoadPct(stage, loaded, total));
  loadProgressBarFill.classList.remove("indeterminate");
  loadProgressBarFill.style.width = `${pct}%`;
  loadProgressPercent.textContent = `${pct}%`;
  setRobotProgress(robotLoad, pct);
}

function beginLoadProgress() {
  loadStatus.hidden = true;
  loadProgressBars.hidden = false;
  resetRobotProgress(robotLoad);
  loadProgressState = { stage: "reading", loaded: 0, total: 0 };
  renderLoadProgress();
}

function endLoadProgress() {
  loadProgressBars.hidden = true; // caller always calls setLoadStatus() right after, which re-shows #load-status
  resetRobotProgress(robotLoad); // back to its always-visible idle routine
}

async function loadSample(url, label) {
  if (!ifcApi) {
    setLoadStatus("IFC engine is still initializing, please wait...");
    return;
  }
  const requestId = ++loadRequestId;
  beginLoadProgress();
  await nextPaint();
  try {
    const buffer = await fetchWithProgress(import.meta.env.BASE_URL + url, (loaded, total) => {
      if (requestId !== loadRequestId) return;
      loadProgressState = { stage: "reading", loaded, total };
      renderLoadProgress();
    });
    if (requestId !== loadRequestId) return;
    await loadFile(label, buffer, requestId);
  } catch (e) {
    if (requestId !== loadRequestId) return;
    endLoadProgress();
    setLoadStatus(`Failed to load sample: ${e.message}`, { error: true });
    console.error(e);
  }
}

async function loadFile(name, bufferOrPromise, requestId = ++loadRequestId) {
  if (!ifcApi) {
    setLoadStatus("IFC engine is still initializing, please wait...");
    return;
  }
  clearFederationWarning(); // a fresh load attempt always starts from a clean slate
  clearBlockWarning();
  clearPreflightSummary();
  const isFile = bufferOrPromise instanceof File;
  // Called directly with a File (drag/drop, file picker): start the progress
  // UI here. Called from loadSample() with an already-fetched buffer: it
  // already started (and drove) the progress UI itself through the fetch.
  if (loadProgressBars.hidden) beginLoadProgress();

  const startedAt = performance.now();
  try {
    const buffer = isFile
      ? await readFileWithProgress(bufferOrPromise, (loaded, total) => {
          if (requestId !== loadRequestId) return;
          loadProgressState = { stage: "reading", loaded, total };
          renderLoadProgress();
        })
      : await bufferOrPromise;
    if (requestId !== loadRequestId) return;

    // The WASM parse itself has no per-byte progress callback -- switch to
    // an indeterminate "still working" state (robot bounces in place) rather
    // than leaving the bar sitting at "100% read" while parsing continues.
    loadProgressState = { stage: "parsing", loaded: 0, total: 0 };
    renderLoadProgress();
    await nextPaint(); // let the indeterminate state paint before the blocking parse below
    if (requestId !== loadRequestId) return;

    if (model) closeModel(model);
    model = openModel(ifcApi, buffer);
    originalBuffer = buffer;
    sourceName = name;
    schema = getSchema(model);
    repairOutcome = null;
    mappingCategory = "matched";
    mappingSort = null;
    mappingMatchFilter = null;
    expandedBuildingIds = new Set();
    elevationTowerTab = null;
    guidFilter.value = "";
    levelOverrides = {};
    currentBlockResult = null;
    detectionDiagramBlock.open = false;

    // Validate the linked-model export structure before ever reading storey
    // data -- the fixer below this gate assumes every linked building shares
    // one IfcSite with the master, and a "Same IFCProject" export (each
    // linked building under its own distinct site) must be rejected rather
    // than guessed at. See core/federationCheck.js for the detection logic.
    loadProgressState = { stage: "validating-structure", loaded: 0, total: 0 };
    renderLoadProgress();
    await nextPaint();
    if (requestId !== loadRequestId) return;

    const federation = detectFederatedExportStructure(model);
    console.info(`[federationCheck] ${federation.debugLog.join("\n[federationCheck] ")}`);

    if (federation.mode === "SAME_IFCPROJECT") {
      endLoadProgress();
      showFederationWarning();
      return;
    }

    // Second validation gate: identify actual block/tower buildings (never by
    // raw IfcBuilding count -- see core/blockDetection.js) and, for a
    // multi-block project, confirm every block uses IfcBuildingStorey names
    // consistently before ever reaching the existing storey fixer.
    loadProgressState = { stage: "validating-blocks", loaded: 0, total: 0 };
    renderLoadProgress();
    await nextPaint();
    if (requestId !== loadRequestId) return;

    const blocks = detectProjectBlocks(model);
    console.info(`[blockDetection] ${blocks.debugLog.join("\n[blockDetection] ")}`);

    if (blocks.mode === "UNKNOWN") {
      endLoadProgress();
      showBlockUnknownWarning();
      return;
    }

    if (blocks.mode === "MULTI_BLOCK") {
      const comparison = compareBlockStoreys(model, blocks.blocks);
      console.info(`[blockDetection] ${comparison.debugLog.join("\n[blockDetection] ")}`);
      if (!comparison.pass) {
        endLoadProgress();
        showBlockConflictWarning(blocks, comparison);
        return;
      }
    }
    currentBlockResult = blocks;

    loadProgressState = { stage: "detecting", loaded: 0, total: 0 };
    renderLoadProgress();
    await nextPaint();

    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const detected = runDetection();
    endLoadProgress();
    if (detected) {
      clearLoadStatus();
      showPreflightSummary(blocks, seconds);
    } else {
      setLoadStatus(`Loaded ${name} in ${seconds}s, but detection failed.`, { error: true });
    }
  } catch (e) {
    if (requestId !== loadRequestId) return;
    endLoadProgress();
    setLoadStatus(`Failed to load: ${e.message}`, { error: true });
    console.error(e);
  }
}

// -- step 2: review & repair --------------------------------------------------

function runDetection() {
  if (!model) return false;
  const tolerance = toleranceValue();
  try {
    report = analyze(model, { storeyMatchTolerance: tolerance, sourceName, overrides: levelOverrides, blocks: currentBlockResult });
    return true;
  } catch (e) {
    setLoadStatus(`Detection failed: ${e.message}`, { error: true });
    console.error(e);
    return false;
  }
}

// Changing matching settings must refresh detection before repair -- do it
// live, not just when the button is clicked, so the preview never lies.
toleranceInput.addEventListener("change", () => {
  toleranceInput.value = String(toleranceValue());
  updateAdvancedHint();
  refreshDetectionLive();
});

function refreshDetectionLive() {
  if (currentStep !== 2 || repairing) return;
  if (runDetection()) renderStep2();
}

advancedSettingsToggle.addEventListener("click", () => {
  const willOpen = advancedSettingsPanel.hidden;
  advancedSettingsPanel.hidden = !willOpen;
  advancedSettingsToggle.setAttribute("aria-expanded", String(willOpen));
});

function updateAdvancedHint() {
  advancedSettingsHint.textContent = `Tolerance: ${toleranceValue()}mm`;
}
toleranceInput.addEventListener("input", updateAdvancedHint);
updateAdvancedHint();

function toleranceValue() {
  const raw = toleranceInput.value.trim();
  const parsed = Number(raw);
  return raw !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STOREY_MATCH_TOLERANCE;
}

function chipHtml(label, value, tone = "") {
  return `<div class="chip"><div class="chip-label">${escapeHtml(label)}</div><div class="chip-value ${tone}">${escapeHtml(String(value))}</div></div>`;
}

/** A chip that also acts as a filter button for the table below (see the detectionChips click delegation above). */
function clickableChipHtml(label, category, tone, valueId) {
  const active = category === mappingCategory;
  return `<button type="button" class="chip chip-clickable ${tone} ${active ? "chip-active" : ""}" data-category="${category}">
    <div class="chip-label">${escapeHtml(label)}</div><div class="chip-value" id="${valueId}">0</div>
  </button>`;
}

function renderChipActiveStates() {
  for (const chip of detectionChips.querySelectorAll(".chip-clickable")) {
    chip.classList.toggle("chip-active", chip.dataset.category === mappingCategory);
  }
}

function renderStep2() {
  const chips = [];
  if (report.blocksMode === "MULTI_BLOCK") chips.push(chipHtml("Blocks Detected", report.towerGroups.length));
  chips.push(
    chipHtml("Linked Levels Detected", report.linkedBranches.length),
    chipHtml("Levels Detected from Linked Files", report.totalStoreysToUpdate),
    clickableChipHtml("Matched Levels", "matched", "tone-high", "chip-matched-value"),
    clickableChipHtml("Needs Review", "review", "tone-review", "chip-review-value")
  );
  detectionChips.innerHTML = chips.join("");

  const geometryWarnings = [...new Set(report.warnings || [])].filter((warning) =>
    /mesh|geometry|placement fallback/i.test(warning)
  );
  detectionWarnings.hidden = geometryWarnings.length === 0;
  detectionWarnings.innerHTML = geometryWarnings.length
    ? `${WARN_ICON}<div><div class="calm-state-title">Geometry review required</div><div class="calm-state-detail">${geometryWarnings
        .map((warning) => `<div>${escapeHtml(warning)}</div>`)
        .join("")}</div></div>`
    : "";

  renderElevationMap();
  detectionDiagramBlock.hidden = report.masterStoreys.length === 0;

  repairButton.textContent = report.repairNeeded ? "Repair IFC" : "Continue to Export";

  if (!report.repairNeeded) {
    const unresolved = report.proposals.filter(
      (p) => p.elementCount > 0 && (p.status === "unmatched" || p.status === "ambiguous")
    );
    detectionCalmState.hidden = false;
    detectionCalmState.className = unresolved.length ? "calm-state tone-warn" : "calm-state tone-ok";
    const correctDetail = report.alreadyCorrectStoreys
      ? `${report.alreadyCorrectStoreys} linked storey(s), containing ${report.alreadyCorrectElements} element(s), already use the matched master level name.`
      : "No linked storeys require a name update.";
    const title = unresolved.length ? "Review required" : "No repair needed";
    const detail = unresolved.length
      ? `${unresolved.length} linked storey(s) could not be assigned automatically. ${correctDetail}`
      : correctDetail;
    detectionCalmState.innerHTML = `${unresolved.length ? WARN_ICON : CHECK_ICON}<div><div class="calm-state-title">${title}</div><div class="calm-state-detail">${detail}</div></div>`;
    detectionMappingBlock.hidden = report.proposals.every((p) => p.elementCount === 0);
    advancedSettingsBlock.hidden = true;
    renderMappingList();
  } else {
    detectionCalmState.hidden = true;
    detectionMappingBlock.hidden = false;
    advancedSettingsBlock.hidden = false;
    renderMappingList();
  }

  // A proposal held back purely for an unconfirmed tower assignment (see
  // detector.js's selectRepairableProposals) must not be silently skipped by
  // clicking Repair without the user ever noticing -- block the button
  // entirely until each one is confirmed (individually, or via "Confirm all
  // shown" in the Needs Review tab) or repairNeeded is otherwise false, in
  // which case none can be pending anyway.
  const pending = report.proposals.filter(
    (p) => proposalNeedsAction(p) && p.assignmentConfident === false && !p.manualOverride
  ).length;
  if (pending > 0) {
    repairButton.disabled = true;
    pendingConfirmationNote.hidden = false;
    pendingConfirmationNote.textContent =
      `${pending} level(s) were matched to a block with low confidence and still need your confirmation before ` +
      `repairing -- see "Needs Review" above ("Confirm all shown" there, or review them individually).`;
  } else {
    repairButton.disabled = false;
    pendingConfirmationNote.hidden = true;
    pendingConfirmationNote.textContent = "";
  }
}

/**
 * Rows that landed in "Needs review" purely because their tower assignment
 * wasn't confident (see detector.js's selectRepairableProposals) -- not
 * because they're genuinely unmatched or have a large FFL gap. These already
 * have a real best-guess target; reviewing 300+ of them one row at a time
 * via the per-row "Change" control isn't practical, so this list backs a
 * single "confirm all shown" action instead. Confirming just means setting
 * the SAME best-guess target as a manual override -- it does not change
 * what target gets used, only that the user has looked at (a filtered view
 * of) them and accepted it as this run's confirmation.
 */
function uncertainButResolvedProposals() {
  return filterProposals(report, "review", guidFilter.value).filter(
    (p) => p.assignmentConfident === false && p.targetStoreyId != null && !p.manualOverride
  );
}

/** Renders the Master elevation map: tower tabs (multi-block only) plus the active tower's (or the single master's) elevation list. */
function renderElevationMap() {
  if (!report) return;
  elevationDiagramContainer.innerHTML =
    renderMasterElevationTabs(report, elevationTowerTab) + renderMasterElevations(report, elevationTowerTab);
}

elevationDiagramContainer.addEventListener("click", (event) => {
  const tab = event.target.closest(".elevation-tower-tab");
  if (!tab) return;
  elevationTowerTab = tab.dataset.blockGuid;
  renderElevationMap();
});

function renderMappingList() {
  if (!report) return;
  const matchedValue = el("chip-matched-value");
  const reviewValue = el("chip-review-value");
  if (matchedValue) matchedValue.textContent = String(filterProposals(report, "matched", guidFilter.value).length);
  if (reviewValue) reviewValue.textContent = String(filterProposals(report, "review", guidFilter.value).length);
  mappingList.innerHTML = renderProposalTable(report, mappingCategory, guidFilter.value, mappingSort, mappingMatchFilter, expandedBuildingIds);

  const uncertain = mappingCategory === "review" ? uncertainButResolvedProposals() : [];
  confirmUncertainBlock.hidden = uncertain.length === 0;
  if (uncertain.length > 0) {
    confirmUncertainText.textContent =
      `${uncertain.length} level(s) shown here have a proposed match, but the tower they were assigned to wasn't ` +
      `confident. Spot-check a few above, then confirm the rest at once if they look right.`;
  }
}

confirmUncertainButton.addEventListener("click", () => {
  const uncertain = uncertainButResolvedProposals();
  if (uncertain.length === 0) return;
  const additions = Object.fromEntries(uncertain.map((p) => [p.sourceStoreyId, p.targetStoreyId]));
  levelOverrides = { ...levelOverrides, ...additions };
  if (runDetection()) renderStep2();
});

// -- repair (runs in a Worker) -----------------------------------------------

// Only the "update" stage reports real processed/total counts (see
// repairWorker.js) -- open/analyze/validate/save are just stage-transition
// markers with no sub-progress of their own. Rather than showing an
// indeterminate bar for 4 of 5 stages, each stage claims a fixed slice of
// one continuous 0-100% range: entering a stage jumps the bar to that
// slice's start, and "update" (the dominant, genuinely long-running part
// for a large file) advances smoothly through its own slice via its own
// processed/total. This is what actually backs the single overall
// percentage the UI shows -- no per-stage label, just one number that only
// ever moves forward.
const STAGE_RANGE = {
  open: [0, 5],
  analyze: [5, 10],
  update: [10, 90],
  validate: [90, 96],
  save: [96, 100],
};

function resetProgressUI() {
  repairProgressBlock.hidden = true;
  repairError.hidden = true;
  repairButton.disabled = false;
  resetRobotProgress(robotProgress);
  progressBarFill.classList.remove("indeterminate");
  progressBarFill.style.width = "0%";
  progressPercent.textContent = "";
}

function overallRepairPct(stage, processed, total) {
  const range = STAGE_RANGE[stage];
  if (!range) return 0;
  const [lo, hi] = range;
  if (total != null && processed != null && total > 0) {
    return lo + (hi - lo) * Math.min(1, processed / total);
  }
  return lo;
}

function renderProgress() {
  const { stage, processed, total } = progressState;
  const pct = Math.round(overallRepairPct(stage, processed, total));
  progressBarFill.classList.remove("indeterminate");
  progressBarFill.style.width = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
  setRobotProgress(robotProgress, pct);
}

repairButton.addEventListener("click", () => {
  if (repairing) return; // duplicate-click guard
  if (!model || !originalBuffer) return;

  if (!runDetection()) return; // guarantee a fresh detection before repair, per spec
  renderStep2();

  // Release the main-thread WASM model before the worker parses its own copy.
  // Keeping both parsed models alive is a major peak-memory cost on large IFCs.
  closeModel(model);
  model = null;
  const workerBuffer = originalBuffer.slice(0);

  repairing = true;
  repairButton.disabled = true;
  repairError.hidden = true;
  repairProgressBlock.hidden = false;
  resetRobotProgress(robotProgress);

  progressState = { stage: "open", processed: null, total: null };
  renderProgress();
  progressTimer = setInterval(renderProgress, 200);

  worker = new Worker(new URL("./workers/repairWorker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "progress") {
      progressState.stage = msg.stage;
      progressState.processed = msg.processed ?? null;
      progressState.total = msg.total ?? null;
      renderProgress();
    } else if (msg.type === "done") {
      finishRepair(msg);
    } else if (msg.type === "error") {
      failRepair(msg.message);
    }
  };
  worker.onerror = (event) => failRepair(event.message || "Worker failed unexpectedly.");

  worker.postMessage({
    type: "run",
    payload: {
      buffer: workerBuffer,
      wasmBaseUrl: wasmBaseUrl(),
      tolerance: toleranceValue(),
      sourceName,
      overrides: levelOverrides,
    },
  }, [workerBuffer]);
});

function finishRepair(msg) {
  clearInterval(progressTimer);
  repairOutcome = { report: msg.report, result: msg.result, audit: msg.audit, validation: msg.validation, bytes: msg.bytes };

  progressState.stage = "save";
  progressOperation.textContent = "Done";
  progressBarFill.classList.remove("indeterminate");
  progressBarFill.style.width = "100%";
  progressPercent.textContent = "100%";
  setRobotProgress(robotProgress, 100);
  robotProgress.classList.remove("walking", "waiting");
  robotProgress.classList.add("celebrate");

  // Hold on the celebration a moment before advancing, so it's actually seen.
  setTimeout(() => {
    repairing = false;
    worker?.terminate();
    worker = null;
    goToStep(3);
  }, 1100);
}

function failRepair(message) {
  clearInterval(progressTimer);
  repairing = false;
  worker?.terminate();
  worker = null;
  if (!model && originalBuffer && ifcApi) {
    try {
      model = openModel(ifcApi, originalBuffer);
      currentBlockResult = detectProjectBlocks(model);
      runDetection();
    } catch (restoreError) {
      console.error("Failed to restore the source model after repair failure", restoreError);
    }
  }
  repairProgressBlock.hidden = true;
  resetRobotProgress(robotProgress);
  repairButton.disabled = false;
  repairError.hidden = false;
  repairError.innerHTML = `${WARN_ICON}<div><div class="calm-state-title">Repair failed</div><div class="calm-state-detail">${escapeHtml(message)}</div></div>`;
  console.error(message);
}

// -- step 3: export -----------------------------------------------------------

function downloadBlob(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function baseName(name) {
  const stem = name.replace(/\.[^./\\]+$/, "");
  return stem || "model";
}

function renderStep3() {
  const outcome = repairOutcome;
  const repaired = outcome?.result?.storeysUpdated > 0;

  step3Status.className = "calm-state tone-ok";
  if (repaired) {
    step3Status.innerHTML = `${CHECK_ICON}<div><div class="calm-state-title">Repair completed</div><div class="calm-state-detail">${outcome.result.storeysUpdated} linked storey name(s) updated. Original site hierarchy, element containment and geometry were preserved.</div></div>`;
  } else {
    step3Status.innerHTML = `${CHECK_ICON}<div><div class="calm-state-title">No changes were needed</div><div class="calm-state-detail">This file already matched the expected structure.</div></div>`;
  }

  const hasReport = !!outcome;
  exportPdfButton.disabled = !hasReport;
  exportCsvButton.disabled = !hasReport;
}

exportButton.addEventListener("click", () => {
  if (!repairOutcome) return;
  downloadBlob(repairOutcome.bytes, `${baseName(sourceName)}_repaired.ifc`, "application/octet-stream");
});

function currentReportData() {
  if (!repairOutcome) return null;
  return buildReportData({
    report: repairOutcome.report,
    result: repairOutcome.result,
    audit: repairOutcome.audit,
    validation: repairOutcome.validation,
    meta: {
      sourceName,
      schema,
      tolerance: toleranceValue(),
      generatedAt: new Date().toLocaleString(),
      appVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev",
    },
  });
}

exportPdfButton.addEventListener("click", () => {
  const data = currentReportData();
  if (!data) return;
  const bytes = renderPdfReport(data);
  downloadBlob(bytes, `${baseName(sourceName)}_repair_report.pdf`, "application/pdf");
});

exportCsvButton.addEventListener("click", () => {
  const data = currentReportData();
  if (!data) return;
  const csv = renderCsvReport(data);
  downloadBlob(new TextEncoder().encode(csv), `${baseName(sourceName)}_repair_report.csv`, "text/csv");
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
