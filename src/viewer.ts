import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ScreenshotWithCamera } from "./types";

export let scene: THREE.Scene;
export let camera: THREE.PerspectiveCamera;
export let renderer: THREE.WebGLRenderer;
export let sparkRenderer: SparkRenderer;
export let splatMesh: SplatMesh;
export let controls: OrbitControls;
export let canvas: HTMLCanvasElement;

export interface ViewerContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  sparkRenderer: SparkRenderer;
  splatMesh: SplatMesh;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  bounds: THREE.Box3;
  boundsCenter: THREE.Vector3;
  boundsSize: THREE.Vector3;
}

type ClickCallback = (point: THREE.Vector3) => void;
const clickCallbacks: ClickCallback[] = [];
let indicator: THREE.Mesh | null = null;
let resizeAttached = false;
let keyboardAttached = false;
let freeLookAttached = false;
const pressedKeys = new Set<string>();
let lastFrameTimeMs = 0;
let isFreeLooking = false;
let freeLookYaw = 0;
let freeLookPitch = 0;
let freeLookDistance = 5;
let freeLookLastX = 0;
let freeLookLastY = 0;

const MOVE_SPEED = 3.0;
const MOVE_SPEED_FAST = 8.0;
const LOOK_SENSITIVITY = 0.003;
const MAX_PITCH = Math.PI / 2 - 0.01;
const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpMove = new THREE.Vector3();
const tmpLookDir = new THREE.Vector3();

export function onSplatClick(callback: ClickCallback): () => void {
  clickCallbacks.push(callback);
  return () => {
    const index = clickCallbacks.indexOf(callback);
    if (index >= 0) {
      clickCallbacks.splice(index, 1);
    }
  };
}

export async function initViewer(
  canvasEl: HTMLCanvasElement,
  sceneUrl: string
): Promise<ViewerContext> {
  canvas = canvasEl;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    5000
  );
  camera.position.set(0, 1, 3);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  sparkRenderer = new SparkRenderer({ renderer });
  scene.add(sparkRenderer);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.target.set(0, 0, 0);
  controls.enableRotate = false; // right-drag free-look handles rotation
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  console.log("[viewer] Loading scene:", sceneUrl);
  splatMesh = new SplatMesh({ url: sceneUrl });
  splatMesh.quaternion.set(1, 0, 0, 0); // OpenCV → OpenGL coordinate fix
  scene.add(splatMesh);

  await splatMesh.initialized;
  console.log("[viewer] Scene loaded and initialized");

  const bounds = splatMesh.getBoundingBox();
  const boundsCenter = new THREE.Vector3();
  const boundsSize = new THREE.Vector3();
  bounds.getCenter(boundsCenter);
  bounds.getSize(boundsSize);
  console.log("[viewer] Bounding box min:", bounds.min.toArray());
  console.log("[viewer] Bounding box max:", bounds.max.toArray());
  console.log("[viewer] Bounding box center:", boundsCenter.toArray());
  console.log("[viewer] Bounding box size:", boundsSize.toArray());

  fitCameraToBounds(bounds, boundsCenter, boundsSize);
  setupRaycasting();
  setupKeyboardMovement();
  setupFreeLook();

  if (!resizeAttached) {
    window.addEventListener("resize", onResize);
    resizeAttached = true;
  }

  lastFrameTimeMs = nowMs();
  renderer.setAnimationLoop(() => {
    const currentTime = nowMs();
    const deltaSeconds = Math.min(Math.max((currentTime - lastFrameTimeMs) / 1000, 0), 0.05);
    lastFrameTimeMs = currentTime;

    updateKeyboardMovement(deltaSeconds);
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    scene,
    camera,
    renderer,
    sparkRenderer,
    splatMesh,
    controls,
    canvas,
    bounds,
    boundsCenter,
    boundsSize,
  };
}

function setupKeyboardMovement() {
  if (keyboardAttached) {
    return;
  }

  window.addEventListener("keydown", (event) => {
    if (isTextEntryTarget(event.target)) {
      return;
    }
    if (event.repeat) return;
    pressedKeys.add(event.key.toLowerCase());
  });

  window.addEventListener("keyup", (event) => {
    pressedKeys.delete(event.key.toLowerCase());
  });

  window.addEventListener("focusin", (event) => {
    if (isTextEntryTarget(event.target)) {
      pressedKeys.clear();
    }
  });

  window.addEventListener("blur", () => {
    pressedKeys.clear();
  });

  keyboardAttached = true;
  console.log("[viewer] Keyboard movement enabled: WASD (Q/E vertical, Shift boost)");
}

function setupFreeLook() {
  if (freeLookAttached) {
    return;
  }

  canvas.addEventListener("mousedown", (event) => {
    if (event.button !== 2) {
      return;
    }

    event.preventDefault();
    startFreeLook(event.clientX, event.clientY);
  });

  window.addEventListener("mousemove", (event) => {
    if (!isFreeLooking) {
      return;
    }

    const dx = event.clientX - freeLookLastX;
    const dy = event.clientY - freeLookLastY;
    freeLookLastX = event.clientX;
    freeLookLastY = event.clientY;

    freeLookYaw -= dx * LOOK_SENSITIVITY;
    freeLookPitch = THREE.MathUtils.clamp(
      freeLookPitch - dy * LOOK_SENSITIVITY,
      -MAX_PITCH,
      MAX_PITCH
    );

    applyFreeLookOrientation();
  });

  window.addEventListener("mouseup", (event) => {
    if (event.button === 2 && isFreeLooking) {
      endFreeLook();
    }
  });

  window.addEventListener("blur", () => {
    if (isFreeLooking) {
      endFreeLook();
    }
  });

  freeLookAttached = true;
  console.log("[viewer] Right-drag free-look enabled (FPS-style look)");
}

function setupRaycasting() {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);
    const hit = intersects.find((intersection) =>
      isObjectWithinSplatMesh(intersection.object)
    );

    if (hit) {
      const point = hit.point.clone();
      console.log(
        `[viewer] Click hit at world position: (${point.x.toFixed(3)}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)})`
      );

      showClickIndicator(point);
      for (const cb of clickCallbacks) {
        cb(point);
      }
    } else {
      console.log("[viewer] Click missed — no splat intersection");
      clearClickIndicator();
    }
  });
}

function fitCameraToBounds(
  bounds: THREE.Box3,
  center: THREE.Vector3,
  size: THREE.Vector3
) {
  const maxExtent = Math.max(size.x, size.y, size.z, 0.001);
  const sphere = new THREE.Sphere();
  bounds.getBoundingSphere(sphere);
  const radius = Math.max(sphere.radius, maxExtent * 0.5, 0.5);
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const fitDistance = radius / Math.sin(fovRad / 2);
  const distance = Math.max(fitDistance * 1.15, 2.0);

  controls.target.copy(center);
  camera.near = Math.max(distance / 500, 0.01);
  camera.far = Math.max(distance * 50, 100);
  camera.updateProjectionMatrix();
  camera.position.copy(
    center.clone().add(new THREE.Vector3(1, 0.35, 1).normalize().multiplyScalar(distance))
  );
  controls.update();

  console.log("[viewer] Camera fit distance:", distance.toFixed(3));
}

function isObjectWithinSplatMesh(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current === splatMesh) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function showClickIndicator(point: THREE.Vector3) {
  clearClickIndicator();

  const geometry = new THREE.SphereGeometry(0.05, 16, 16);
  const material = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    wireframe: true,
  });
  indicator = new THREE.Mesh(geometry, material);
  indicator.position.copy(point);
  scene.add(indicator);
}

function startFreeLook(clientX: number, clientY: number) {
  isFreeLooking = true;
  freeLookLastX = clientX;
  freeLookLastY = clientY;
  controls.enabled = false;
  canvas.style.cursor = "grabbing";

  camera.getWorldDirection(tmpLookDir);
  tmpLookDir.normalize();
  freeLookPitch = Math.asin(THREE.MathUtils.clamp(tmpLookDir.y, -1, 1));
  freeLookYaw = Math.atan2(tmpLookDir.x, tmpLookDir.z);
  freeLookDistance = Math.max(camera.position.distanceTo(controls.target), 1);
}

function endFreeLook() {
  isFreeLooking = false;
  controls.enabled = true;
  canvas.style.cursor = "";
}

function applyFreeLookOrientation() {
  const cosPitch = Math.cos(freeLookPitch);
  tmpLookDir.set(
    Math.sin(freeLookYaw) * cosPitch,
    Math.sin(freeLookPitch),
    Math.cos(freeLookYaw) * cosPitch
  );
  tmpLookDir.normalize();

  const target = camera.position.clone().addScaledVector(tmpLookDir, freeLookDistance);
  controls.target.copy(target);
  camera.lookAt(target);
}

function updateKeyboardMovement(deltaSeconds: number) {
  if (deltaSeconds <= 0 || pressedKeys.size === 0) {
    return;
  }

  let moveForward = 0;
  let moveRight = 0;
  let moveUp = 0;

  if (pressedKeys.has("w")) moveForward += 1;
  if (pressedKeys.has("s")) moveForward -= 1;
  if (pressedKeys.has("d")) moveRight += 1;
  if (pressedKeys.has("a")) moveRight -= 1;
  if (pressedKeys.has("e")) moveUp += 1;
  if (pressedKeys.has("q")) moveUp -= 1;

  if (moveForward === 0 && moveRight === 0 && moveUp === 0) {
    return;
  }

  camera.getWorldDirection(tmpForward);
  tmpForward.y = 0;
  if (tmpForward.lengthSq() < 1e-8) {
    tmpForward.set(0, 0, -1);
  } else {
    tmpForward.normalize();
  }

  tmpRight.crossVectors(tmpForward, camera.up).normalize();

  tmpMove.set(0, 0, 0);
  if (moveForward !== 0) {
    tmpMove.addScaledVector(tmpForward, moveForward);
  }
  if (moveRight !== 0) {
    tmpMove.addScaledVector(tmpRight, moveRight);
  }
  if (moveUp !== 0) {
    tmpMove.y += moveUp;
  }

  if (tmpMove.lengthSq() === 0) {
    return;
  }

  tmpMove.normalize();
  const speed = pressedKeys.has("shift")
    ? MOVE_SPEED_FAST
    : MOVE_SPEED;
  tmpMove.multiplyScalar(speed * deltaSeconds);

  camera.position.add(tmpMove);
  controls.target.add(tmpMove);
}

export function clearClickIndicator() {
  if (indicator) {
    scene.remove(indicator);
    indicator.geometry.dispose();
    if (Array.isArray(indicator.material)) {
      for (const material of indicator.material) {
        material.dispose();
      }
    } else {
      indicator.material.dispose();
    }
    indicator = null;
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }
  return Boolean(
    element.closest("input, textarea, select, [contenteditable='true']")
  );
}

export function getScreenshot(): string {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
}

export function getScreenshotWithCamera(): ScreenshotWithCamera {
  renderer.render(scene, camera);
  camera.updateMatrixWorld(true);
  const viewProjection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  return {
    dataUrl: renderer.domElement.toDataURL("image/png"),
    width: renderer.domElement.width,
    height: renderer.domElement.height,
    viewProjection,
    cameraPosition: camera.position.clone(),
  };
}

let selectionHighlight: THREE.Points | null = null;

export function showSelectionHighlight(positions: Float32Array): void {
  clearSelectionHighlight();
  if (positions.length < 3) {
    return;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const bounds = splatMesh.getBoundingBox();
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const diag = size.length();
  const pointSize = THREE.MathUtils.clamp(diag * 0.0035, 0.008, 0.05);

  const material = new THREE.PointsMaterial({
    color: 0x33e0ff,
    size: pointSize,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  selectionHighlight = new THREE.Points(geometry, material);
  scene.add(selectionHighlight);
}

export function clearSelectionHighlight(): void {
  if (!selectionHighlight) {
    return;
  }
  scene.remove(selectionHighlight);
  selectionHighlight.geometry.dispose();
  const material = selectionHighlight.material;
  if (Array.isArray(material)) {
    for (const m of material) m.dispose();
  } else {
    material.dispose();
  }
  selectionHighlight = null;
}

export function getScreenshotCropAroundPoint(
  point: THREE.Vector3,
  sizePx: number = 320
): string | null {
  renderer.render(scene, camera);

  const ndc = point.clone().project(camera);
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) {
    console.warn("[viewer] Crop failed: projected point is non-finite");
    return null;
  }
  if (ndc.z < -1 || ndc.z > 1) {
    console.warn(
      `[viewer] Crop skipped: point outside clip depth (z=${ndc.z.toFixed(3)})`
    );
    return null;
  }

  const sourceCanvas = renderer.domElement;
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  if (width <= 0 || height <= 0) {
    console.warn("[viewer] Crop failed: renderer canvas has invalid dimensions");
    return null;
  }

  const cx = Math.round((ndc.x * 0.5 + 0.5) * width);
  const cy = Math.round((-ndc.y * 0.5 + 0.5) * height);
  const cropSize = Math.max(32, Math.min(Math.round(sizePx), Math.min(width, height)));
  const half = Math.floor(cropSize / 2);

  let sx = cx - half;
  let sy = cy - half;
  sx = THREE.MathUtils.clamp(sx, 0, Math.max(0, width - cropSize));
  sy = THREE.MathUtils.clamp(sy, 0, Math.max(0, height - cropSize));

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cropSize;
  cropCanvas.height = cropSize;
  const ctx = cropCanvas.getContext("2d");
  if (!ctx) {
    console.warn("[viewer] Crop failed: 2D context unavailable");
    return null;
  }

  ctx.drawImage(sourceCanvas, sx, sy, cropSize, cropSize, 0, 0, cropSize, cropSize);
  const result = cropCanvas.toDataURL("image/png");
  console.log(
    `[viewer] Crop generated center=(${cx},${cy}) rect=(${sx},${sy},${cropSize},${cropSize}) bytes=${result.length}`
  );
  return result;
}
