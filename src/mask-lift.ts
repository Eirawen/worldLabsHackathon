import * as THREE from "three";
import type { CachedSplatData } from "./spatial-index";
import type { CameraSnapshot, SegmentationMask } from "./types";

// Lifts a 2D segmentation mask into a 3D splat selection: every cached splat
// is projected through the capture-time view-projection matrix and tested
// against the mask, then gated by camera distance around the raycast hit so
// occluded background (which also projects inside the mask) is rejected.

export interface LiftOptions {
  minOpacity?: number;
  // Hard bounds on the adaptive depth slack, in world units.
  minDepthSlack?: number;
  maxDepthSlack?: number;
}

const DEFAULT_LIFT: Required<LiftOptions> = {
  minOpacity: 0.08,
  minDepthSlack: 0.2,
  maxDepthSlack: 2.0,
};

export function liftMaskToSplats(
  mask: SegmentationMask,
  snapshot: CameraSnapshot,
  data: CachedSplatData,
  hitPoint: THREE.Vector3,
  options: LiftOptions = {}
): number[] {
  const cfg = { ...DEFAULT_LIFT, ...options };
  const start = nowMs();
  const e = snapshot.viewProjection.elements;
  const camX = snapshot.cameraPosition.x;
  const camY = snapshot.cameraPosition.y;
  const camZ = snapshot.cameraPosition.z;
  const hitDist = hitPoint.distanceTo(snapshot.cameraPosition);
  const pos = data.positions;
  const opa = data.opacities;
  const w = mask.width;
  const h = mask.height;

  // Pass 1: all splats that project inside the mask, with their camera distance.
  const inMask: number[] = [];
  const dists: number[] = [];
  for (let i = 0; i < data.count; i++) {
    if (opa[i] < cfg.minOpacity) continue;
    const i3 = i * 3;
    const x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];

    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 1e-8) continue; // behind the camera
    const ndcX = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
    const ndcY = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;

    const px = Math.min(w - 1, Math.max(0, Math.floor((ndcX * 0.5 + 0.5) * w)));
    const py = Math.min(h - 1, Math.max(0, Math.floor((0.5 - ndcY * 0.5) * h)));
    if (mask.data[py * w + px] === 0) continue;

    const dx = x - camX;
    const dy = y - camY;
    const dz = z - camZ;
    inMask.push(i);
    dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  if (inMask.length === 0) {
    console.log("[mask-lift] No splats project inside the mask");
    return [];
  }

  // Pass 2: estimate the object's depth extent from splats very close to the
  // hit distance (surely the visible surface), then accept a slack band
  // around the hit. Background behind the object sits outside the band.
  const nearTolerance = Math.max(0.1, hitDist * 0.05);
  const nearBounds = new THREE.Box3();
  let nearCount = 0;
  for (let i = 0; i < inMask.length; i++) {
    if (Math.abs(dists[i] - hitDist) <= nearTolerance) {
      const i3 = inMask[i] * 3;
      nearBounds.expandByPoint(_tmpVec.set(pos[i3], pos[i3 + 1], pos[i3 + 2]));
      nearCount += 1;
    }
  }

  let slack: number;
  if (nearCount >= 3) {
    const diag = nearBounds.min.distanceTo(nearBounds.max);
    slack = THREE.MathUtils.clamp(
      diag * 0.75 + 0.1,
      cfg.minDepthSlack,
      cfg.maxDepthSlack
    );
  } else {
    slack = cfg.minDepthSlack * 2;
  }

  const accepted: number[] = [];
  for (let i = 0; i < inMask.length; i++) {
    if (dists[i] >= hitDist - slack && dists[i] <= hitDist + slack) {
      accepted.push(inMask[i]);
    }
  }

  console.log(
    `[mask-lift] inMask=${inMask.length} nearSurface=${nearCount} depthSlack=${slack.toFixed(3)} accepted=${accepted.length} elapsed=${(nowMs() - start).toFixed(1)}ms`
  );
  return accepted;
}

export function projectToNormalizedPixel(
  point: THREE.Vector3,
  snapshot: CameraSnapshot
): { x: number; y: number } | null {
  const clip = _tmpVec4
    .set(point.x, point.y, point.z, 1)
    .applyMatrix4(snapshot.viewProjection);
  if (clip.w <= 1e-8) {
    return null;
  }
  const ndcX = clip.x / clip.w;
  const ndcY = clip.y / clip.w;
  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
    return null;
  }
  return { x: ndcX * 0.5 + 0.5, y: 0.5 - ndcY * 0.5 };
}

const _tmpVec = new THREE.Vector3();
const _tmpVec4 = new THREE.Vector4();

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
