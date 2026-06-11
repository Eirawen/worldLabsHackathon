import type { PackedSplats } from "@sparkjsdev/spark";
import type * as THREE from "three";

export interface VoxelCell {
  gridPos: [number, number, number];
  worldCenter: THREE.Vector3;
  worldBounds: THREE.Box3;
  splatCount: number;
  avgColor: THREE.Color;
  colorVariance: number;
  density: number;
  splatIndices: number[];
}

export interface SpatialGrid {
  resolution: [number, number, number];
  worldBounds: THREE.Box3;
  cellSize: THREE.Vector3;
  cells: Map<string, VoxelCell>;
}

export interface SceneManifest {
  description: string;
  regions: SemanticRegion[];
  grid: SpatialGrid;
  screenshots: string[];
}

export interface SemanticRegion {
  label: string;
  gridCells: string[];
  estimatedBounds: THREE.Box3;
  dominantColor: THREE.Color;
  confidence: number;
}

export interface EditOperation {
  action: "delete" | "recolor" | "tint" | "light" | "darken" | "atmosphere";
  shapes: SDFShapeConfig[];
  blendMode: "MULTIPLY" | "SET_RGB" | "ADD_RGBA";
  softEdge?: number;
  sdfSmooth?: number;
  invert?: boolean;
  extractAsset?: boolean;
  assetLabel?: string;
}

export interface SDFShapeConfig {
  type:
    | "SPHERE"
    | "BOX"
    | "ELLIPSOID"
    | "CYLINDER"
    | "CAPSULE"
    | "PLANE"
    | "INFINITE_CONE"
    | "ALL";
  position: [number, number, number];
  rotation?: [number, number, number, number];
  radius?: number;
  scale?: [number, number, number];
  color?: [number, number, number];
  opacity?: number;
  displace?: [number, number, number];
}

export interface RefinementResponse {
  accept: boolean;
  confidence: number;
  reason: string;
  corrections: EditOperation[];
}

export interface InfillConfig {
  softEdge?: number;
  sdfSmooth?: number;
  boundaryWidth?: number;
  maxFillSplats?: number;
  maxClusters?: number;
}

export interface ObjectSelection {
  indices: number[];
  centroid: THREE.Vector3;
  bounds: THREE.Box3;
  avgColor: THREE.Color;
  splatCount: number;
  confidence: number;
  source: "region-grow" | "sam";
}

export interface CameraSnapshot {
  viewProjection: THREE.Matrix4;
  cameraPosition: THREE.Vector3;
  width: number;
  height: number;
}

export interface ScreenshotWithCamera extends CameraSnapshot {
  dataUrl: string;
}

export interface SegmentationMask {
  data: Uint8Array;
  width: number;
  height: number;
  score: number;
}

export interface AssetEntry {
  id: string;
  label: string;
  sourceScene: string;
  extractedAt: Date;
  splats: PackedSplats;
  thumbnailDataUrl: string;
  originalPosition: THREE.Vector3;
  bounds: THREE.Box3;
  splatCount: number;
}
