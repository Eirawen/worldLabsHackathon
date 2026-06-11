import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  buildSelectionFromIndices,
  filterToConnectedComponent,
  fitSelectionShapes,
  formatObjectSelectionHint,
  growSelection,
  selectionHighlightPositions,
  snapOperationsToSelection,
} from "../src/object-selection";
import type { CachedSplatData } from "../src/spatial-index";
import type { EditOperation, ObjectSelection, SDFShapeConfig } from "../src/types";

type SplatSpec = {
  p: [number, number, number];
  c: [number, number, number];
  o?: number;
};

function makeData(splats: SplatSpec[]): CachedSplatData {
  const count = splats.length;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const quaternions = new Float32Array(count * 4);
  const scales = new Float32Array(count * 3);
  const opacities = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const { p, c, o } = splats[i];
    positions.set(p, i * 3);
    colors.set(c, i * 3);
    quaternions.set([0, 0, 0, 1], i * 4);
    scales.set([0.01, 0.01, 0.01], i * 3);
    opacities[i] = o ?? 1;
  }

  return { positions, colors, quaternions, scales, opacities, count };
}

// Deterministic pseudo-random generator so cluster shapes are stable.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function makeBallOnFloorScene(): {
  data: CachedSplatData;
  ballIndices: Set<number>;
  ballCenter: THREE.Vector3;
} {
  const splats: SplatSpec[] = [];
  const ballIndices = new Set<number>();

  // Gray floor: 31x31 grid over [-1.5, 1.5] at y=0
  for (let x = 0; x <= 30; x++) {
    for (let z = 0; z <= 30; z++) {
      splats.push({
        p: [-1.5 + x * 0.1, 0, -1.5 + z * 0.1],
        c: [0.5, 0.5, 0.5],
      });
    }
  }

  // Red ball at (0, 0.35, 0), radius 0.15
  const rand = lcg(42);
  const ballCenter = new THREE.Vector3(0, 0.35, 0);
  for (let i = 0; i < 400; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const r = 0.15 * Math.cbrt(rand());
    ballIndices.add(splats.length);
    splats.push({
      p: [
        ballCenter.x + r * Math.sin(phi) * Math.cos(theta),
        ballCenter.y + r * Math.cos(phi),
        ballCenter.z + r * Math.sin(phi) * Math.sin(theta),
      ],
      c: [0.85 + rand() * 0.05, 0.1 + rand() * 0.05, 0.1 + rand() * 0.05],
    });
  }

  return { data: makeData(splats), ballIndices, ballCenter };
}

describe("growSelection", () => {
  it("selects the clicked object's splats without leaking onto the floor", () => {
    const { data, ballIndices, ballCenter } = makeBallOnFloorScene();
    const selection = growSelection(ballCenter, data);

    expect(selection).not.toBeNull();
    const sel = selection!;
    const ballHits = sel.indices.filter((i) => ballIndices.has(i)).length;
    const floorHits = sel.indices.length - ballHits;

    expect(ballHits).toBeGreaterThan(ballIndices.size * 0.8);
    expect(floorHits).toBeLessThan(sel.indices.length * 0.05);
    expect(sel.centroid.distanceTo(ballCenter)).toBeLessThan(0.08);
    expect(sel.source).toBe("region-grow");
    expect(sel.confidence).toBeGreaterThan(0.3);
  });

  it("returns null when there are no splats near the click", () => {
    const data = makeData([
      { p: [0, 0, 0], c: [1, 0, 0] },
      { p: [0.01, 0, 0], c: [1, 0, 0] },
    ]);
    const selection = growSelection(new THREE.Vector3(50, 50, 50), data, {
      maxRadius: 0.5,
    });
    expect(selection).toBeNull();
  });

  it("ignores near-transparent splats", () => {
    const splats: SplatSpec[] = [];
    for (let i = 0; i < 50; i++) {
      splats.push({ p: [i * 0.01, 0, 0], c: [1, 0, 0], o: 0.01 });
    }
    const data = makeData(splats);
    const selection = growSelection(new THREE.Vector3(0.25, 0, 0), data);
    expect(selection).toBeNull();
  });
});

describe("fitSelectionShapes", () => {
  it("fits a single ellipsoid that covers a compact cluster", () => {
    const { data, ballIndices, ballCenter } = makeBallOnFloorScene();
    const indices = Array.from(ballIndices);
    const selection = buildSelectionFromIndices(indices, data, "region-grow", 0.9)!;
    const shapes = fitSelectionShapes(selection, data);

    expect(shapes.length).toBe(1);
    const shape = shapes[0];
    expect(shape.type).toBe("ELLIPSOID");
    expect(
      new THREE.Vector3(...shape.position).distanceTo(ballCenter)
    ).toBeLessThan(0.05);

    const covered = countCoveredByShapes(indices, data, shapes);
    expect(covered / indices.length).toBeGreaterThan(0.85);
  });

  it("covers an elongated object (possibly with multiple shapes)", () => {
    const rand = lcg(7);
    const splats: SplatSpec[] = [];
    for (let i = 0; i < 2000; i++) {
      // Rod along the x axis: 2.0 long, 0.08 thick
      splats.push({
        p: [
          (rand() - 0.5) * 2.0,
          0.5 + (rand() - 0.5) * 0.08,
          (rand() - 0.5) * 0.08,
        ],
        c: [0.2, 0.6, 0.3],
      });
    }
    const data = makeData(splats);
    const indices = splats.map((_, i) => i);
    const selection = buildSelectionFromIndices(indices, data, "region-grow", 0.9)!;
    const shapes = fitSelectionShapes(selection, data);

    expect(shapes.length).toBeGreaterThanOrEqual(1);
    const covered = countCoveredByShapes(indices, data, shapes);
    expect(covered / indices.length).toBeGreaterThan(0.8);

    // The fitted shapes should stay tight: total ellipsoid volume should be
    // far smaller than the selection's bounding box volume.
    const boxSize = new THREE.Vector3();
    selection.bounds.getSize(boxSize);
    const boxVolume = boxSize.x * boxSize.y * boxSize.z;
    let shapeVolume = 0;
    for (const s of shapes) {
      const [a, b, c] = s.scale!;
      shapeVolume += (4 / 3) * Math.PI * a * b * c;
    }
    expect(shapeVolume).toBeLessThan(boxVolume * 2.5);
  });
});

describe("filterToConnectedComponent", () => {
  it("keeps only the component containing the seed", () => {
    const splats: SplatSpec[] = [];
    // Cluster A near origin
    for (let i = 0; i < 60; i++) {
      splats.push({ p: [i * 0.005, 0, 0], c: [1, 0, 0] });
    }
    const clusterBStart = splats.length;
    // Cluster B far away
    for (let i = 0; i < 60; i++) {
      splats.push({ p: [5 + i * 0.005, 0, 0], c: [1, 0, 0] });
    }
    const data = makeData(splats);
    const all = splats.map((_, i) => i);

    const kept = filterToConnectedComponent(all, data, new THREE.Vector3(0, 0, 0));
    expect(kept.length).toBe(clusterBStart);
    expect(kept.every((i) => i < clusterBStart)).toBe(true);
  });
});

describe("snapOperationsToSelection", () => {
  const fitted: SDFShapeConfig[] = [
    {
      type: "ELLIPSOID",
      position: [0, 0.35, 0],
      rotation: [0, 0, 0, 1],
      scale: [0.2, 0.2, 0.2],
    },
  ];

  function makeSelection(): ObjectSelection {
    return {
      indices: [0, 1, 2, 3],
      centroid: new THREE.Vector3(0, 0.35, 0),
      bounds: new THREE.Box3(
        new THREE.Vector3(-0.15, 0.2, -0.15),
        new THREE.Vector3(0.15, 0.5, 0.15)
      ),
      avgColor: new THREE.Color(0.8, 0.1, 0.1),
      splatCount: 4,
      confidence: 0.9,
      source: "sam",
    };
  }

  it("replaces shapes on a delete op targeting the selection", () => {
    const ops: EditOperation[] = [
      {
        action: "delete",
        blendMode: "MULTIPLY",
        shapes: [
          { type: "SPHERE", position: [0.05, 0.4, 0.02], radius: 0.4, opacity: 0 },
        ],
      },
    ];
    const { ops: snapped, snappedCount } = snapOperationsToSelection(
      ops,
      makeSelection(),
      fitted
    );

    expect(snappedCount).toBe(1);
    expect(snapped[0].shapes).toHaveLength(1);
    expect(snapped[0].shapes[0].type).toBe("ELLIPSOID");
    expect(snapped[0].shapes[0].opacity).toBe(0);
    expect(snapped[0].shapes[0].scale).toEqual([0.2, 0.2, 0.2]);
  });

  it("carries color over when snapping recolor ops", () => {
    const ops: EditOperation[] = [
      {
        action: "recolor",
        blendMode: "SET_RGB",
        shapes: [
          {
            type: "SPHERE",
            position: [0, 0.35, 0],
            radius: 0.3,
            color: [0.1, 0.2, 0.9],
          },
        ],
      },
    ];
    const { ops: snapped, snappedCount } = snapOperationsToSelection(
      ops,
      makeSelection(),
      fitted
    );

    expect(snappedCount).toBe(1);
    expect(snapped[0].shapes[0].color).toEqual([0.1, 0.2, 0.9]);
    expect(snapped[0].shapes[0].type).toBe("ELLIPSOID");
  });

  it("does not snap ops whose shapes are far from the selection", () => {
    const ops: EditOperation[] = [
      {
        action: "delete",
        blendMode: "MULTIPLY",
        shapes: [{ type: "SPHERE", position: [8, 0.4, 8], radius: 0.4, opacity: 0 }],
      },
    ];
    const { snappedCount } = snapOperationsToSelection(ops, makeSelection(), fitted);
    expect(snappedCount).toBe(0);
  });

  it("never snaps global (ALL/PLANE) or atmosphere operations", () => {
    const ops: EditOperation[] = [
      {
        action: "delete",
        blendMode: "MULTIPLY",
        shapes: [{ type: "ALL", position: [0, 0.35, 0], opacity: 0 }],
      },
      {
        action: "atmosphere",
        blendMode: "ADD_RGBA",
        shapes: [
          { type: "SPHERE", position: [0, 0.35, 0], radius: 10, color: [1, 0.8, 0.5] },
        ],
      },
    ];
    const { snappedCount } = snapOperationsToSelection(ops, makeSelection(), fitted);
    expect(snappedCount).toBe(0);
  });
});

describe("hint formatting and highlight extraction", () => {
  it("formats a hint including fitted shapes JSON", () => {
    const { data, ballIndices } = makeBallOnFloorScene();
    const indices = Array.from(ballIndices);
    const selection = buildSelectionFromIndices(indices, data, "sam", 0.87)!;
    const shapes = fitSelectionShapes(selection, data);
    const hint = formatObjectSelectionHint(selection, shapes);

    expect(hint).toContain("PRECISE OBJECT SELECTION");
    expect(hint).toContain("source=sam");
    expect(hint).toContain("ELLIPSOID");
    expect(hint).toContain("fittedShapes=");
  });

  it("subsamples highlight positions to the cap", () => {
    const { data, ballIndices } = makeBallOnFloorScene();
    const indices = Array.from(ballIndices);
    const selection = buildSelectionFromIndices(indices, data, "region-grow", 0.9)!;

    const positions = selectionHighlightPositions(selection, data, 100);
    expect(positions.length % 3).toBe(0);
    expect(positions.length / 3).toBeLessThanOrEqual(101);
    expect(positions.length / 3).toBeGreaterThan(50);
  });
});

function countCoveredByShapes(
  indices: number[],
  data: CachedSplatData,
  shapes: SDFShapeConfig[]
): number {
  const point = new THREE.Vector3();
  const local = new THREE.Vector3();
  let covered = 0;

  for (const idx of indices) {
    const i3 = idx * 3;
    point.set(data.positions[i3], data.positions[i3 + 1], data.positions[i3 + 2]);
    for (const shape of shapes) {
      local.copy(point).sub(new THREE.Vector3(...shape.position));
      if (shape.rotation) {
        local.applyQuaternion(
          new THREE.Quaternion(
            shape.rotation[0],
            shape.rotation[1],
            shape.rotation[2],
            shape.rotation[3]
          ).invert()
        );
      }
      if (shape.type === "SPHERE") {
        if (local.length() <= (shape.radius ?? 0)) {
          covered += 1;
          break;
        }
      } else if (shape.scale) {
        const [sx, sy, sz] = shape.scale;
        const nx = local.x / sx;
        const ny = local.y / sy;
        const nz = local.z / sz;
        if (nx * nx + ny * ny + nz * nz <= 1) {
          covered += 1;
          break;
        }
      }
    }
  }
  return covered;
}
