# Inkling, Agentic editing of Marble Worlds in real time with multimodal models.

> Generate once with Marble. Edit forever through conversation. Every world you touch makes every future world richer.

**Inkling** is a real-time, language-driven editing layer for Marble's gaussian splat worlds. You walk through a 3D world in your browser, click on things, talk to them, and they change. Remove objects, shift the atmosphere, relight the scene, extract assets into a reusable library, and composite elements across worlds — all through natural conversation with an AI that understands 3D space.

Built on **Spark** (World Labs' open-source gaussian splat renderer) and powered by **Gemini** for spatial reasoning, Marble Muse turns Marble's 6-minute generation cycle into a real-time creative loop.

```bash
First time run instructions:
Create a .env file inside of the repository
Declare - VITE_OPENAI_API_KEY=*key* and/or VITE_GEMINI_API_KEY
then pnpm dev (or npm run dev). 
Navigate the world with wasd. Move up and down with q/e. Rotate with right mouse. 
Make requests in the chat to the bottom to change colors, remove an object, modify an image. Some requests can take ~20-30 seconds.
```

---

## The Problem

Marble generates stunning 3D worlds from text and images. But iteration is slow — every change requires a full regeneration (~6 minutes). There is no way to make targeted edits, adjust lighting, remove objects, or remix worlds after generation. The creative feedback loop is broken.

## The Solution

Marble Muse adds a **real-time editing layer** that operates directly on Marble's gaussian splat output. Instead of regenerating, you **converse** with your world:

- *"Remove that tree."* → It vanishes instantly.
- *"Make this a sunset scene."* → Warm golden light floods the environment.
- *"Turn the building facade to red brick."* → Color shifts in real-time.
- *"Add a spotlight on the fountain."* → Volumetric light cone appears.
- *"Take that lamppost and save it."* → Extracted to your asset library for reuse in any scene.

No regeneration. 60fps in the browser.

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MARBLE MUSE                          │
│                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Spark    │    │  Spatial     │    │  Gemini      │  │
│  │  Viewer   │◄──►│  Index      │◄──►│  Agent       │  │
│  │          │    │  (Grid)      │    │  (Reasoning) │  │
│  └────┬─────┘    └──────────────┘    └──────┬───────┘  │
│       │                                      │          │
│       │         ┌──────────────┐             │          │
│       └────────►│  SplatEdit   │◄────────────┘          │
│                 │  Executor    │                         │
│                 └──────┬───────┘                         │
│                        │                                 │
│                 ┌──────▼───────┐                         │
│                 │  Asset       │                         │
│                 │  Library     │                         │
│                 └──────────────┘                         │
└─────────────────────────────────────────────────────────┘
```

### Core Pipeline

1. **Load** — Marble .spz file loaded via Spark's `SplatMesh({ url })` into a Three.js scene
2. **Index** — `forEachSplat()` builds a 20×20×20 spatial voxel grid over the cropped bounding box. Each occupied cell stores centroid, splat count, average color, density, and bounding extents
3. **Understand** — Multi-angle screenshots + voxel grid JSON fed to Gemini vision to generate a semantic scene manifest (one-time, cached)
4. **Interact** — User clicks (Spark's built-in `raycast()`) to select a region, then types a natural language command
5. **Reason** — Gemini receives: scene manifest + click position + voxel cell data + current camera screenshot + user command. Outputs structured JSON describing SplatEdit SDF operations
6. **Execute** — JSON parsed into Spark `SplatEdit` + `SplatEditSdf` objects (spheres, boxes, cones, planes). Applied on the GPU in real-time at 60fps
7. **Extract** — On delete operations, splats in the affected region are simultaneously extracted via `forEachSplat()`, filtered (by color coherence, density, opacity), normalized, and saved as reusable `PackedSplats` assets in the library
8. **Reuse** — Assets from the library can be placed into any scene via click-to-place + `pushSplat()`

### Edit Operations (via Spark SplatEdit SDF System)

| Operation | Blend Mode | SDF Config | Effect |
|-----------|-----------|------------|--------|
| **Delete** | `MULTIPLY` | `opacity: 0` | Splats in region become invisible |
| **Recolor** | `SET_RGB` | `color: [r, g, b]` | Splats in region change color |
| **Light (additive)** | `ADD_RGBA` | `color: [r, g, b]` | Adds light/color to region |
| **Darken** | `MULTIPLY` | `color: [0.3, 0.3, 0.3]` | Multiplies color down in region |
| **Atmosphere** | `MULTIPLY` / `ADD_RGBA` | Multiple overlapping SDFs | Global mood/tone shift |

All operations support: `softEdge` (feathered boundaries), `sdfSmooth` (blending between shapes), and compound shapes (multiple SDFs per operation for complex regions).

### SDF Shape Primitives

`SPHERE` · `BOX` · `ELLIPSOID` · `CYLINDER` · `CAPSULE` · `PLANE` · `INFINITE_CONE` · `ALL`

These map naturally to spatial editing concepts: spheres for point selections, boxes for architectural regions, cones for spotlights, planes for ground/sky splits.

---

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Renderer | **Spark** (by World Labs) | Gaussian splat rendering in Three.js |
| 3D Engine | **Three.js** | Scene graph, camera controls, raycasting |
| Build | **Vite** | Dev server, HMR, bundling |
| Language | **TypeScript** | Type safety for splat data structures |
| AI Agent | **Gemini API** (`@google/genai`) | Spatial reasoning, command → SDF translation |
| Vision | **Gemini multimodal input** | Scene understanding from screenshots |
| Input Format | **.spz** (Niantic/World Labs) | Compressed gaussian splat files from Marble |
| TTS (stretch) | **Web Speech API** | Voice input for hands-free editing |

---

## Project Structure

```
marble-muse/
├── index.html              # Entry point
├── src/
│   ├── main.ts             # App init, Spark setup, render loop
│   ├── viewer.ts           # SplatMesh loading, camera controls, raycasting
│   ├── spatial-index.ts    # Voxel grid construction and querying
│   ├── scene-manifest.ts   # Scene understanding via Gemini vision
│   ├── agent.ts            # Natural language → SplatEdit JSON pipeline
│   ├── executor.ts         # JSON → Spark SplatEdit/SplatEditSdf objects
│   ├── asset-library.ts    # Extraction, filtering, storage, placement
│   ├── ui.ts               # Chat panel, library sidebar, selection highlights
│   └── types.ts            # Shared type definitions
├── public/
│   └── scenes/             # Pre-exported .spz files from Marble
├── codex/                  # Agent memory repository
│   ├── gotchas.md          # Known issues and workarounds
│   ├── spark-api-notes.md  # Spark API reference and findings
│   ├── worklog.md          # Running log of agent work
│   └── decisions.md        # Architecture decisions and rationale
├── package.json
├── tsconfig.json
├── vite.config.ts
├── AGENTS.md               # Instructions for coding agents
└── TODO.md                 # Task breakdown with priority tiers
```

---


## Key Insight

Marble's gaussian splats are data, not pixels. Spark exposes that data through a programmable SDF editing pipeline that runs on the GPU. By placing an LLM between the user's intent and Spark's SDF system, we turn natural language into spatial operations — and we do it at 60fps with zero regeneration.


---

## Prior Art & Differentiation

| Approach | Method | Speed | Our Advantage |
|----------|--------|-------|--------------|
| **GaussianEditor** (CVPR 2024) | Diffusion + backprop optimization | ~20 min/edit on V100 | We're real-time, browser-based, no GPU training |
| **Instruct-NeRF2NeRF** | NeRF + InstructPix2Pix | 45 min–2 hrs | We operate on splats, not NeRFs. Instant. |
| **Marble (native)** | Full regeneration | ~6 min | We edit without regenerating |
| **Marble Muse (ours)** | LLM → SDF edits on GPU | **< 3 seconds** | Real-time, conversational, composable |

---

## Setup

```bash
git clone <repo>
cd marble-muse
npm install
npm run dev
```

Set `VITE_GEMINI_API_KEY` in `.env` for primary Gemini access.
Optional failover: set `VITE_OPENAI_API_KEY` (and optionally `VITE_OPENAI_MODEL`, default `gpt-5.2`) to enable automatic fallback when Gemini is temporarily unavailable (for example HTTP 503 high demand).

**Click segmentation (SAM):** clicking an object instantly selects it via splat-level region growing, then upgrades to a pixel-accurate Segment Anything (SlimSAM) selection once the in-browser model finishes loading (weights are fetched from the Hugging Face hub on first run and cached by the browser; WebGPU when available, WASM otherwise). Set `VITE_ENABLE_SAM=false` to disable, or `VITE_SAM_MODEL` to use a different SAM checkpoint. Edits that target the clicked object are snapped to tight fitted ellipsoids around the selected splats, so deletes/recolors no longer depend on the LLM guessing 3D geometry.

Place `.spz` files exported from Marble in `public/scenes/`.

---

## License

MIT

## Team

Built for [WL-HACK 01](https://worldlabs.ai) — World Labs' inaugural hackathon, San Francisco, February 2026.
