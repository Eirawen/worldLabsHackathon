import * as THREE from "three";
import type { CachedSplatData } from "./spatial-index";
import type { EditOperation, ObjectSelection, SDFShapeConfig } from "./types";

// Splat-level object selection. Unlike click-selection.ts (which clusters the
// coarse 20x20x20 scene voxels), this module bins individual splats into a fine
// sparse grid (~scene/192 cells) and grows a selection splat-by-splat with
// color gating. The result is precise enough to fit tight SDF shapes that the
// executor, asset extraction, and infill can consume directly.

export interface FineGrid {
  cellSize: number;
  origin: THREE.Vector3;
  dims: [number, number, number];
  cells: Map<number, number[]>;
  sceneDiag: number;
}

export interface RegionGrowOptions {
  colorThreshold?: number;
  globalColorFactor?: number;
  minOpacity?: number;
  maxSplats?: number;
  maxRadius?: number;
  minPropagateFraction?: number;
}

const FINE_GRID_TARGET_CELLS = 192;
const MIN_CELL_SIZE = 0.015;
const MAX_CELL_SIZE = 0.25;
const MIN_SELECTION_SPLATS = 4;

const DEFAULT_GROW: Required<Omit<RegionGrowOptions, "maxRadius">> = {
  colorThreshold: 0.3,
  globalColorFactor: 1.5,
  minOpacity: 0.08,
  maxSplats: 80000,
  minPropagateFraction: 0.25,
};

const fineGridCache = new WeakMap<Float32Array, FineGrid>();

export function getFineGrid(data: CachedSplatData): FineGrid {
  const cached = fineGridCache.get(data.positions);
  if (cached) {
    return cached;
  }

  const pos = data.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < data.count; i++) {
    const i3 = i * 3;
    const x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const ex = Math.max(maxX - minX, 1e-6);
  const ey = Math.max(maxY - minY, 1e-6);
  const ez = Math.max(maxZ - minZ, 1e-6);
  const maxExtent = Math.max(ex, ey, ez);
  const sceneDiag = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const origin = new THREE.Vector3(minX, minY, minZ);

  const binAt = (cellSize: number) => {
    const dims: [number, number, number] = [
      Math.max(1, Math.ceil(ex / cellSize) + 1),
      Math.max(1, Math.ceil(ey / cellSize) + 1),
      Math.max(1, Math.ceil(ez / cellSize) + 1),
    ];
    const cells = new Map<number, number[]>();
    const [dx, dy] = dims;
    for (let i = 0; i < data.count; i++) {
      const i3 = i * 3;
      const cx = Math.floor((pos[i3] - minX) / cellSize);
      const cy = Math.floor((pos[i3 + 1] - minY) / cellSize);
      const cz = Math.floor((pos[i3 + 2] - minZ) / cellSize);
      const key = cx + dx * (cy + dy * cz);
      let bucket = cells.get(key);
      if (!bucket) {
        bucket = [];
        cells.set(key, bucket);
      }
      bucket.push(i);
    }
    return { dims, cells };
  };

  // Start near the target resolution, then coarsen while occupied cells are
  // nearly empty: a BFS over cells can only bridge gaps if neighbors are
  // occupied, which sparse scenes (or sparse regions) break at fine sizes.
  let cellSize = THREE.MathUtils.clamp(
    maxExtent / FINE_GRID_TARGET_CELLS,
    MIN_CELL_SIZE,
    MAX_CELL_SIZE
  );
  let { dims, cells } = binAt(cellSize);
  for (let attempt = 0; attempt < 3; attempt++) {
    const avgOccupancy = data.count / Math.max(cells.size, 1);
    if (avgOccupancy >= 3 || cellSize >= MAX_CELL_SIZE) break;
    cellSize = Math.min(cellSize * 2, MAX_CELL_SIZE);
    ({ dims, cells } = binAt(cellSize));
  }

  const grid: FineGrid = { cellSize, origin, dims, cells, sceneDiag };
  fineGridCache.set(data.positions, grid);
  console.log(
    `[object-selection] Fine grid built: cellSize=${cellSize.toFixed(3)} dims=[${dims.join(",")}] occupied=${cells.size}`
  );
  return grid;
}

function cellKeyAt(grid: FineGrid, x: number, y: number, z: number): number | null {
  const cx = Math.floor((x - grid.origin.x) / grid.cellSize);
  const cy = Math.floor((y - grid.origin.y) / grid.cellSize);
  const cz = Math.floor((z - grid.origin.z) / grid.cellSize);
  const [dx, dy, dz] = grid.dims;
  if (cx < 0 || cy < 0 || cz < 0 || cx >= dx || cy >= dy || cz >= dz) {
    return null;
  }
  return cx + dx * (cy + dy * cz);
}

function keyToCoord(grid: FineGrid, key: number): [number, number, number] {
  const [dx, dy] = grid.dims;
  const cx = key % dx;
  const cy = Math.floor(key / dx) % dy;
  const cz = Math.floor(key / (dx * dy));
  return [cx, cy, cz];
}

export function growSelection(
  click: THREE.Vector3,
  data: CachedSplatData,
  options: RegionGrowOptions = {}
): ObjectSelection | null {
  const start = nowMs();
  const grid = getFineGrid(data);
  const cfg = { ...DEFAULT_GROW, ...options };
  const maxRadius =
    options.maxRadius ?? THREE.MathUtils.clamp(grid.sceneDiag * 0.18, 0.4, 4.0);
  const maxRadiusSq = maxRadius * maxRadius;
  const pos = data.positions;
  const col = data.colors;
  const opa = data.opacities;

  const seed = findSeedSplats(grid, data, click, cfg.minOpacity);
  if (!seed) {
    console.log("[object-selection] growSelection: no splats near click");
    return null;
  }
  const { seedKey, seedColor } = seed;

  const localGate = cfg.colorThreshold;
  const globalGate = cfg.colorThreshold * cfg.globalColorFactor;

  const selected: number[] = [];
  const visited = new Set<number>();
  // Queue entries carry the avg accepted color of the cell we arrived from,
  // blended with the seed color so the reference adapts to gradients without
  // drifting onto a different surface.
  const queue: Array<{ key: number; refR: number; refG: number; refB: number }> = [
    { key: seedKey, refR: seedColor.r, refG: seedColor.g, refB: seedColor.b },
  ];
  let hitSplatCap = false;
  let sumSeedDist = 0;

  while (queue.length > 0) {
    const { key, refR, refG, refB } = queue.shift()!;
    if (visited.has(key)) continue;
    visited.add(key);

    const bucket = grid.cells.get(key);
    if (!bucket || bucket.length === 0) continue;

    let acceptedCount = 0;
    let candidateCount = 0;
    let sumR = 0, sumG = 0, sumB = 0;

    for (const idx of bucket) {
      if (opa[idx] < cfg.minOpacity) continue;
      const i3 = idx * 3;
      const ddx = pos[i3] - click.x;
      const ddy = pos[i3 + 1] - click.y;
      const ddz = pos[i3 + 2] - click.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz > maxRadiusSq) continue;
      candidateCount += 1;

      const r = col[i3], g = col[i3 + 1], b = col[i3 + 2];
      const localDist = colorDist(r, g, b, refR, refG, refB);
      const seedDist = colorDist(r, g, b, seedColor.r, seedColor.g, seedColor.b);
      if (localDist > localGate || seedDist > globalGate) continue;

      selected.push(idx);
      sumSeedDist += seedDist;
      acceptedCount += 1;
      sumR += r;
      sumG += g;
      sumB += b;
    }

    if (selected.length >= cfg.maxSplats) {
      hitSplatCap = true;
      break;
    }
    if (acceptedCount === 0) continue;
    if (candidateCount > 0 && acceptedCount / candidateCount < cfg.minPropagateFraction) {
      continue; // boundary cell: keep its matches but stop expanding through it
    }

    const inv = 1 / acceptedCount;
    const nextR = (sumR * inv + seedColor.r) * 0.5;
    const nextG = (sumG * inv + seedColor.g) * 0.5;
    const nextB = (sumB * inv + seedColor.b) * 0.5;

    const [cx, cy, cz] = keyToCoord(grid, key);
    const [dx, dy, dz] = grid.dims;
    for (let nx = cx - 1; nx <= cx + 1; nx++) {
      if (nx < 0 || nx >= dx) continue;
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        if (ny < 0 || ny >= dy) continue;
        for (let nz = cz - 1; nz <= cz + 1; nz++) {
          if (nz < 0 || nz >= dz) continue;
          const nKey = nx + dx * (ny + dy * nz);
          if (nKey !== key && !visited.has(nKey) && grid.cells.has(nKey)) {
            queue.push({ key: nKey, refR: nextR, refG: nextG, refB: nextB });
          }
        }
      }
    }
  }

  if (selected.length < MIN_SELECTION_SPLATS) {
    console.log(
      `[object-selection] growSelection: cluster too small (${selected.length})`
    );
    return null;
  }

  const avgSeedDist = sumSeedDist / selected.length;
  let confidence = THREE.MathUtils.clamp(1 - avgSeedDist / globalGate, 0, 1);
  if (hitSplatCap) confidence *= 0.5;

  const selection = buildSelectionFromIndices(selected, data, "region-grow", confidence);
  if (!selection) return null;

  const boundsDiag = selection.bounds.min.distanceTo(selection.bounds.max);
  if (boundsDiag >= 1.9 * maxRadius) {
    selection.confidence *= 0.7;
  }

  console.log(
    `[object-selection] growSelection: splats=${selection.splatCount} visitedCells=${visited.size} confidence=${selection.confidence.toFixed(3)} elapsed=${(nowMs() - start).toFixed(1)}ms${hitSplatCap ? " (hit splat cap)" : ""}`
  );
  return selection;
}

function findSeedSplats(
  grid: FineGrid,
  data: CachedSplatData,
  click: THREE.Vector3,
  minOpacity: number
): { seedKey: number; seedColor: THREE.Color } | null {
  const pos = data.positions;
  const col = data.colors;
  const opa = data.opacities;

  // Search expanding cube neighborhoods for the occupied cell nearest the click.
  let seedKey: number | null = null;
  let bestDistSq = Infinity;
  const baseKey = cellKeyAt(grid, click.x, click.y, click.z);
  const baseCoord = baseKey !== null
    ? keyToCoord(grid, baseKey)
    : clampedCoord(grid, click);
  const [dx, dy, dz] = grid.dims;

  for (let r = 0; r <= 3 && seedKey === null; r++) {
    for (let nx = baseCoord[0] - r; nx <= baseCoord[0] + r; nx++) {
      if (nx < 0 || nx >= dx) continue;
      for (let ny = baseCoord[1] - r; ny <= baseCoord[1] + r; ny++) {
        if (ny < 0 || ny >= dy) continue;
        for (let nz = baseCoord[2] - r; nz <= baseCoord[2] + r; nz++) {
          if (nz < 0 || nz >= dz) continue;
          const key = nx + dx * (ny + dy * nz);
          const bucket = grid.cells.get(key);
          if (!bucket) continue;
          for (const idx of bucket) {
            if (opa[idx] < minOpacity) continue;
            const i3 = idx * 3;
            const ddx = pos[i3] - click.x;
            const ddy = pos[i3 + 1] - click.y;
            const ddz = pos[i3 + 2] - click.z;
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              seedKey = key;
            }
          }
        }
      }
    }
  }

  if (seedKey === null) {
    return null;
  }

  // Seed color: average of the nearest splats (up to 32) in the seed cell.
  const bucket = grid.cells.get(seedKey)!;
  const byDist = bucket
    .filter((idx) => opa[idx] >= minOpacity)
    .map((idx) => {
      const i3 = idx * 3;
      const ddx = pos[i3] - click.x;
      const ddy = pos[i3 + 1] - click.y;
      const ddz = pos[i3 + 2] - click.z;
      return { idx, distSq: ddx * ddx + ddy * ddy + ddz * ddz };
    })
    .sort((a, b) => a.distSq - b.distSq)
    .slice(0, 32);

  if (byDist.length === 0) {
    return null;
  }

  let r = 0, g = 0, b = 0;
  for (const { idx } of byDist) {
    const i3 = idx * 3;
    r += col[i3];
    g += col[i3 + 1];
    b += col[i3 + 2];
  }
  const inv = 1 / byDist.length;
  return { seedKey, seedColor: new THREE.Color(r * inv, g * inv, b * inv) };
}

function clampedCoord(grid: FineGrid, p: THREE.Vector3): [number, number, number] {
  const [dx, dy, dz] = grid.dims;
  return [
    THREE.MathUtils.clamp(Math.floor((p.x - grid.origin.x) / grid.cellSize), 0, dx - 1),
    THREE.MathUtils.clamp(Math.floor((p.y - grid.origin.y) / grid.cellSize), 0, dy - 1),
    THREE.MathUtils.clamp(Math.floor((p.z - grid.origin.z) / grid.cellSize), 0, dz - 1),
  ];
}

export function buildSelectionFromIndices(
  indices: number[],
  data: CachedSplatData,
  source: ObjectSelection["source"],
  confidence: number
): ObjectSelection | null {
  if (indices.length === 0) {
    return null;
  }

  const pos = data.positions;
  const col = data.colors;
  const centroid = new THREE.Vector3();
  const bounds = new THREE.Box3();
  let r = 0, g = 0, b = 0;

  for (const idx of indices) {
    const i3 = idx * 3;
    const x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];
    centroid.x += x;
    centroid.y += y;
    centroid.z += z;
    bounds.expandByPoint(_tmpVec.set(x, y, z));
    r += col[i3];
    g += col[i3 + 1];
    b += col[i3 + 2];
  }

  const inv = 1 / indices.length;
  centroid.multiplyScalar(inv);

  return {
    indices,
    centroid,
    bounds,
    avgColor: new THREE.Color(r * inv, g * inv, b * inv),
    splatCount: indices.length,
    confidence: THREE.MathUtils.clamp(confidence, 0, 1),
    source,
  };
}

// Keep only candidates that are spatially connected (through the fine grid)
// to the cell nearest the seed point. Used after SAM mask lifting to drop
// background patches that fall inside the 2D mask but aren't part of the object.
export function filterToConnectedComponent(
  indices: number[],
  data: CachedSplatData,
  seedPoint: THREE.Vector3
): number[] {
  if (indices.length === 0) return indices;
  const grid = getFineGrid(data);
  const pos = data.positions;
  const [dx, dy, dz] = grid.dims;

  const candidateCells = new Map<number, number[]>();
  for (const idx of indices) {
    const i3 = idx * 3;
    const key = cellKeyAt(grid, pos[i3], pos[i3 + 1], pos[i3 + 2]);
    if (key === null) continue;
    let bucket = candidateCells.get(key);
    if (!bucket) {
      bucket = [];
      candidateCells.set(key, bucket);
    }
    bucket.push(idx);
  }

  // Seed cell: candidate cell nearest the seed point.
  let seedKey: number | null = null;
  let bestDistSq = Infinity;
  for (const [key, bucket] of candidateCells) {
    for (const idx of bucket) {
      const i3 = idx * 3;
      const ddx = pos[i3] - seedPoint.x;
      const ddy = pos[i3 + 1] - seedPoint.y;
      const ddz = pos[i3 + 2] - seedPoint.z;
      const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        seedKey = key;
      }
    }
  }
  if (seedKey === null) return indices;

  const reached: number[] = [];
  const visited = new Set<number>();
  const queue = [seedKey];
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const bucket = candidateCells.get(key);
    if (!bucket) continue;
    for (const idx of bucket) reached.push(idx);

    const [cx, cy, cz] = keyToCoord(grid, key);
    for (let nx = cx - 1; nx <= cx + 1; nx++) {
      if (nx < 0 || nx >= dx) continue;
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        if (ny < 0 || ny >= dy) continue;
        for (let nz = cz - 1; nz <= cz + 1; nz++) {
          if (nz < 0 || nz >= dz) continue;
          const nKey = nx + dx * (ny + dy * nz);
          if (!visited.has(nKey) && candidateCells.has(nKey)) {
            queue.push(nKey);
          }
        }
      }
    }
  }

  console.log(
    `[object-selection] Connected component: kept ${reached.length}/${indices.length} candidates`
  );
  return reached;
}

// ---------------------------------------------------------------------------
// Shape fitting: selected splats -> tight rotated ellipsoids (1..maxShapes via
// k-means along the principal axis when the selection is elongated).
// ---------------------------------------------------------------------------

const SIGMA_COVERAGE = 2.1; // half-extent = 2.1 sigma covers ~96% of a gaussian
const SHAPE_PADDING = 1.08;
const MIN_HALF_EXTENT = 0.03;
const FIT_SAMPLE_CAP = 8000;

export function fitSelectionShapes(
  selection: ObjectSelection,
  data: CachedSplatData,
  maxShapes: number = 4
): SDFShapeConfig[] {
  const points = samplePositions(selection.indices, data, FIT_SAMPLE_CAP);
  if (points.length < 3) {
    const size = new THREE.Vector3();
    selection.bounds.getSize(size);
    return [
      {
        type: "SPHERE",
        position: selection.centroid.toArray() as [number, number, number],
        radius: Math.max(MIN_HALF_EXTENT, (size.x + size.y + size.z) / 6),
      },
    ];
  }

  const full = fitEllipsoid(points);
  const elongation = full.sigmas[0] / Math.max(full.sigmas[1], 1e-6);
  let k = 1;
  if (selection.splatCount >= 800 && elongation >= 1.7) {
    k = Math.min(Math.max(1, Math.round(elongation)), Math.max(1, maxShapes));
  }

  if (k === 1) {
    return [ellipsoidToShape(full)];
  }

  const clusters = kMeansAlongAxis(points, full, k);
  const shapes: SDFShapeConfig[] = [];
  const minClusterPoints = Math.max(8, Math.floor(points.length * 0.02));
  for (const cluster of clusters) {
    if (cluster.length < minClusterPoints) continue;
    shapes.push(ellipsoidToShape(fitEllipsoid(cluster)));
  }

  return shapes.length > 0 ? shapes : [ellipsoidToShape(full)];
}

interface EllipsoidFit {
  mean: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  sigmas: [number, number, number];
}

function samplePositions(
  indices: number[],
  data: CachedSplatData,
  cap: number
): THREE.Vector3[] {
  const stride = Math.max(1, Math.floor(indices.length / cap));
  const pos = data.positions;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < indices.length; i += stride) {
    const i3 = indices[i] * 3;
    out.push(new THREE.Vector3(pos[i3], pos[i3 + 1], pos[i3 + 2]));
  }
  return out;
}

function fitEllipsoid(points: THREE.Vector3[]): EllipsoidFit {
  const mean = new THREE.Vector3();
  for (const p of points) mean.add(p);
  mean.multiplyScalar(1 / points.length);

  // Symmetric covariance matrix (xx, xy, xz, yy, yz, zz)
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const ddx = p.x - mean.x;
    const ddy = p.y - mean.y;
    const ddz = p.z - mean.z;
    xx += ddx * ddx;
    xy += ddx * ddy;
    xz += ddx * ddz;
    yy += ddy * ddy;
    yz += ddy * ddz;
    zz += ddz * ddz;
  }
  const inv = 1 / points.length;
  const { values, vectors } = jacobiEigen3(
    xx * inv, xy * inv, xz * inv, yy * inv, yz * inv, zz * inv
  );

  // Sort by eigenvalue descending
  const order = [0, 1, 2].sort((a, b) => values[b] - values[a]);
  const axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    vectors[order[0]].clone(),
    vectors[order[1]].clone(),
    vectors[order[2]].clone(),
  ];
  // Re-derive the third axis so the basis is right-handed
  axes[2].crossVectors(axes[0], axes[1]).normalize();

  const sigmas: [number, number, number] = [
    Math.sqrt(Math.max(values[order[0]], 0)),
    Math.sqrt(Math.max(values[order[1]], 0)),
    Math.sqrt(Math.max(values[order[2]], 0)),
  ];

  return { mean, axes, sigmas };
}

function ellipsoidToShape(fit: EllipsoidFit): SDFShapeConfig {
  const basis = new THREE.Matrix4().makeBasis(fit.axes[0], fit.axes[1], fit.axes[2]);
  const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
  const half = (sigma: number) =>
    Math.max(MIN_HALF_EXTENT, sigma * SIGMA_COVERAGE * SHAPE_PADDING);

  return {
    type: "ELLIPSOID",
    position: fit.mean.toArray() as [number, number, number],
    rotation: [quat.x, quat.y, quat.z, quat.w],
    scale: [half(fit.sigmas[0]), half(fit.sigmas[1]), half(fit.sigmas[2])],
  };
}

function kMeansAlongAxis(
  points: THREE.Vector3[],
  full: EllipsoidFit,
  k: number
): THREE.Vector3[][] {
  const axis = full.axes[0];
  const span = full.sigmas[0] * 2;
  const centers: THREE.Vector3[] = [];
  for (let i = 0; i < k; i++) {
    const t = k === 1 ? 0 : (i / (k - 1) - 0.5) * 2 * span;
    centers.push(full.mean.clone().addScaledVector(axis, t));
  }

  let assignment = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dist = points[i].distanceToSquared(centers[c]);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed = true;
      }
    }

    const sums = centers.map(() => new THREE.Vector3());
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < points.length; i++) {
      sums[assignment[i]].add(points[i]);
      counts[assignment[i]] += 1;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centers[c].copy(sums[c]).multiplyScalar(1 / counts[c]);
      }
    }
    if (!changed) break;
  }

  const clusters: THREE.Vector3[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < points.length; i++) {
    clusters[assignment[i]].push(points[i]);
  }
  return clusters;
}

// Jacobi eigendecomposition of a symmetric 3x3 matrix.
function jacobiEigen3(
  xx: number, xy: number, xz: number, yy: number, yz: number, zz: number
): { values: [number, number, number]; vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3] } {
  const a = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 24; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;

    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        const app = a[p][p], aqq = a[q][q], apq = a[p][q];
        a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        a[p][q] = 0;
        a[q][p] = 0;
        const r = 3 - p - q; // the remaining index
        const apr = a[p][r], aqr = a[q][r];
        a[p][r] = c * apr - s * aqr;
        a[r][p] = a[p][r];
        a[q][r] = s * apr + c * aqr;
        a[r][q] = a[q][r];

        for (let i = 0; i < 3; i++) {
          const vip = v[i][p], viq = v[i][q];
          v[i][p] = c * vip - s * viq;
          v[i][q] = s * vip + c * viq;
        }
      }
    }
  }

  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [
      new THREE.Vector3(v[0][0], v[1][0], v[2][0]).normalize(),
      new THREE.Vector3(v[0][1], v[1][1], v[2][1]).normalize(),
      new THREE.Vector3(v[0][2], v[1][2], v[2][2]).normalize(),
    ],
  };
}

// ---------------------------------------------------------------------------
// Operation snapping: replace LLM-guessed geometry with fitted shapes when the
// operation clearly targets the selected object.
// ---------------------------------------------------------------------------

const SNAPPABLE_ACTIONS = new Set<EditOperation["action"]>([
  "delete",
  "recolor",
  "tint",
]);

export function snapOperationsToSelection(
  ops: EditOperation[],
  selection: ObjectSelection,
  fittedShapes: SDFShapeConfig[]
): { ops: EditOperation[]; snappedCount: number } {
  if (fittedShapes.length === 0) {
    return { ops, snappedCount: 0 };
  }

  const size = new THREE.Vector3();
  selection.bounds.getSize(size);
  const diag = Math.max(size.length(), 0.2);
  const snapBounds = selection.bounds
    .clone()
    .expandByScalar(Math.max(diag * 0.5, 0.3));

  let snappedCount = 0;
  const result = ops.map((op) => {
    if (!SNAPPABLE_ACTIONS.has(op.action) || op.shapes.length === 0) {
      return op;
    }
    if (op.shapes.some((s) => s.type === "ALL" || s.type === "PLANE")) {
      return op; // global intent — never snap
    }
    const allInside = op.shapes.every((s) =>
      snapBounds.containsPoint(_tmpVec.set(s.position[0], s.position[1], s.position[2]))
    );
    if (!allInside) {
      return op;
    }

    const template = op.shapes.find((s) => s.color !== undefined) ?? op.shapes[0];
    if ((op.action === "recolor" || op.action === "tint") && !template.color) {
      return op; // recolor without a color can't be reconstructed from fits
    }

    const shapes: SDFShapeConfig[] = fittedShapes.map((fit) => {
      const shape: SDFShapeConfig = {
        type: fit.type,
        position: [...fit.position] as [number, number, number],
        ...(fit.rotation
          ? { rotation: [...fit.rotation] as [number, number, number, number] }
          : {}),
        ...(fit.radius !== undefined ? { radius: fit.radius } : {}),
        ...(fit.scale ? { scale: [...fit.scale] as [number, number, number] } : {}),
      };
      if (op.action === "delete") {
        shape.opacity = 0;
      } else {
        if (template.color) {
          shape.color = [...template.color] as [number, number, number];
        }
        if (template.opacity !== undefined) {
          shape.opacity = template.opacity;
        }
      }
      return shape;
    });

    snappedCount += 1;
    return { ...op, shapes };
  });

  if (snappedCount > 0) {
    console.log(
      `[object-selection] Snapped ${snappedCount} operation(s) to fitted selection shapes (${fittedShapes.length} shape(s), source=${selection.source})`
    );
  }
  return { ops: result, snappedCount };
}

export function formatObjectSelectionHint(
  selection: ObjectSelection,
  fittedShapes: SDFShapeConfig[]
): string {
  const size = new THREE.Vector3();
  selection.bounds.getSize(size);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const shapesJson = JSON.stringify(
    fittedShapes.map((s) => ({
      ...s,
      position: s.position.map(r3),
      ...(s.rotation ? { rotation: s.rotation.map(r3) } : {}),
      ...(s.scale ? { scale: s.scale.map(r3) } : {}),
      ...(s.radius !== undefined ? { radius: r3(s.radius) } : {}),
    }))
  );

  return [
    "PRECISE OBJECT SELECTION (splat-level segmentation of the clicked object):",
    `- source=${selection.source} confidence=${selection.confidence.toFixed(3)} splats=${selection.splatCount}`,
    `- centroid=[${r3(selection.centroid.x)}, ${r3(selection.centroid.y)}, ${r3(selection.centroid.z)}]`,
    `- size=[${r3(size.x)}, ${r3(size.y)}, ${r3(size.z)}] avgColor=#${selection.avgColor.getHexString()}`,
    `- fittedShapes=${shapesJson}`,
    "- If the user's command targets the clicked object (delete/recolor/tint), output shapes EXACTLY matching fittedShapes (same type, position, rotation, scale). Only deviate if the command clearly targets something else.",
  ].join("\n");
}

export function selectionHighlightPositions(
  selection: ObjectSelection,
  data: CachedSplatData,
  maxPoints: number = 20000
): Float32Array {
  const stride = Math.max(1, Math.ceil(selection.indices.length / maxPoints));
  const count = Math.ceil(selection.indices.length / stride);
  const out = new Float32Array(count * 3);
  const pos = data.positions;
  let o = 0;
  for (let i = 0; i < selection.indices.length; i += stride) {
    const i3 = selection.indices[i] * 3;
    out[o++] = pos[i3];
    out[o++] = pos[i3 + 1];
    out[o++] = pos[i3 + 2];
  }
  return out;
}

function colorDist(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

const _tmpVec = new THREE.Vector3();

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
