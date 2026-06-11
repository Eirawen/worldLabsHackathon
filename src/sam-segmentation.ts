import type * as THREE from "three";
import type { CachedSplatData } from "./spatial-index";
import {
  buildSelectionFromIndices,
  filterToConnectedComponent,
} from "./object-selection";
import { liftMaskToSplats, projectToNormalizedPixel } from "./mask-lift";
import type {
  ObjectSelection,
  ScreenshotWithCamera,
  SegmentationMask,
} from "./types";

// Click-to-segment via SlimSAM (Segment Anything, distilled) running fully
// in-browser through transformers.js. The library is dynamically imported so
// it lands in its own chunk and only downloads model weights when enabled.
// Weights are fetched from the Hugging Face hub and cached by the browser.

export type SamStatus = "disabled" | "idle" | "loading" | "ready" | "error";
export type SamStatusListener = (status: SamStatus, detail?: string) => void;

const SAM_ENABLED =
  String(import.meta.env.VITE_ENABLE_SAM ?? "true").toLowerCase() !== "false";
const SAM_MODEL_ID = String(
  import.meta.env.VITE_SAM_MODEL ?? "Xenova/slimsam-77-uniform"
);
const MIN_MASK_SCORE = 0.5;
const MIN_LIFTED_SPLATS = 30;

interface SamBundle {
  model: any;
  processor: any;
  RawImage: any;
  Tensor: any;
}

let status: SamStatus = SAM_ENABLED ? "idle" : "disabled";
let loadPromise: Promise<SamBundle | null> | null = null;
const listeners: SamStatusListener[] = [];

export function getSamStatus(): SamStatus {
  return status;
}

export function onSamStatus(listener: SamStatusListener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

function setStatus(next: SamStatus, detail?: string): void {
  status = next;
  console.log(`[sam] Status: ${next}${detail ? ` (${detail})` : ""}`);
  for (const listener of listeners) {
    try {
      listener(next, detail);
    } catch (error) {
      console.error("[sam] Status listener failed", error);
    }
  }
}

export function preloadSam(): Promise<boolean> {
  if (!SAM_ENABLED) {
    return Promise.resolve(false);
  }
  return ensureLoaded().then((bundle) => bundle !== null);
}

function ensureLoaded(): Promise<SamBundle | null> {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    setStatus("loading", SAM_MODEL_ID);
    const start = nowMs();
    try {
      const tf: any = await import("@huggingface/transformers");
      const { SamModel, AutoProcessor, RawImage, Tensor } = tf;

      let model: any;
      try {
        model = await SamModel.from_pretrained(SAM_MODEL_ID, {
          device: "webgpu",
          dtype: "fp16",
        });
        console.log("[sam] Using WebGPU backend");
      } catch (gpuError) {
        console.log(
          `[sam] WebGPU unavailable (${gpuError instanceof Error ? gpuError.message : gpuError}); falling back to WASM`
        );
        model = await SamModel.from_pretrained(SAM_MODEL_ID, { dtype: "q8" });
      }
      const processor = await AutoProcessor.from_pretrained(SAM_MODEL_ID);

      setStatus("ready", `loaded in ${((nowMs() - start) / 1000).toFixed(1)}s`);
      return { model, processor, RawImage, Tensor };
    } catch (error) {
      console.error("[sam] Failed to load model", error);
      setStatus("error", error instanceof Error ? error.message : String(error));
      return null;
    }
  })();

  return loadPromise;
}

// Runs SAM on the image with a single positive point prompt (normalized 0..1
// coordinates) and returns the best-scoring mask at original image resolution.
export async function segmentAtPoint(
  imageDataUrl: string,
  point: { x: number; y: number }
): Promise<SegmentationMask | null> {
  const bundle = await ensureLoaded();
  if (!bundle) {
    return null;
  }

  const start = nowMs();
  const { model, processor, RawImage, Tensor } = bundle;

  const image = await RawImage.read(imageDataUrl);
  const inputs = await processor(image);
  const embeddings = await model.get_image_embeddings(inputs);

  // Point prompts are expressed in the processor's reshaped input pixel space.
  const reshaped = inputs.reshaped_input_sizes[0]; // [height, width]
  const inputPoints = new Tensor(
    "float32",
    [point.x * reshaped[1], point.y * reshaped[0]],
    [1, 1, 1, 2]
  );
  const inputLabels = new Tensor("int64", [1n], [1, 1, 1]);

  const outputs = await model({
    ...embeddings,
    input_points: inputPoints,
    input_labels: inputLabels,
  });

  const masks = await processor.post_process_masks(
    outputs.pred_masks,
    inputs.original_sizes,
    inputs.reshaped_input_sizes
  );

  const scores: ArrayLike<number> = outputs.iou_scores.data;
  let bestIndex = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[bestIndex]) {
      bestIndex = i;
    }
  }
  const bestScore = Number(scores[bestIndex]);

  // masks[0] dims are [..., numMasks, height, width]; slice out the best mask.
  const maskTensor = masks[0];
  const dims: number[] = maskTensor.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  const planeSize = height * width;
  const raw = maskTensor.data as ArrayLike<number>;
  const offset = bestIndex * planeSize;
  const data = new Uint8Array(planeSize);
  let onPixels = 0;
  for (let i = 0; i < planeSize; i++) {
    if (Number(raw[offset + i]) !== 0) {
      data[i] = 1;
      onPixels += 1;
    }
  }

  console.log(
    `[sam] Segmented ${width}x${height}: bestMask=${bestIndex} score=${bestScore.toFixed(3)} maskPixels=${onPixels} elapsed=${((nowMs() - start) / 1000).toFixed(2)}s`
  );

  if (onPixels === 0) {
    return null;
  }
  return { data, width, height, score: bestScore };
}

// Full pipeline: screenshot + click -> SAM mask -> 3D lift -> connected
// component. Returns null when SAM is unavailable or produced a weak result,
// so callers can fall back to region growing.
export async function segmentSelectionWithSam(params: {
  click: THREE.Vector3;
  data: CachedSplatData;
  screenshot: ScreenshotWithCamera;
}): Promise<ObjectSelection | null> {
  const { click, data, screenshot } = params;
  if (!SAM_ENABLED || status === "error") {
    return null;
  }

  const pixel = projectToNormalizedPixel(click, screenshot);
  if (!pixel) {
    console.log("[sam] Click point does not project into the screenshot");
    return null;
  }

  const mask = await segmentAtPoint(screenshot.dataUrl, pixel);
  if (!mask || mask.score < MIN_MASK_SCORE) {
    console.log(
      `[sam] Mask rejected (score=${mask ? mask.score.toFixed(3) : "none"})`
    );
    return null;
  }

  const lifted = liftMaskToSplats(mask, screenshot, data, click);
  if (lifted.length < MIN_LIFTED_SPLATS) {
    console.log(`[sam] Lifted too few splats (${lifted.length}); rejecting`);
    return null;
  }

  const connected = filterToConnectedComponent(lifted, data, click);
  if (connected.length < MIN_LIFTED_SPLATS) {
    console.log(
      `[sam] Connected component too small (${connected.length}); rejecting`
    );
    return null;
  }

  return buildSelectionFromIndices(connected, data, "sam", mask.score);
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
