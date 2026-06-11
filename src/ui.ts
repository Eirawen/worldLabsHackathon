import type { SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import {
  buildClickContext,
  setProviderPreference,
  setSecondaryScreenshotForNextCommand,
  type processCommand as processCommandFn,
} from "./agent";
import { buildLocalSelection, formatSelectionHint } from "./click-selection";
import { transformOperations, setInfillHandler, type executeOperations as executeOperationsFn, type undoLastEdit as undoLastEditFn, type undoN as undoNFn } from "./executor";
import { generateInfill } from "./infill";
import type { processRefinement as processRefinementFn } from "./agent";
import {
  fitSelectionShapes,
  formatObjectSelectionHint,
  growSelection,
  selectionHighlightPositions,
  snapOperationsToSelection,
} from "./object-selection";
import { refineEdit } from "./refine";
import { getSamStatus, onSamStatus, preloadSam, segmentSelectionWithSam } from "./sam-segmentation";
import { getManifestJSON } from "./scene-manifest";
import { buildLocalGrid, getCellAtWorldPos, getNeighborCells, serializeLocalGridForLLM, type CachedSplatData } from "./spatial-index";
import type {
  AssetEntry,
  EditOperation,
  ObjectSelection,
  SceneManifest,
  ScreenshotWithCamera,
  SDFShapeConfig,
  SpatialGrid,
} from "./types";

type ProcessCommand = typeof processCommandFn;
type ExecuteOperations = typeof executeOperationsFn;
type UndoLastEdit = typeof undoLastEditFn;
type UndoN = typeof undoNFn;
type ProcessRefinement = typeof processRefinementFn;

export interface UIDependencies {
  processCommand: ProcessCommand;
  executeOperations: ExecuteOperations;
  undoLastEdit: UndoLastEdit;
  undoN: UndoN;
  processRefinement: ProcessRefinement;
  getSplatMesh: () => SplatMesh;
  getScreenshot: () => string;
  getScreenshotCropAroundPoint?: (point: THREE.Vector3, sizePx?: number) => string | null;
  getGrid: () => SpatialGrid | null;
  getManifest: () => SceneManifest | null;
  getLastClickPoint: () => THREE.Vector3 | null;
  getCachedSplatData?: () => CachedSplatData | null;
  getScreenshotWithCamera?: () => ScreenshotWithCamera;
  showSelectionHighlight?: (positions: Float32Array) => void;
  clearSelectionHighlight?: () => void;
  onSplatClick?: (callback: (point: THREE.Vector3) => void) => () => void;
  listAssets?: () => readonly AssetEntry[];
  getAssetById?: (id: string) => AssetEntry | undefined;
  createPlacedAssetMesh?: (asset: AssetEntry, worldPos: THREE.Vector3) => SplatMesh;
  getPlacementParent?: () => THREE.Object3D;
}

let toastContainer: HTMLDivElement | null = null;
let initialized = false;
const ENABLE_CLICK_SELECTION_HINTS =
  String(import.meta.env.VITE_ENABLE_CLICK_SELECTION_HINTS ?? "true").toLowerCase() !==
  "false";
const CROP_SIZE_PX = 320;
const MIN_SELECTION_CONFIDENCE = 0.2;
const DEFAULT_PROVIDER =
  String(import.meta.env.VITE_DEFAULT_LLM_PROVIDER ?? "gemini").toLowerCase() === "openai"
    ? "openai"
    : "gemini";

export function initUI(deps: UIDependencies): void {
  if (initialized) {
    console.log("[ui] initUI skipped (already initialized)");
    return;
  }
  initialized = true;
  console.log("[ui] Initializing chat + library UI");
  console.log(
    `[ui] Selection config: hintsEnabled=${ENABLE_CLICK_SELECTION_HINTS} minConfidence=${MIN_SELECTION_CONFIDENCE.toFixed(2)} cropPx=${CROP_SIZE_PX}`
  );

  // Register infill handler for hole-filling after delete operations
  setInfillHandler((shapes, opts) => {
    const grid = deps.getGrid();
    if (!grid) return null;
    return generateInfill(shapes, grid, opts);
  });

  const container = document.createElement("div");
  container.id = "muse-chat-container";

  const messages = document.createElement("div");
  messages.id = "muse-messages";

  const inputRow = document.createElement("div");
  inputRow.id = "muse-input-row";

  const input = document.createElement("input");
  input.id = "muse-input";
  input.type = "text";
  input.placeholder = "Talk to this world...";
  input.autocomplete = "off";

  const sendButton = document.createElement("button");
  sendButton.id = "muse-send-btn";
  sendButton.type = "button";
  sendButton.textContent = "→";

  const undoButton = document.createElement("button");
  undoButton.id = "muse-undo-btn";
  undoButton.type = "button";
  undoButton.textContent = "↩";

  const providerButton = document.createElement("button");
  providerButton.id = "muse-provider-btn";
  providerButton.type = "button";
  providerButton.textContent = "Gemini";

  const status = document.createElement("div");
  status.id = "muse-status";

  inputRow.append(input, sendButton, undoButton, providerButton);
  container.append(messages, inputRow, status);
  document.body.append(container);

  const library = document.createElement("aside");
  library.id = "muse-library";

  const libraryHeader = document.createElement("div");
  libraryHeader.id = "muse-library-header";
  libraryHeader.textContent = "Asset Library";

  const libraryStatus = document.createElement("div");
  libraryStatus.id = "muse-library-status";

  const libraryList = document.createElement("div");
  libraryList.id = "muse-library-list";

  library.append(libraryHeader, libraryStatus, libraryList);
  document.body.append(library);

  toastContainer = document.createElement("div");
  toastContainer.id = "muse-toast-container";
  document.body.append(toastContainer);

  let selectedAssetId: string | null = null;
  let lastEditGroupSize = 0;
  let lastAppliedOps: EditOperation[] | null = null;
  let lastAppliedParent: THREE.Object3D | null = null;
  let correctionRow: HTMLDivElement | null = null;
  let activeSelection: ObjectSelection | null = null;
  let activeSelectionShapes: SDFShapeConfig[] | null = null;
  let selectionSeq = 0;
  let provider: "gemini" | "openai" = DEFAULT_PROVIDER;
  setProviderPreference(provider);
  providerButton.textContent = provider === "gemini" ? "Gemini" : "OpenAI";

  setStatus(status, "Click an object, then type a command");
  setLibraryStatus(libraryStatus, "No asset selected");
  appendMessage(
    messages,
    "system",
    "Click an object, then type a command. Try: 'remove this' or 'add warm lighting'"
  );

  // Warm up the in-browser SAM model so click segmentation is ready by the
  // time the user starts editing. Falls back to region growing until then.
  onSamStatus((samStatus, detail) => {
    if (samStatus === "ready") {
      showToast("Click segmentation ready (SAM)", 2200);
    } else if (samStatus === "error") {
      console.warn(`[ui] SAM unavailable: ${detail ?? "unknown"}; using region growing only`);
    }
  });
  void preloadSam();

  const renderLibrary = () => {
    libraryList.replaceChildren();

    if (!deps.listAssets || !deps.getAssetById || !deps.createPlacedAssetMesh || !deps.getPlacementParent) {
      const disabled = document.createElement("div");
      disabled.className = "muse-library-empty";
      disabled.textContent = "Asset placement unavailable.";
      libraryList.append(disabled);
      return;
    }

    const assets = deps.listAssets();
    if (assets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muse-library-empty";
      empty.textContent = "No extracted assets yet.";
      libraryList.append(empty);
      return;
    }

    for (const asset of assets) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "muse-asset-item";
      if (asset.id === selectedAssetId) {
        item.classList.add("active");
      }

      const label = document.createElement("div");
      label.className = "muse-asset-label";
      label.textContent = asset.label;

      const meta = document.createElement("div");
      meta.className = "muse-asset-meta";
      meta.textContent = `${asset.splatCount.toLocaleString()} splats`;

      item.append(label, meta);
      item.addEventListener("click", () => {
        const wasSelected = selectedAssetId === asset.id;
        selectedAssetId = wasSelected ? null : asset.id;
        if (wasSelected) {
          showToast("Placement canceled", 1500);
          setLibraryStatus(libraryStatus, "No asset selected");
        } else {
          showToast(`Placement armed: ${asset.label}`);
          setLibraryStatus(libraryStatus, `Placement mode: ${asset.label}`);
        }
        renderLibrary();
      });

      libraryList.append(item);
    }
  };

  const dismissCorrectionButtons = () => {
    if (correctionRow) {
      correctionRow.remove();
      correctionRow = null;
    }
    lastAppliedOps = null;
    lastAppliedParent = null;
  };

  const showCorrectionButtons = () => {
    dismissCorrectionButtons();
    if (!lastAppliedOps || !lastAppliedParent) return;

    correctionRow = document.createElement("div");
    correctionRow.className = "muse-correction-row";

    const grid = deps.getGrid();
    const step = grid ? Math.max(grid.cellSize.x, grid.cellSize.y, grid.cellSize.z) * 0.5 : 0.2;

    const buttons: Array<{ label: string; transform: Parameters<typeof transformOperations>[1]; className?: string }> = [
      { label: "Bigger", transform: { scaleMultiplier: 1.25 } },
      { label: "Smaller", transform: { scaleMultiplier: 0.8 } },
      { label: "← Left", transform: { positionOffset: [-step, 0, 0] } },
      { label: "→ Right", transform: { positionOffset: [step, 0, 0] } },
      { label: "↑ Up", transform: { positionOffset: [0, step, 0] } },
      { label: "↓ Down", transform: { positionOffset: [0, -step, 0] } },
    ];

    for (const btn of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `muse-correction-btn${btn.className ? ` ${btn.className}` : ""}`;
      el.textContent = btn.label;
      el.addEventListener("click", () => {
        if (!lastAppliedOps || !lastAppliedParent) return;
        deps.undoN(lastEditGroupSize);
        const transformed = transformOperations(lastAppliedOps, btn.transform);
        const newEdits = deps.executeOperations(transformed, lastAppliedParent);
        lastAppliedOps = transformed;
        lastEditGroupSize = newEdits.length;
        showToast(`Adjusted: ${btn.label}`, 1200);
      });
      correctionRow.append(el);
    }

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "muse-correction-btn accept";
    acceptBtn.textContent = "Accept";
    acceptBtn.addEventListener("click", () => {
      dismissCorrectionButtons();
      showToast("Edit accepted", 1200);
    });
    correctionRow.append(acceptBtn);

    messages.append(correctionRow);
    messages.scrollTop = messages.scrollHeight;
  };

  renderLibrary();

  const clearActiveSelection = () => {
    activeSelection = null;
    activeSelectionShapes = null;
    deps.clearSelectionHighlight?.();
  };

  const applyObjectSelection = (selection: ObjectSelection, data: CachedSplatData) => {
    activeSelection = selection;
    activeSelectionShapes = fitSelectionShapes(selection, data);
    deps.showSelectionHighlight?.(selectionHighlightPositions(selection, data));
    setStatus(
      status,
      `Selected ${selection.splatCount.toLocaleString()} splats (${selection.source}, ${(selection.confidence * 100).toFixed(0)}%)`
    );
    console.log(
      `[ui] Object selection active: source=${selection.source} splats=${selection.splatCount} shapes=${activeSelectionShapes.length} confidence=${selection.confidence.toFixed(3)}`
    );
  };

  const runObjectSelection = (point: THREE.Vector3) => {
    const data = deps.getCachedSplatData?.();
    if (!data) {
      return;
    }
    const seq = ++selectionSeq;
    clearActiveSelection();

    // Fast deterministic pass shows up immediately...
    const grown = growSelection(point, data);
    if (grown) {
      applyObjectSelection(grown, data);
    } else {
      setStatus(status, "No object found at click");
    }

    // ...then SAM upgrades it asynchronously when the model is ready.
    if (getSamStatus() === "ready" && deps.getScreenshotWithCamera) {
      const screenshot = deps.getScreenshotWithCamera();
      void segmentSelectionWithSam({ click: point.clone(), data, screenshot })
        .then((samSelection) => {
          if (samSelection && seq === selectionSeq) {
            applyObjectSelection(samSelection, data);
          }
        })
        .catch((error) => {
          console.warn("[ui] SAM segmentation failed; keeping region-grow selection", error);
        });
    }
  };

  if (deps.onSplatClick) {
    deps.onSplatClick((point) => {
      if (!selectedAssetId) {
        runObjectSelection(point);
        return;
      }
      if (!deps.getAssetById || !deps.createPlacedAssetMesh || !deps.getPlacementParent) {
        showToast("Placement APIs unavailable", 1800);
        selectedAssetId = null;
        setLibraryStatus(libraryStatus, "No asset selected");
        renderLibrary();
        return;
      }

      const asset = deps.getAssetById(selectedAssetId);
      if (!asset) {
        showToast("Selected asset no longer exists", 1800);
        selectedAssetId = null;
        setLibraryStatus(libraryStatus, "No asset selected");
        renderLibrary();
        return;
      }

      try {
        const mesh = deps.createPlacedAssetMesh(asset, point.clone());
        deps.getPlacementParent().add(mesh);
        appendMessage(messages, "assistant", `Placed asset: ${asset.label}`);
        showToast(`Placed: ${asset.label}`);
      } catch (error) {
        console.error("[ui] Failed to place asset", error);
        showToast("Placement failed", 2000);
      } finally {
        selectedAssetId = null;
        setLibraryStatus(libraryStatus, "No asset selected");
        renderLibrary();
      }
    });
  }

  const setBusy = (busy: boolean) => {
    console.log(`[ui] setBusy(${busy})`);
    input.disabled = busy;
    sendButton.disabled = busy;
    undoButton.disabled = busy;
    providerButton.disabled = false;
    if (!busy) {
      input.focus();
    }
  };

  const handleSend = async () => {
    const command = input.value.trim();
    if (!command) {
      console.log("[ui] Ignoring empty command");
      return;
    }

    dismissCorrectionButtons();
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const assetsBefore = deps.listAssets?.().length ?? 0;
    appendMessage(messages, "user", command);
    setBusy(true);
    setStatus(status, "Thinking...");
    console.log(`[ui] Processing command="${command}"`);

    try {
      const clickPoint = deps.getLastClickPoint();
      const grid = deps.getGrid();
      const manifest = deps.getManifest();
      const splatMesh = deps.getSplatMesh();
      const screenshot = normalizeScreenshotDataUrl(deps.getScreenshot());
      const screenshotCrop =
        clickPoint && deps.getScreenshotCropAroundPoint
          ? normalizeScreenshotDataUrl(
              deps.getScreenshotCropAroundPoint(clickPoint, CROP_SIZE_PX) ?? ""
            )
          : "";
      const apiKey = readGeminiApiKey();

      console.log(
        `[ui] Context: click=${formatVec3OrNull(clickPoint)} grid=${grid ? "ready" : "null"} manifest=${manifest ? "ready" : "null"} screenshotBytes=${screenshot.length} cropBytes=${screenshotCrop.length} apiKeyPresent=${apiKey.length > 0}`
      );

      const preciseHint =
        activeSelection && activeSelectionShapes && activeSelectionShapes.length > 0
          ? formatObjectSelectionHint(activeSelection, activeSelectionShapes)
          : null;
      const voxelContext = buildVoxelContext(grid, clickPoint, preciseHint);
      const manifestSummary = manifest ? getManifestJSON(manifest) : null;
      setSecondaryScreenshotForNextCommand(screenshotCrop || null);

      // Compute selection hint separately for reuse in refinement
      let selectionHint: string | null = null;
      if (ENABLE_CLICK_SELECTION_HINTS && grid && clickPoint) {
        const sel = buildLocalSelection(grid, clickPoint);
        if (sel && sel.confidence >= MIN_SELECTION_CONFIDENCE) {
          selectionHint = formatSelectionHint(sel);
        }
      }
      console.log(
        `[ui] Prompt payload: voxelContextChars=${voxelContext?.length ?? 0} manifestChars=${manifestSummary?.length ?? 0}`
      );

      const rawOperations = await deps.processCommand(
        command,
        clickPoint,
        voxelContext,
        manifestSummary,
        screenshot,
        apiKey
      );
      console.log(`[ui] Agent returned ${rawOperations.length} operation(s)`);
      console.log(`[ui] Operation summary: ${summarizeOperations(rawOperations)}`);

      // Snap operations that target the clicked object onto the precise
      // splat-level selection shapes — the LLM decides *what* to do, the
      // segmentation decides *where*.
      let operations = rawOperations;
      if (activeSelection && activeSelectionShapes && activeSelectionShapes.length > 0) {
        const snapped = snapOperationsToSelection(
          rawOperations,
          activeSelection,
          activeSelectionShapes
        );
        if (snapped.snappedCount > 0) {
          operations = snapped.ops;
          showToast(
            `Snapped ${snapped.snappedCount} edit${snapped.snappedCount === 1 ? "" : "s"} to ${activeSelection.source} selection`,
            2000
          );
        }
      }

      const appliedEdits = deps.executeOperations(operations, splatMesh);
      console.log("[ui] Executor applied operations");
      clearActiveSelection();

      // Refine targeted edits (delete, recolor) but not atmosphere/light
      const isTargetedEdit = operations.some(
        (op) => op.action === "delete" || op.action === "recolor" || op.action === "tint"
      );
      let refinementNote = "";
      let totalEditsForUndo = appliedEdits.length;

      if (isTargetedEdit) {
        setStatus(status, "Refining...");
        try {
          const result = await refineEdit(
            operations,
            appliedEdits,
            command,
            clickPoint,
            splatMesh,
            screenshot || null,
            screenshotCrop || null,
            selectionHint,
            {
              processRefinement: deps.processRefinement,
              executeOperations: (ops, parent) => deps.executeOperations(ops, parent),
              undoN: deps.undoN,
              getScreenshot: deps.getScreenshot,
              getScreenshotCropAroundPoint: deps.getScreenshotCropAroundPoint,
              getApiKey: readGeminiApiKey,
            }
          );
          totalEditsForUndo = result.totalEditsApplied;
          if (result.iterations > 0) {
            refinementNote = result.accepted
              ? ` (refined in ${result.iterations} iteration${result.iterations === 1 ? "" : "s"})`
              : ` (refinement: ${result.reason})`;
          }
          console.log(
            `[ui] Refinement complete: iterations=${result.iterations} accepted=${result.accepted} totalEdits=${result.totalEditsApplied}`
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[ui] Refinement failed: ${msg}`);
        }
      }

      appendMessage(
        messages,
        "assistant",
        `Applied ${operations.length} operation${operations.length === 1 ? "" : "s"}.${refinementNote}`
      );

      for (const op of operations) {
        const summary = op.assetLabel ?? `${op.shapes.length} shape${op.shapes.length === 1 ? "" : "s"}`;
        showToast(`✓ ${op.action}: ${summary}`);
      }

      // Store undo count for grouped undo
      lastEditGroupSize = totalEditsForUndo;

      // Show correction buttons for targeted edits
      if (isTargetedEdit) {
        lastAppliedOps = operations;
        lastAppliedParent = splatMesh;
        showCorrectionButtons();
      }

      renderLibrary();
      const assetsAfter = deps.listAssets?.().length ?? assetsBefore;
      const createdCount = Math.max(0, assetsAfter - assetsBefore);
      if (createdCount > 0) {
        showToast(`Saved ${createdCount} asset${createdCount === 1 ? "" : "s"}`);
        appendMessage(
          messages,
          "system",
          `Saved ${createdCount} asset${createdCount === 1 ? "" : "s"} to library.`
        );
      }

      setStatus(status, "Ready");
      input.value = "";
      const elapsedMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
      console.log(`[ui] Command complete in ${elapsedMs.toFixed(1)}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ui] Command failed", error);
      appendMessage(messages, "error", `Error: ${message}`);
      showToast("Command failed", 2500);
      setStatus(status, "Ready");
    } finally {
      setBusy(false);
    }
  };

  sendButton.addEventListener("click", () => {
    void handleSend();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSend();
    }
  });

  undoButton.addEventListener("click", () => {
    console.log("[ui] Undo button clicked");
    dismissCorrectionButtons();
    if (lastEditGroupSize > 1) {
      const undone = deps.undoN(lastEditGroupSize);
      lastEditGroupSize = 0;
      if (undone > 0) {
        appendMessage(messages, "system", `Undid ${undone} edit${undone === 1 ? "" : "s"}.`);
        showToast(`↩ Undid ${undone} edits`);
      } else {
        showToast("No edits to undo", 1800);
      }
    } else {
      const undone = deps.undoLastEdit();
      lastEditGroupSize = 0;
      if (undone) {
        appendMessage(messages, "system", "Undid last edit.");
        showToast("↩ Undid last edit");
      } else {
        showToast("No edits to undo", 1800);
      }
    }
  });

  providerButton.addEventListener("click", () => {
    provider = provider === "gemini" ? "openai" : "gemini";
    setProviderPreference(provider);
    providerButton.textContent = provider === "gemini" ? "Gemini" : "OpenAI";
    showToast(`Provider: ${providerButton.textContent}`, 1400);
    appendMessage(messages, "system", `LLM provider set to ${providerButton.textContent}.`);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedAssetId) {
      selectedAssetId = null;
      setLibraryStatus(libraryStatus, "No asset selected");
      renderLibrary();
      showToast("Placement canceled", 1500);
      return;
    }

    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
      return;
    }
    console.log("[ui] Undo shortcut triggered");
    event.preventDefault();
    dismissCorrectionButtons();
    if (lastEditGroupSize > 1) {
      const count = deps.undoN(lastEditGroupSize);
      lastEditGroupSize = 0;
      if (count > 0) {
        appendMessage(messages, "system", `Undid ${count} edit${count === 1 ? "" : "s"}.`);
        showToast(`↩ Undid ${count} edits`);
      } else {
        showToast("No edits to undo", 1800);
      }
    } else {
      const undone = deps.undoLastEdit();
      lastEditGroupSize = 0;
      if (undone) {
        appendMessage(messages, "system", "Undid last edit.");
        showToast("↩ Undid last edit");
      } else {
        showToast("No edits to undo", 1800);
      }
    }
  });

  input.focus();
}

export function showToast(message: string, duration: number = 3000): void {
  if (!toastContainer) {
    console.warn("[ui] showToast called before toast container exists");
    return;
  }
  console.log(`[ui] Toast: "${message}" (${duration}ms)`);

  const toast = document.createElement("div");
  toast.className = "muse-toast";
  toast.textContent = message;
  toastContainer.append(toast);

  const fadeDelay = Math.max(200, duration - 250);
  window.setTimeout(() => {
    toast.classList.add("fade-out");
  }, fadeDelay);

  window.setTimeout(() => {
    toast.remove();
  }, duration);
}

function appendMessage(
  container: HTMLDivElement,
  kind: "user" | "assistant" | "system" | "error",
  text: string
): void {
  const el = document.createElement("div");
  el.className = `muse-msg muse-msg-${kind}`;
  el.textContent = text;
  container.append(el);
  container.scrollTop = container.scrollHeight;

  const maxMessages = 14;
  while (container.children.length > maxMessages) {
    container.firstElementChild?.remove();
  }
}

function setStatus(statusEl: HTMLDivElement, text: string): void {
  statusEl.textContent = text;
}

function setLibraryStatus(statusEl: HTMLDivElement, text: string): void {
  statusEl.textContent = text;
}

function buildVoxelContext(
  grid: SpatialGrid | null,
  clickPoint: THREE.Vector3 | null,
  preciseHint: string | null = null
): string | null {
  if (!grid || !clickPoint) {
    console.log(
      `[ui] buildVoxelContext skipped: grid=${Boolean(grid)} clickPoint=${Boolean(clickPoint)}`
    );
    return null;
  }

  const cell = getCellAtWorldPos(grid, clickPoint);
  const neighbors = cell ? getNeighborCells(grid, cell, 1) : [];
  console.log(
    `[ui] buildVoxelContext: cell=${cell ? cell.gridPos.join(",") : "none"} neighbors=${neighbors.length}`
  );
  const baseContext = buildClickContext(clickPoint, cell, neighbors);

  // A precise splat-level selection supersedes the legacy coarse-cell hint.
  if (preciseHint) {
    console.log("[ui] Using precise object selection hint in context");
    return `${baseContext}\n\n${preciseHint}`;
  }

  if (!ENABLE_CLICK_SELECTION_HINTS) {
    console.log("[ui] Deterministic selection hints disabled via feature flag");
    return baseContext;
  }

  const selection = buildLocalSelection(grid, clickPoint);
  if (!selection) {
    console.log("[ui] Deterministic selection unavailable; using base context");
    return baseContext;
  }
  if (selection.confidence < MIN_SELECTION_CONFIDENCE) {
    console.log(
      `[ui] Deterministic selection confidence too low (${selection.confidence.toFixed(3)}); fallback to base context`
    );
    return baseContext;
  }

  const hint = formatSelectionHint(selection);
  console.log(
    `[ui] Deterministic selection included confidence=${selection.confidence.toFixed(3)} cells=${selection.clusterCellKeys.length}`
  );

  let context = `${baseContext}\n\n${hint}`;

  // Build high-resolution local grid around the selection cluster
  const clusterSize = new THREE.Vector3();
  selection.clusterBounds.getSize(clusterSize);
  const localExtent = clusterSize.clone().multiplyScalar(1.0); // 2x cluster bounds
  const localGrid = buildLocalGrid(grid, selection.clusterCenter, localExtent);
  if (localGrid && localGrid.cells.size > 0) {
    const localGridJSON = serializeLocalGridForLLM(localGrid);
    context += `\n\nLocal high-resolution grid (10x10x10 around selection):\n${localGridJSON}`;
    console.log(
      `[ui] Local grid appended: cells=${localGrid.cells.size} chars=${localGridJSON.length}`
    );
  }

  return context;
}

function normalizeScreenshotDataUrl(dataUrl: string): string {
  const trimmed = dataUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  const match = trimmed.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/i);
  return match ? match[1] : trimmed;
}

function readGeminiApiKey(): string {
  const googleKey = String(import.meta.env.VITE_GOOGLE_API_KEY ?? "").trim();
  if (googleKey) {
    return googleKey;
  }

  return String(import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();
}

function formatVec3OrNull(vec: THREE.Vector3 | null): string {
  if (!vec) {
    return "null";
  }
  return `[${vec.x.toFixed(3)}, ${vec.y.toFixed(3)}, ${vec.z.toFixed(3)}]`;
}

function summarizeOperations(
  operations: Array<{ action: string; shapes: Array<{ type: string }> }>
): string {
  if (operations.length === 0) {
    return "none";
  }
  return operations
    .map((op, index) => `${index + 1}:${op.action}[${op.shapes.map((s) => s.type).join(",")}]`)
    .join(" | ");
}
