import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { liftMaskToSplats, projectToNormalizedPixel } from "../src/mask-lift";
import type { CachedSplatData } from "../src/spatial-index";
import type { CameraSnapshot, SegmentationMask } from "../src/types";

function makeData(positions: Array<[number, number, number]>): CachedSplatData {
  const count = positions.length;
  const pos = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const quaternions = new Float32Array(count * 4);
  const scales = new Float32Array(count * 3);
  const opacities = new Float32Array(count).fill(1);

  for (let i = 0; i < count; i++) {
    pos.set(positions[i], i * 3);
    colors.set([0.5, 0.5, 0.5], i * 3);
    quaternions.set([0, 0, 0, 1], i * 4);
  }
  return { positions: pos, colors, quaternions, scales, opacities, count };
}

// Camera at origin looking down -Z (three.js default orientation).
function makeSnapshot(width = 64, height = 64): CameraSnapshot {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  const viewProjection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  return {
    viewProjection,
    cameraPosition: camera.position.clone(),
    width,
    height,
  };
}

function makeCircleMask(
  snapshot: CameraSnapshot,
  worldCenter: THREE.Vector3,
  radiusPx: number
): SegmentationMask {
  const { width, height } = snapshot;
  const data = new Uint8Array(width * height);
  const center = projectToNormalizedPixel(worldCenter, snapshot)!;
  const cx = center.x * width;
  const cy = center.y * height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radiusPx * radiusPx) {
        data[y * width + x] = 1;
      }
    }
  }
  return { data, width, height, score: 0.95 };
}

describe("projectToNormalizedPixel", () => {
  it("projects a point in front of the camera to the image center", () => {
    const snapshot = makeSnapshot();
    const pixel = projectToNormalizedPixel(new THREE.Vector3(0, 0, -5), snapshot);
    expect(pixel).not.toBeNull();
    expect(pixel!.x).toBeCloseTo(0.5, 5);
    expect(pixel!.y).toBeCloseTo(0.5, 5);
  });

  it("returns null for points behind the camera", () => {
    const snapshot = makeSnapshot();
    const pixel = projectToNormalizedPixel(new THREE.Vector3(0, 0, 5), snapshot);
    expect(pixel).toBeNull();
  });
});

describe("liftMaskToSplats", () => {
  it("selects object splats inside the mask and rejects occluded background", () => {
    const objectCenter = new THREE.Vector3(0, 0, -5);
    const positions: Array<[number, number, number]> = [];

    // Object: small cluster around (0, 0, -5)
    const objectCount = 100;
    for (let i = 0; i < objectCount; i++) {
      const a = (i / objectCount) * Math.PI * 2;
      const r = 0.2 * ((i % 10) / 10);
      positions.push([Math.cos(a) * r, Math.sin(a) * r, -5 + ((i % 7) - 3) * 0.05]);
    }

    // Wall: large plane at z=-9, fully behind the object (also inside the mask)
    const wallStart = positions.length;
    for (let x = -4; x <= 4; x += 0.25) {
      for (let y = -4; y <= 4; y += 0.25) {
        positions.push([x, y, -9]);
      }
    }

    const data = makeData(positions);
    const snapshot = makeSnapshot();
    const mask = makeCircleMask(snapshot, objectCenter, 8);

    const lifted = liftMaskToSplats(mask, snapshot, data, objectCenter);

    const objectHits = lifted.filter((i) => i < wallStart).length;
    const wallHits = lifted.filter((i) => i >= wallStart).length;

    expect(objectHits).toBeGreaterThan(objectCount * 0.9);
    expect(wallHits).toBe(0);
  });

  it("rejects splats at object depth but outside the mask", () => {
    const objectCenter = new THREE.Vector3(0, 0, -5);
    const positions: Array<[number, number, number]> = [
      [0, 0, -5], // inside mask
      [2.5, 0, -5], // same depth, far outside mask
    ];
    const data = makeData(positions);
    const snapshot = makeSnapshot();
    const mask = makeCircleMask(snapshot, objectCenter, 6);

    const lifted = liftMaskToSplats(mask, snapshot, data, objectCenter);
    expect(lifted).toContain(0);
    expect(lifted).not.toContain(1);
  });

  it("ignores low-opacity splats", () => {
    const objectCenter = new THREE.Vector3(0, 0, -5);
    const data = makeData([[0, 0, -5]]);
    data.opacities[0] = 0.01;
    const snapshot = makeSnapshot();
    const mask = makeCircleMask(snapshot, objectCenter, 6);

    const lifted = liftMaskToSplats(mask, snapshot, data, objectCenter);
    expect(lifted).toHaveLength(0);
  });

  it("returns empty when nothing projects into the mask", () => {
    const data = makeData([[0, 0, 50]]); // behind the camera
    const snapshot = makeSnapshot();
    const mask: SegmentationMask = {
      data: new Uint8Array(64 * 64).fill(1),
      width: 64,
      height: 64,
      score: 0.9,
    };
    const lifted = liftMaskToSplats(mask, snapshot, data, new THREE.Vector3(0, 0, -5));
    expect(lifted).toHaveLength(0);
  });
});
