# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Marble Muse** is a real-time, language-driven editing layer for gaussian splat 3D worlds. Users click on regions of a `.spz` scene and issue natural language commands (e.g. "remove the tree", "make this golden hour") that are translated by Claude into Spark `SplatEdit` SDF operations executed on the GPU at 60fps with no regeneration.

Built for WL-HACK 01 (World Labs hackathon, February 2026).

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start Vite dev server (localhost)
npm run build        # Production build
npx serve dist       # Serve production build locally
```

Environment: create `.env` with `VITE_ANTHROPIC_API_KEY=<key>`. Place `.spz` scene files in `public/scenes/`.

## Architecture

```
main.ts
  ├── viewer.ts          # Three.js scene, SparkRenderer, SplatMesh loading, raycasting, selection highlight
  ├── spatial-index.ts   # 20×20×20 voxel grid built from splatMesh.forEachSplat() + cached splat data
  ├── object-selection.ts # Splat-level region growing, ellipsoid fitting, operation snapping (AD-010)
  ├── sam-segmentation.ts # In-browser SlimSAM click segmentation via transformers.js (lazy chunk)
  ├── mask-lift.ts       # 2D segmentation mask → 3D splat selection (projection + depth gating)
  ├── scene-manifest.ts  # Scene understanding; wraps voxel grid (+ optional Claude Vision)
  ├── agent.ts           # Claude API call: user command + context → EditOperation[]
  ├── executor.ts        # EditOperation[] → Spark SplatEdit/SplatEditSdf objects
  ├── infill.ts          # Hole-filling after delete: boundary detection → normal clustering → RANSAC plane fit → fill splat generation
  ├── asset-library.ts   # Extract splats on delete, store as PackedSplats, click-to-place
  ├── ui.ts              # Chat panel, asset library sidebar, selection highlight, toasts
  └── types.ts           # Shared interfaces (VoxelCell, EditOperation, AssetEntry, etc.)
```

`types.ts` has no dependencies. All other modules depend on it. `ui.ts` depends on all modules. See `AGENTS.md` for full interface definitions and detailed module specs.

## Tech Stack

| | |
|---|---|
| Renderer | `@sparkjsdev/spark ^0.1.10` — gaussian splat rendering in Three.js |
| 3D | `three ^0.178.0` + OrbitControls |
| Build | `vite ^6.x` (serves `public/` statically, no special config needed for `.spz`) |
| Language | TypeScript 5.x (strict mode) |
| AI | Claude API direct from browser with `anthropic-dangerous-direct-browser-access` header |

## Key Rules (from AGENTS.md)

1. **All visual edits go through Spark's SplatEdit SDF system** — never mutate `PackedSplats` for visual changes. GPU-side edits are non-destructive and 60fps.
2. **`forEachSplat()` is CPU-only** — use it exclusively for: building the spatial index on load, and extracting splats for the asset library. Never call per-frame.
3. **After `pushSplat()` / `setSplat()`, set `packedSplats.needsUpdate = true`** or changes won't appear on GPU.
4. **Raycasting on click only** — `splatMesh.raycast()` iterates all splats via WASM. On 500k splats there's a perceptible delay. Never call per-frame.
5. **`forEachSplat` callback objects are reused** — copy values before storing: `new THREE.Vector3().copy(center)`.
6. **SplatEdit scope** — add edit as child of `splatMesh` (scoped) or `scene` (global, affects all meshes). Use splatMesh-scoped for targeted edits, scene-level for atmosphere changes.
7. **Undo** — `parent.remove(edit); edit.dispose()` — non-destructive, splats revert.
8. **Placed assets use `maxSh = 0`** — avoids SH view-dependency artifacts when splats move between scenes.
9. **Use 500k splat `.spz` exports** for web (not 2M). SPZ is ~10x smaller than PLY with minimal visual difference.
10. **No external UI frameworks** — vanilla TS + DOM. CSS in `src/styles.css`.
11. **No classes unless necessary** — prefer modules exporting plain functions/objects.

## Spark Import Pattern

```typescript
import {
  SplatMesh, SplatEdit, SplatEditSdf,
  SplatEditSdfType, SplatEditRgbaBlendMode,
  PackedSplats, SparkRenderer, SplatLoader, utils
} from "@sparkjsdev/spark";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
```

## Claude API Integration

Direct browser calls to Claude:
```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",  // Use Sonnet for speed (2-4s target)
    max_tokens: 4096,
    // ...
  })
});
```

Claude sometimes wraps JSON in markdown fences — strip with: `/```json?\s*([\s\S]*?)```/`

Resize screenshots to ~512×512 before base64 encoding to keep prompt size manageable.

## SplatEdit Blend Modes

| `blendMode` | Effect |
|---|---|
| `MULTIPLY` + `opacity: 0` | Delete (make splats invisible) |
| `SET_RGB` | Recolor a region |
| `ADD_RGBA` | Add light/color (atmosphere, spotlights) |
| `MULTIPLY` + `color: [0.3, 0.3, 0.3]` | Darken a region |

SDF shape types: `ALL`, `PLANE`, `SPHERE`, `BOX`, `ELLIPSOID`, `CYLINDER`, `CAPSULE`, `INFINITE_CONE`. Positions are world-space.

## Voxel Grid

20×20×20 uniform grid over the Y-cropped bounding box (exclude bottom/top 10%). Produces ~100-300 occupied cells serialized as JSON for the LLM context. Each cell stores: centroid, splat count, average color, color variance, density, bounds, and splat indices (for extraction).

## Coordinate System

Marble `.spz` exports use OpenCV convention. Fix on load:
```typescript
splatMesh.quaternion.set(1, 0, 0, 0); // OpenCV → OpenGL
```

## Codex

The `codex/` directory is the agent memory repository. Keep it updated as you discover new findings:
- `codex/gotchas.md` — known issues and workarounds
- `codex/spark-api-notes.md` — Spark API reference (full class docs + examples)
- `codex/decisions.md` — architecture decisions with rationale (AD-001 through AD-007)
- `codex/worklog.md` — running log of agent work per task ID

Format worklog entries as: `[DATE] [AGENT/HUMAN] [TASK_ID] — Summary`

## Task Tracking

`TODO.md` has the full task breakdown with priority tiers (P0 MVP / P1 V2 / P2 Stretch) and task IDs (T01–T22). Tasks that can run in parallel: T01+T05, T06+T09, T12+T15. Sequential chains: T01→T02→T03→T08, T06→T07→T08→T09.
