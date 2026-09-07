# Revit Linked Model IfcStorey Repair

A static, client-side web app that detects a common Revit-to-IFC export defect
and fixes it: a unit built in a **linked model**, then linked into the master
model and copied across several storeys, often gets exported as its own
sibling `IfcBuilding` (with its own internal storeys) instead of being placed
under the master building's real storeys. This tool finds those linked
branches, works out where each linked storey *actually* sits using resolved
absolute elevation (never trusting its internal level name), and updates that
linked `IfcBuildingStorey` name to the matched master level. The original
`IfcSite` / `IfcBuilding` / `IfcBuildingStorey` hierarchy and every product
containment relationship remain unchanged.

Everything runs **entirely in the browser** via [web-ifc](https://github.com/ThatOpen/engine_web-ifc)
(WebAssembly). No file is ever uploaded anywhere, which is also why this ships
as a static site: it can be hosted on GitHub Pages (or opened locally) with no
backend at all.

## Why this happens

In Revit: a unit lives in `Unit.rvt`, gets linked into `Master.rvt`, and is
copied onto storeys 1–4. On IFC export, Revit may emit:

```
IfcSite
├── IfcBuilding "Master Building"
│   ├── IfcBuildingStorey "1st Storey"
│   ├── IfcBuildingStorey "2nd Storey"
│   ├── IfcBuildingStorey "3rd Storey"
│   └── IfcBuildingStorey "4th Storey"
├── IfcBuilding "Unit A - Instance 1"      <- linked instance, placed at Z=0
│   └── IfcBuildingStorey "Base Level"     <- misleading name, elements really at Z=0
├── IfcBuilding "Unit A - Instance 2"      <- linked instance, placed at Z=3600
│   └── IfcBuildingStorey "1st Storey"     <- misleading name, elements really at Z=3600
├── IfcBuilding "Unit A - Instance 3"      <- placed at Z=7200
│   └── IfcBuildingStorey "Base Level"
└── IfcBuilding "Unit A - Instance 4"      <- placed at Z=10800
    └── IfcBuildingStorey "Top Level"
```

The internal storey *names* are copies of the linked model's own levels and
tell you nothing about where the unit actually is in the master building. The
only reliable signal is the **resolved absolute Z** of each linked storey —
found by walking the placement chain up to the world origin (via web-ifc's
`GetWorldTransformMatrix`) — matched against the master storeys' absolute Z.

## Run it locally

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL. That's it — no server-side
component, no database, no API keys.

To build the static site exactly as it will be deployed:

```bash
npm run build      # outputs dist/
npm run preview    # serves dist/ locally so you can sanity-check the build
```

## Deploy to GitHub Pages

A workflow at [.github/workflows/deploy.yml](.github/workflows/deploy.yml) is
included: push to `main` and it runs the tests, builds, and publishes `dist/`
to GitHub Pages automatically. One-time setup in the repo: **Settings → Pages
→ Source → GitHub Actions**. `vite.config.js` sets `base: './'` so the built
site works at any subpath (`https://<user>.github.io/<repo>/`) without further
configuration.

To deploy manually instead: `npm run build` and push the contents of `dist/`
to whatever branch/host you use for Pages.

## Use it

A left-hand stepper tracks three stages; only the current one is expanded, and
completed ones collapse to a compact summary (Step 1 becomes a one-line file
card). Click back into any completed step to change a setting and redo the
rest.

1. **Load IFC** — drag & drop or click "Choose IFC File…". Detection runs
   automatically and the app advances to Step 2.
2. **Review & Repair** — summary chips, a collapsible master elevation list,
   and proposal tables grouped by linked building. Matched and review-required
   rows can be searched by GUID, and uncertain tower assignments or duplicate
   target names within one source building stay in review until resolved. The
   matching tolerance is under **Advanced settings** (collapsed by default;
   tolerance defaults to 150mm and changes re-run detection immediately).
   Tolerance only ever snaps a reference that lands very
   close to a master-storey boundary onto that boundary — it never widens how
   far into a storey's interval a match can reach. If nothing needs fixing, a
   calm "No repair needed" banner replaces the diagram/list and the button
   below reads "Continue to Export" instead. Otherwise, clicking **Repair
   IFC** re-confirms detection is current and immediately starts repairing —
   no separate confirmation screen.
3. **Export** — "Repair completed" (or "No changes were needed") status,
   **Download Fixed IFC**, **PDF Report**, and **CSV Report**. Your original
   file on disk is never touched — a browser download can only ever create a
   new file.

### Repair progress

The actual repair runs in a **Web Worker** (`src/workers/repairWorker.js`) so
the page stays responsive, with a progress bar, current operation, and
elapsed time shown live. The linked-storey update stage is measurable and
shows a real `processed / total` count plus an ETA once at least one item has
completed; the others (opening, analyzing, validating, saving) have no meaningful per-item progress in
web-ifc, so they show an indeterminate indicator instead of an invented
percentage. A small hand-drawn construction-robot animation runs above the
bar purely for charm — idle-bobbing near the upload area, "walking" on a
fixed loop during repair (never tied to the real percentage, so it can't be
mistaken for the actual progress bar), and a brief block-placement
celebration on completion. It respects `prefers-reduced-motion`. The Repair
button is disabled for the whole run to prevent duplicate clicks, and
completion is only shown after the repair *and* the post-repair validation
checks (see below) have both finished.

### Validation checks

After every repair, the worker reopens the finished IFC and `validateRepair()`
confirms that every linked storey keeps its GUID, placement, elevation and
original parent; every product remains under that same storey with its GUID
and placement unchanged; and the storey name matches the proposed master level. These
are the checks listed in the PDF report — nothing is ever reported as
"passed" without actually running it.

## What the repair does and does not touch

Only the linked `IfcBuildingStorey.Name` and `LongName` STEP fields are
changed. The storey GUID, `ObjectPlacement`, `Elevation`, parent aggregation
and `IfcRelContainedInSpatialStructure` relationships are preserved. Products,
geometry, materials, property sets and all other relationships are untouched.
This is verified in `tests/repairer.test.js` and against the real `UPL.ifc`.

## Project layout

```
src/
  core/
    ifcModel.js         thin wrapper over web-ifc's IfcAPI: open/save, and
                         generic spatial-structure helpers
    detector.js          picks the master building, classifies every other
                         building's storeys into a match status (High/Medium/
                         Unmatched/Ambiguous) by resolved elevation;
                         selectRepairableProposals() is the single source of
                         truth for "what gets repaired given these settings",
                         shared by the UI preview and the worker
    repairer.js           builds and validates hierarchy-preserving linked
                         storey metadata updates; buildElementAudit()
                         builds the full per-element record set (updated +
                         skipped + unresolved) the reports are built from;
                         validateRepair() runs the real post-repair checks
    stepPatcher.js        copies only Name/LongName STEP tokens from the
                         matched master storey into each linked storey
    elevationDiagram.js   pure data -> layout -> SVG for the Review & Repair
                         elevation map (buildElevationDiagram is unit-testable
                         without touching markup)
    report.js             buildReportData() is the single source of truth for
                         both renderers (renderPdfReport, renderCsvReport),
                         so their counts can never disagree
  workers/
    repairWorker.js       re-opens its own web-ifc instance from a copy of the
                         file bytes and runs analyze -> applyRepair -> patch
                         names -> reopen -> validate,
                         posting progress messages back to the main thread
  main.js                 UI wiring + the 3-step state machine -- no repair
                         logic lives here
  style.css
index.html
tests/
  fixtures/               clean file, linked-branch defect, and a
                         classification fixture covering all four
                         match-status bands (plus a Pset_BuildingStoreyCommon
                         regression case, see below)
  detector.test.js, repairer.test.js, classification.test.js,
  elevationDiagram.test.js, report.test.js, progress.test.js, audit.test.js
public/
  web-ifc*.wasm           the web-ifc WASM binaries (copied here, not fetched
                         from a CDN, so the whole app is self-contained and
                         works offline once loaded)
```

Core logic (`src/core`) has no dependency on the UI:

```js
import { createIfcApi, openModel } from "./core/ifcModel.js";
import { detectProjectBlocks } from "./core/blockDetection.js";
import { analyze, selectRepairableProposals } from "./core/detector.js";
import { applyRepair, buildElementAudit, validateRepair } from "./core/repairer.js";
import { buildReportData, renderPdfReport } from "./core/report.js";
import { patchIfcStoreyNames } from "./core/stepPatcher.js";

const api = await createIfcApi();
const sourceBytes = new Uint8Array(arrayBufferOfIfcFile);
const model = openModel(api, sourceBytes);
const blocks = detectProjectBlocks(model);
const report = analyze(model, { sourceName: "model.ifc", blocks });

if (report.repairNeeded) {
  const selected = new Set(selectRepairableProposals(report).map((p) => p.sourceStoreyId));
  const result = applyRepair(model, report, { selectedStoreyIds: selected });
  const audit = buildElementAudit(model, report, result);
  const bytes = patchIfcStoreyNames(sourceBytes, result.renameChanges);
}
```

## How master-building / branch detection works

1. Read every `IfcBuilding` under the `IfcProject` (not assumed to share one
   `IfcSite` — a linked branch can carry its own, distinct `IfcSite`) and its
   decomposed `IfcBuildingStorey` children (recursively, matching how
   IfcOpenShell's `get_decomposition` works). All elevations are converted to
   millimetres via the file's own `IfcUnitAssignment` before anything is
   compared — a metres-denominated file's `3.6` and a millimetres file's
   `3600` must compare equal.
2. Score every building with at least two storeys as a possible reference
   ladder using storey count, resolved vertical extent and contained products.
   A zero-product building remains eligible because Revit may place all of a
   tower's products in sibling linked-instance buildings. Progressive storey
   naming contributes at most a 10% supporting bonus and never identifies a
   tower by itself.
3. Separate short overlapping podium/base buildings from the surviving block
   anchors. Buildings below the comparative score split become linked or
   unclassified candidates according to whether they contain products.
4. For multiple blocks, assign candidates by rendered product footprint when
   every tower has usable geometry. If a valid anchor is empty, a candidate is
   trusted by placement only when at least two instances repeat at the same
   uniquely matching tower origin. Shared or isolated placements require
   review.
5. Compare storey names across detected blocks as a diagnostic only. Reused or
   similar names can support review, but never override physical geometry,
   placement-stack evidence or the confidence gate.
6. The resulting preflight classification is authoritative for detection and
   repair. No later stage independently chooses another master building.

### Interval containment, not nearest-neighbour

Each linked storey's own resolved elevation (its "source storey reference" —
see below) is matched against the master storeys using **interval
containment**: sorted master storeys split the elevation axis into
`[storey.elevation, nextStorey.elevation)` bands, and a reference belongs to
the band it falls inside — however large the gap to that band's lower edge
is. This deliberately replaces an earlier "nearest storey within a distance
threshold" design: a linked storey 6+ metres above its matched master storey,
with no *other* master storey elevation in between, is still a correct match,
not something a distance threshold should reject.

`storeyMatchTolerance` (default 150mm) plays one narrow role: snapping a
reference that lands within tolerance of a master storey's own elevation onto
that boundary, so trivial rounding noise from the original export doesn't
register as "1479mm below" instead of "at" a storey. It never widens how far
into a storey's interior a match can reach.

Per linked storey, `detector.js` produces one of:
- **matched** — the reference falls in exactly one storey's interval (or
  snaps onto exactly one boundary within tolerance). It is eligible under
  the selected source-storey reference policy unless tower assignment is
  uncertain or a same-building duplicate target requires review.
- **ambiguous-boundary** — the reference is within tolerance of *two* master
  storeys at once (e.g. two master storeys only 20mm apart). No target;
  needs manual review.
- **below-lowest** / **above-highest** — the reference sits below the lowest
  master storey, or above the highest one with no upper bound to contain it.
  Never silently forced into the nearest storey, regardless of how close it
  is (only a within-tolerance boundary snap can bridge that gap).
- **missing-placement** — the linked storey itself has no resolvable
  `ObjectPlacement`. Never defaults to elevation 0 (which could coincidentally
  collide with a real master storey); reported as unmatched instead.

Only **matched** proposals ever get a non-null target — every other case is
structurally impossible for `repairer.js` to act on, even if a caller tries
to force it in.

### Reference basis: four distinct concepts, never conflated

The elevation used for matching (the "bottom reference") is explicitly one
of two tiers, always labelled honestly:
- **Source storey reference** (the fallback, and what every proposal
  currently uses): the linked storey's own resolved elevation. This is
  *not* a verified base for any individual element — it's the best
  available signal in the absence of one.
- **Element placement** (reserved for a genuinely reliable per-element base
  reference, e.g. an authored base-offset property) — no current code path
  produces this, because an element's raw `IfcLocalPlacement` origin is not
  assumed to represent its true bottom (an MEP proxy's insertion point can
  sit mid-height; a wall's local origin can sit above its storey by a slab
  thickness). Verified empirically against both a synthetic fixture and a
  real Revit export: treating "this element's own placement resolves to a
  different storey than the fallback" as a contradiction produced false
  positives on ordinary, correctly-placed elements in both, so it is not
  used as an automatic per-element override — only the fallback is used,
  honestly labelled as such.

All elements sharing one linked storey share that storey's fallback
reference and are proposed as a single group — see `detector.js`'s
file-header comment for the full reasoning, including why a per-element
geometric-bottom evaluation (the fourth concept: the lowest point of an
element's actual geometry) isn't attempted either.

Elements attached directly to a linked building (not via any storey) are
flagged as a warning and left alone — they fall outside storey-level name
repair and need manual attention.

## Testing

```bash
npm test
```

The suite (Vitest, running web-ifc's Node/WASM build) covers:
- **Clean file**: single building, elements already on master storeys →
  `repairNeeded: false`, zero linked storeys proposed for update.
- **Defective file**: master building + 4 linked branches at matching
  elevations but deliberately *wrong*, reused internal storey names → every
  branch is matched to its correct master storey purely by resolved
  elevation, and repair updates each linked storey name in place.
- **Classification fixture** (`tests/fixtures/classification_scenarios.ifc`,
  built specifically for this): a master building whose storeys are 0 / 3000 /
  3020 / 6000mm apart (3000 and 3020 only 20mm apart, on purpose) plus four
  linked branches, each engineered to exercise one interval-matching outcome:
  a near-boundary snap (High), a genuine interior-interval match with a large
  gap (Medium — proving a clean interval never gets promoted past Medium on a
  fallback reference), an above-the-highest-storey miss with no upper bound
  (Unmatched, never silently forced in), and a reference within tolerance of
  two boundaries at once (Ambiguous). Also verifies that narrowing/widening
  tolerance moves a reference between these outcomes and that repair only
  ever touches proposals with a real target.
- **Unit conversion** (`tests/units.test.js`, `tests/fixtures/metres_units.ifc`):
  a file authored entirely in metres (not millimetres) still classifies an
  exact boundary match correctly once elevations are converted to a common
  unit via `IfcUnitAssignment`.
- **UPL.ifc acceptance** (`tests/upl-acceptance.test.js`): a real, 108MB
  Revit export kept outside the repo (the suite skips itself if the file
  isn't present on the machine running the tests). Confirms — by discovering
  every value from the live file at runtime, never hard-coding a name,
  elevation, GUID, or count — that a linked storey many metres above its
  matched master storey, with no other master storey elevation in between,
  proposes a genuine interior-interval match capped at Medium confidence;
  that it's gated behind "only high confidence" by default but selectable
  when that's turned off; that no element's own placement contradicts the
  fallback (logged as a warning if one ever does, without failing the test);
  and that the `Level 0` / `Level 1` storeys retain their original linked
  `IfcSite`, building parent, GUIDs, elevations, placements and contained
  products after a full save/reload round trip.
- Repair preserves every site/building/storey branch, GUID, `ObjectPlacement`,
  `Elevation`, product containment relationship and element type.
- Re-running detection after a repair reports the renamed linked storeys as
  already correct while still detecting and reporting their linked branches.
- `elevationDiagram.test.js`: the elevation-map layout classifies every
  branch into exactly one of matched/review/unmatched, and clamps
  far-outside-range branches to the plotted domain instead of distorting the
  scale.
- `report.test.js`: the PDF and CSV are built from the exact same
  `buildReportData()` output, so their counts (and the element-level appendix
  row count) can never disagree; validation checks are only ever marked
  `performed: true`.
- `progress.test.js`: the `onProgress` callback fires once per proposal/
  branch with a correctly increasing `processed` count, and never fires at
  all when there's nothing to do.
- `audit.test.js`: the element-level audit accounts for every element across
  updated, skipped, and unresolved proposals with no double-counting.

This was also validated end-to-end against a real, non-synthetic Revit export
exhibiting exactly this defect (5 buildings under one site, master storeys
initially empty, 4 linked branches each holding 9 elements under a misleadingly
named internal storey) — detection, repair, save, reload, the Web Worker
pipeline, and the generated PDF/CSV reports all produced the expected result,
both in dev mode and against a production build (`npm run build && npm run
preview`).
