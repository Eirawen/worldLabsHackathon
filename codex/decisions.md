# Architecture Decisions — Marble Muse

## AD-001: Use Spark SplatEdit SDF system for edits, not raw buffer mutation
**Date:** 2026-02-26
**Decision:** All visual edits (delete, recolor, lighting) use Spark's GPU-side SplatEdit/SplatEditSdf system rather than CPU-side PackedSplats mutation.
**Rationale:** SplatEdits run on the GPU at 60fps with zero CPU-GPU data transfer. They support soft edges, shape blending, and multiple blend modes. They are non-destructive and reversible. CPU-side mutation via forEachSplat/setSplat is reserved only for asset extraction and cross-scene compositing.

## AD-002: 20×20×20 uniform voxel grid over cropped bounding box
**Date:** 2026-02-26
**Decision:** Spatial index uses a uniform 20×20×20 grid over the Y-cropped (10% top/bottom excluded) bounding box. Not octree, not DBSCAN.
**Rationale:** Simple to implement (<100 lines), fast to build (<500ms for 500k splats), produces ~100-300 occupied cells which fits easily in Claude's context window. Provides sufficient spatial resolution for the LLM to reason about object locations. Octree was considered but adds complexity without proportional benefit for hackathon scope.

## AD-003: Claude (Sonnet) as the spatial reasoning agent
**Date:** 2026-02-26
**Decision:** Use Claude Sonnet via direct API calls with vision for command→SDF translation.
**Rationale:** Best available vision model for spatial reasoning from screenshots + structured data. Sonnet is fast enough (2-4s) for interactive use. Direct browser API calls with `anthropic-dangerous-direct-browser-access` header — acceptable for hackathon, not production.

## AD-004: Click-to-select as primary interaction, language as secondary
**Date:** 2026-02-26
**Decision:** Users click to select a region, then type what to do with it. Pure language commands (without click) are supported but click+language is the primary flow.
**Rationale:** Click gives us an exact 3D position via Spark's raycast, which feeds the LLM precise spatial context. This sidesteps the hard problem of the LLM needing to identify 3D locations from language alone. The click point also determines which voxel cells to include in the context, keeping the prompt focused.

## AD-005: Asset extraction as byproduct of deletion
**Date:** 2026-02-26
**Decision:** Every delete operation simultaneously extracts the affected splats into a reusable asset in the library.
**Rationale:** Deletion already identifies a spatial region. The splat data exists in PackedSplats. Extracting it is minimal additional work (iterate, filter, normalize, store). This creates a flywheel: more editing = richer library = more compositing options. Product narrative: "Every world you touch makes every future world richer."

## AD-006: SH0 for extracted/placed assets
**Date:** 2026-02-26
**Decision:** Assets extracted and placed in new scenes use maxSh=0 (base color only, no view-dependent spherical harmonics).
**Rationale:** Gaussian splats encode view-dependent appearance via spherical harmonics that are optimized for the original scene's camera positions. When splats are moved to a new scene and viewed from different angles, SH can produce color artifacts. SH0 gives consistent (if slightly less realistic) appearance from all angles.

## AD-007: 500k splat exports for web
**Date:** 2026-02-26
**Decision:** Use Marble's 500k splat export option for all web demo scenes, not the 2M version.
**Rationale:** 500k splats render well on laptops, load faster, and raycast faster. The 2M version is more detailed but causes performance issues in browser. For a live demo, smooth 60fps matters more than maximum detail.

## AD-008: Composite hole-filling algorithm for deletions (infill.ts)
**Date:** 2026-03-17
**Decision:** Implement a 4-step deterministic infill pipeline triggered automatically after every delete operation: (1) identify boundary splats near the SDF surface, (2) cluster by surface normal via k-means, (3) RANSAC plane fitting per cluster, (4) sample fill positions on planes inside the deletion SDF and assign properties from outer boundary splats.
**Rationale:** Gaussian splat captures are 2.5D — behind a deleted object there is zero captured data. The hole needs synthetic fill. We evaluated 7 algorithm categories (see `codex/algorithms.md`): wavefront diffusion (too blurry), Poisson surface reconstruction (too heavy), texture synthesis (too slow), view-dependent projection (breaks on camera movement). The composite approach (algorithm 7C) combines surface segmentation (2B) + RANSAC (6C) + donor cloning (3C) for the best quality-to-complexity tradeoff. Key refinements discovered during implementation:
- Boundary width must be adaptive to shape dimensions (~20% of smallest axis), not a fixed multiplier of softEdge
- Boundary splat count must be capped (~2000) with stride subsampling to keep k-means + KNN under 500ms
- SDF distance weighting is critical for color assignment — inner boundary is contaminated by the deleted object, outer boundary represents actual background
- Visual SplatEdit deletion should oversize by ~12% to consume degraded grazing-angle splats, while infill uses original shapes for boundary detection
- Small/weak clusters (< 15% of largest, inlier ratio < 0.5) must be filtered to avoid spurious tilted fill disks
- Fill splat scale must be computed from grid spacing (1.5x for overlap), not inherited from boundary splat scale which is too small for covering flat surfaces

## AD-010: Splat-level object selection with SAM upgrade and operation snapping
**Date:** 2026-06-11
**Decision:** Object selection no longer relies on the coarse 20×20×20 voxel cells. A new pipeline selects individual splats: (1) `object-selection.ts` grows a selection splat-by-splat over a fine sparse grid (~scene/192 cells, adaptively coarsened when occupancy is low) with dual color gating (local frontier reference + global seed anchor); (2) when the in-browser SlimSAM model (`sam-segmentation.ts`, transformers.js, WebGPU→WASM fallback) is loaded, a click runs Segment Anything on the rendered frame and `mask-lift.ts` projects every cached splat through the capture-time view-projection matrix into the mask with adaptive depth gating + connected-component filtering; (3) fitted rotated ellipsoids (PCA, k-means along the principal axis for elongated objects) are produced from the selected splats; (4) `snapOperationsToSelection` replaces the LLM's guessed SDF geometry with the fitted shapes whenever the returned operation targets the clicked object.
**Rationale:** The hackathon-era selection worked at half-meter voxel granularity and asked the LLM to output metric 3D geometry — both fundamentally capped precision, which showed up as endless threshold tuning ("removing too little/too much"). Splat-level segmentation fixes the representation; snapping removes the LLM from the geometry loop entirely (it decides *what*, segmentation decides *where*). Region growing is synchronous and instant (fallback + immediate feedback); SAM upgrades the selection asynchronously when ready. Rotated ellipsoids flow through the existing executor, asset extraction, and infill unchanged because all three already honor SDF `rotation`.

## AD-009: Spatial grid canonical frame is world space
**Date:** 2026-02-28
**Decision:** `SpatialGrid.worldBounds`, `VoxelCell.worldCenter`, and `VoxelCell.worldBounds` are built in world space by transforming local splat centers/bounds with `splatMesh.matrixWorld`.
**Rationale:** Raycast clicks are world-space coordinates. Building the grid in local mesh space caused wrong-cell lookups when the mesh had non-identity transforms (notably the required `quaternion.set(1,0,0,0)` orientation fix). World-space indexing removes downstream conversion bugs across UI selection hints, voxel context, and SDF placement.
