import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { processCommand, processRefinement } from "./agent";
import {
  executeOperations,
  setAssetExtractionHandler,
  undoLastEdit,
  undoN,
} from "./executor";
import {
  addAsset,
  createPlacedAssetMesh,
  ensureDefaultLibraryAsset,
  extractAssetFromDeleteOperation,
  getAssetById,
  listAssets,
} from "./asset-library";
import { generateManifest, getManifestJSON } from "./scene-manifest";
import {
  buildSpatialGrid,
  getCachedSplatData,
  getCellAtWorldPos,
  gridKey,
  serializeSpatialGridForLLM,
} from "./spatial-index";
import type { SceneManifest, SpatialGrid } from "./types";
import { initUI } from "./ui";
import {
  clearSelectionHighlight,
  getScreenshot,
  getScreenshotCropAroundPoint,
  getScreenshotWithCamera,
  initViewer,
  onSplatClick,
  showSelectionHighlight,
} from "./viewer";

const DEFAULT_SCENE_FILE = "elegant_library_with_fireplace_500k.spz";

let currentGrid: SpatialGrid | null = null;
let currentManifest: SceneManifest | null = null;
let lastClickPoint: THREE.Vector3 | null = null;

export function getGrid(): SpatialGrid | null {
  return currentGrid;
}

export function getManifest(): SceneManifest | null {
  return currentManifest;
}

export function getLastClickPoint(): THREE.Vector3 | null {
  return lastClickPoint;
}

async function bootstrap() {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
  const info = document.querySelector<HTMLDivElement>("#info");

  if (!canvas) {
    throw new Error("Missing #canvas element");
  }

  const sceneUrl = `/scenes/${DEFAULT_SCENE_FILE}`;
  info?.replaceChildren(`Loading ${DEFAULT_SCENE_FILE}...`);

  const viewer = await initViewer(canvas, sceneUrl);
  await ensureDefaultLibraryAsset();

  info?.replaceChildren(`Loaded ${DEFAULT_SCENE_FILE}`);
  console.log("[main] Viewer initialized");

  const spatialGrid = buildSpatialGrid(viewer.splatMesh);
  currentGrid = spatialGrid;
  const spatialJson = serializeSpatialGridForLLM(spatialGrid);
  console.log(
    `[spatial] Grid ready: occupied=${spatialGrid.cells.size}, serializedBytes=${spatialJson.length}`
  );

  const manifest = generateManifest(spatialGrid);
  currentManifest = manifest;
  const manifestJson = getManifestJSON(manifest);
  console.log(`[main] Manifest: ${manifest.description}`);
  console.log(
    `[main] Manifest regions=${manifest.regions.length}, serializedBytes=${manifestJson.length}`
  );

  onSplatClick((point) => {
    lastClickPoint = point.clone();
    console.log("[main] Selected point:", point.toArray());

    const hitCell = getCellAtWorldPos(spatialGrid, point);
    if (hitCell) {
      console.log(
        `[spatial] Click cell ${gridKey(...hitCell.gridPos)} splats=${hitCell.splatCount} density=${hitCell.density.toFixed(2)}`
      );
    } else {
      const gb = spatialGrid.worldBounds;
      const dy =
        point.y < gb.min.y
          ? gb.min.y - point.y
          : point.y > gb.max.y
            ? point.y - gb.max.y
            : 0;
      console.log(
        `[spatial] No occupied cell near click (y=${point.y.toFixed(3)}, grid y=[${gb.min.y.toFixed(3)}..${gb.max.y.toFixed(3)}], gap=${dy.toFixed(3)})`
      );
    }
  });

  setAssetExtractionHandler((op, parent) => {
    const extractionMesh = resolveSplatMesh(parent, viewer.splatMesh);
    const asset = extractAssetFromDeleteOperation(op, extractionMesh, DEFAULT_SCENE_FILE);
    if (!asset) {
      console.log("[main] No asset extracted for current delete operation");
      return;
    }

    addAsset(asset);
    console.log(
      `[main] Asset saved id=${asset.id} label=\"${asset.label}\" splats=${asset.splatCount}`
    );
  });

  initUI({
    processCommand,
    executeOperations,
    undoLastEdit,
    undoN,
    processRefinement,
    getSplatMesh: () => viewer.splatMesh,
    getScreenshot,
    getScreenshotCropAroundPoint,
    getGrid,
    getManifest,
    getLastClickPoint,
    getCachedSplatData,
    getScreenshotWithCamera,
    showSelectionHighlight,
    clearSelectionHighlight,
    onSplatClick,
    listAssets,
    getAssetById,
    createPlacedAssetMesh,
    getPlacementParent: () => viewer.scene,
  });

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "l" && lastClickPoint) {
      console.log("[main] Last clicked point:", lastClickPoint.toArray());
    }
  });
}

function resolveSplatMesh(parent: THREE.Object3D, fallback: SplatMesh): SplatMesh {
  if (looksLikeSplatMesh(parent)) {
    return parent;
  }

  let current: THREE.Object3D | null = parent.parent;
  while (current) {
    if (looksLikeSplatMesh(current)) {
      return current;
    }
    current = current.parent;
  }

  return fallback;
}

function looksLikeSplatMesh(obj: unknown): obj is SplatMesh {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as SplatMesh).forEachSplat === "function" &&
    typeof (obj as SplatMesh).getBoundingBox === "function"
  );
}

bootstrap().catch((error) => {
  console.error("[main] Failed to bootstrap viewer", error);
  const info = document.querySelector<HTMLDivElement>("#info");
  if (info) {
    info.textContent = "Failed to load scene. Check console.";
  }
});
