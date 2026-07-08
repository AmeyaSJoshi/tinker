"use client";

import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Html, useGLTF } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Color, Vector3, type Mesh, type MeshStandardMaterial, type Object3D } from "three";
import { useSceneStore } from "@/lib/sceneStore";
import type { BaseAsset, Part } from "@/lib/schema";
import { extractComponents, type GlbComponent } from "@/lib/glbComponents";

/** Below this average material-channel value (0-1), a model reads as "black" and auto-brightens. */
const DARK_LUMINANCE_THRESHOLD = 0.15;
/** How far brighten lifts a material's color toward light gray (0 = no change, 1 = fully gray). */
const BRIGHTEN_LIFT = 0.45;
const BRIGHTEN_TARGET = new Color("#9ca3af");
const BRIGHTEN_EMISSIVE = new Color(0.08, 0.08, 0.08);
const SELECT_EMISSIVE = new Color("#6366f1").multiplyScalar(0.55);
const HOVER_EMISSIVE = new Color(1, 1, 1).multiplyScalar(0.12);

function isMeshObject(obj: Object3D): obj is Mesh {
  return (obj as unknown as { isMesh?: boolean }).isMesh === true;
}

/**
 * Renders the actual GLB. Suspends while the file loads (see <Suspense> below);
 * throws to the error boundary if the file is missing or corrupt.
 *
 * Every material is CLONED per-instance (never the shared GLTF cache) so this
 * load's recolor/brighten/highlight state can never bleed into another scene
 * or a fresh reload of the same model. Meshes are grouped into inspectable
 * "components" (see lib/glbComponents) for hover tooltips, click-to-explain,
 * and the Parts list panel.
 */
function GltfModel({ asset }: { asset: BaseAsset }) {
  const { scene } = useGLTF(asset.url);
  const selectComponent = useSceneStore((s) => s.selectComponent);
  const selectedComponent = useSceneStore((s) => s.selectedComponent);
  const baseScaleMultiplier = useSceneStore((s) => s.baseScaleMultiplier);
  const baseColorOverride = useSceneStore((s) => s.baseColorOverride);
  const baseBrightenRequestId = useSceneStore((s) => s.baseBrightenRequestId);
  const setBaseComponents = useSceneStore((s) => s.setBaseComponents);

  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [hoverPoint, setHoverPoint] = useState<Vector3 | null>(null);
  const [manualBrighten, setManualBrighten] = useState(false);
  const lastBrightenId = useRef(baseBrightenRequestId);

  // Clone the hierarchy AND every material, and tally the average material
  // color so we can tell if the model is "nearly black" at load time.
  const { model, avgLuminance } = useMemo(() => {
    const clone = scene.clone(true);
    let total = 0;
    let count = 0;
    clone.traverse((obj: Object3D) => {
      if (!isMeshObject(obj)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;

      const originals = Array.isArray(obj.material) ? obj.material : [obj.material];
      const cloned = originals.map((mat) => {
        const c = mat.clone() as MeshStandardMaterial;
        if (c.color) {
          c.userData.__origColor = c.color.clone();
          total += (c.color.r + c.color.g + c.color.b) / 3;
          count += 1;
        }
        return c;
      });
      obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
    });
    return { model: clone, avgLuminance: count > 0 ? total / count : 1 };
  }, [scene]);

  const components = useMemo(
    () => extractComponents(model, asset.name),
    [model, asset.name],
  );

  const meshToComponent = useMemo(() => {
    const map = new Map<Mesh, GlbComponent>();
    for (const comp of components) {
      for (const mesh of comp.meshes) map.set(mesh, comp);
    }
    return map;
  }, [components]);

  // Publish the detected components (no mesh refs) for the Parts list panel,
  // which lives outside the Canvas and can't reach into this Suspense subtree.
  useEffect(() => {
    setBaseComponents(components.map((c) => ({ key: c.key, label: c.label })));
    return () => setBaseComponents([]);
  }, [components, setBaseComponents]);

  const autoDark = avgLuminance < DARK_LUMINANCE_THRESHOLD;
  useEffect(() => {
    if (autoDark) {
      console.info(
        `[BaseModel] "${asset.name}" looked nearly black (avg channel ${avgLuminance.toFixed(2)}) — auto-brightening so it stays visible`,
      );
    }
  }, [autoDark, asset.name, avgLuminance]);

  // A manual brighten_base op bumps this id in the store; react once per bump.
  useEffect(() => {
    if (baseBrightenRequestId !== lastBrightenId.current) {
      lastBrightenId.current = baseBrightenRequestId;
      setManualBrighten(true);
    }
  }, [baseBrightenRequestId]);

  const brightenActive = autoDark || manualBrighten;

  // Single source of truth for every material's final look. Recomputed from
  // each material's ORIGINAL color every time, so recolor/brighten/hover never
  // compound across repeated triggers — no mutation of the shared GLTF cache,
  // and no drift from re-applying the same adjustment twice.
  useEffect(() => {
    const selectedKey =
      selectedComponent?.assetId === asset.id ? selectedComponent.key : null;

    for (const comp of components) {
      const isSelected = comp.key === selectedKey;
      const isHovered = !isSelected && comp.key === hoveredKey;

      for (const mesh of comp.meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          const m = mat as MeshStandardMaterial;
          const orig = m.userData.__origColor as Color | undefined;
          if (!orig || !m.color) continue;

          const color = orig.clone();
          if (baseColorOverride) color.set(baseColorOverride);
          if (brightenActive) color.lerp(BRIGHTEN_TARGET, BRIGHTEN_LIFT);
          m.color.copy(color);

          const emissive = new Color(0, 0, 0);
          if (brightenActive) emissive.add(BRIGHTEN_EMISSIVE);
          if (isSelected) emissive.add(SELECT_EMISSIVE);
          else if (isHovered) emissive.add(HOVER_EMISSIVE);
          m.emissive?.copy(emissive);
          m.emissiveIntensity = 1;
          m.needsUpdate = true;
        }
      }
    }
  }, [components, baseColorOverride, brightenActive, hoveredKey, selectedComponent, asset.id]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const comp = meshToComponent.get(e.object as Mesh);
    if (!comp) return;
    selectComponent({ assetId: asset.id, key: comp.key, label: comp.label });
  };

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const comp = meshToComponent.get(e.object as Mesh);
    setHoveredKey(comp ? comp.key : null);
    setHoverPoint(comp ? e.point.clone() : null);
    document.body.style.cursor = comp ? "pointer" : "auto";
  };

  const handlePointerOut = () => {
    setHoveredKey(null);
    setHoverPoint(null);
    document.body.style.cursor = "auto";
  };

  const hoveredLabel =
    hoveredKey != null
      ? components.find((c) => c.key === hoveredKey)?.label ?? null
      : null;

  return (
    <group
      scale={asset.scale * baseScaleMultiplier}
      position={[0, asset.yOffset, 0]}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
    >
      <primitive object={model} />
      {hoveredLabel && hoverPoint && (
        <Html position={hoverPoint} style={{ pointerEvents: "none" }}>
          <div className="-translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-lab-border bg-lab-panel/95 px-2 py-1 text-xs text-white shadow-lg">
            {hoveredLabel}
          </div>
        </Html>
      )}
    </group>
  );
}

/** A calm in-canvas spinner shown while the GLB streams in. */
function LoadingSpinner() {
  return (
    <Html center>
      <div className="flex flex-col items-center gap-2">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-400/40 border-t-indigo-400" />
        <span className="text-xs text-gray-400">Loading model…</span>
      </div>
    </Html>
  );
}

interface BoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  /** Reset the boundary when the asset changes so a new model gets a fresh try. */
  resetKey: string;
}
interface BoundaryState {
  hasError: boolean;
}

/**
 * Error boundary around the GLB. A missing or broken file must degrade to a
 * friendly message inside the viewport — never a white-screen crash.
 */
class ModelErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: unknown) {
    console.error("[BaseModel] failed to load GLB:", error);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/** In-canvas fallback when the model can't be loaded. */
function ModelError({ name }: { name: string }) {
  return (
    <Html center>
      <div className="w-56 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-center text-xs text-red-200">
        Couldn’t load the {name} model. The rest of BuildLab still works — try
        building something else.
      </div>
    </Html>
  );
}

/**
 * The scene's base MODEL, if one is loaded. Wraps the GLB in Suspense (spinner)
 * and an error boundary (friendly message), both keyed to the asset so swapping
 * models resets cleanly.
 */
export default function BaseModel() {
  const baseAsset = useSceneStore((s) => s.baseAsset);
  if (!baseAsset) return null;

  return (
    <ModelErrorBoundary
      resetKey={baseAsset.id}
      fallback={<ModelError name={baseAsset.name} />}
    >
      <Suspense fallback={<LoadingSpinner />}>
        <GltfModel key={baseAsset.id} asset={baseAsset} />
      </Suspense>
    </ModelErrorBoundary>
  );
}

/** Axis-aligned world-space bounds, used to frame the camera on the scene. */
interface Bounds {
  min: Vector3;
  max: Vector3;
}

function expandBounds(bounds: Bounds | null, min: Vector3, max: Vector3): Bounds {
  if (!bounds) return { min: min.clone(), max: max.clone() };
  return { min: bounds.min.clone().min(min), max: bounds.max.clone().max(max) };
}

/**
 * World-space bbox of the base model after `multiplier` is applied on top of
 * its own baked-in scale. The group renders as `scale * multiplier` about the
 * model's own origin, THEN translates by `[0, yOffset, 0]` — so only the Y
 * axis has an offset to hold fixed while X/Z scale about 0.
 */
function scaledBaseBounds(asset: BaseAsset, multiplier: number): Bounds {
  const bb = asset.boundingBox;
  const scaleAroundOffset = (lo: number, hi: number, offset: number): [number, number] => [
    (lo - offset) * multiplier + offset,
    (hi - offset) * multiplier + offset,
  ];
  const [minX, maxX] = scaleAroundOffset(bb.min[0], bb.max[0], 0);
  const [minY, maxY] = scaleAroundOffset(bb.min[1], bb.max[1], asset.yOffset);
  const [minZ, maxZ] = scaleAroundOffset(bb.min[2], bb.max[2], 0);
  return { min: new Vector3(minX, minY, minZ), max: new Vector3(maxX, maxY, maxZ) };
}

/** Approximate half-extents [x, y, z] of a primitive part from its shape + dimensions. */
function partHalfExtent(part: Part): [number, number, number] {
  const d = part.dimensions;
  switch (part.shape) {
    case "box":
      return [(d.width ?? 1) / 2, (d.height ?? 1) / 2, (d.depth ?? 1) / 2];
    case "sphere": {
      const r = d.radius ?? 0.5;
      return [r, r, r];
    }
    case "cylinder":
    case "cone": {
      const r = Math.max(d.radiusTop ?? d.radius ?? 0.5, d.radiusBottom ?? d.radius ?? 0.5);
      return [r, (d.height ?? 1) / 2, r];
    }
    case "torus": {
      const r = d.radius ?? 0.5;
      const tube = r * 0.35;
      return [r + tube, tube, r + tube];
    }
    case "capsule": {
      const r = d.radius ?? 0.3;
      return [r, (d.height ?? 1) / 2 + r, r];
    }
    default:
      return [0.5, 0.5, 0.5];
  }
}

/** Union of the (scaled) base model's bounds with every primitive part's bounds. */
function computeSceneBounds(
  baseAsset: BaseAsset | null,
  baseScaleMultiplier: number,
  parts: Part[],
): Bounds | null {
  let bounds: Bounds | null = baseAsset
    ? scaledBaseBounds(baseAsset, baseScaleMultiplier)
    : null;

  for (const part of parts) {
    const [hx, hy, hz] = partHalfExtent(part);
    const [px, py, pz] = part.position;
    bounds = expandBounds(
      bounds,
      new Vector3(px - hx, py - hy, pz - hz),
      new Vector3(px + hx, py + hy, pz + hz),
    );
  }

  return bounds;
}

function framingGoal(bounds: Bounds): { camPos: Vector3; target: Vector3 } {
  const target = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
  const size = bounds.max.clone().sub(bounds.min);
  const extent = Math.max(size.x, size.y, size.z, 1);
  const dist = extent * 1.9 + 2;
  const dir = new Vector3(1, 0.65, 1).normalize();
  return { camPos: target.clone().add(dir.multiplyScalar(dist)), target };
}

/**
 * Smoothly frames the camera on the whole scene (base model + primitive
 * parts). Reframes when: a new base model loads, or `frameSignal` in the
 * store bumps (the "⛶ Reset view" button, or a scale_base / frame_all /
 * reset_camera sceneOp). The moment the learner drags or zooms, any
 * in-progress auto-frame is cancelled — user input always wins, so it can
 * never fight an animation the way the old camera rig did. Requires
 * OrbitControls with `makeDefault` so `controls` is available from R3F state.
 */
export function CameraRig() {
  const baseAsset = useSceneStore((s) => s.baseAsset);
  const baseScaleMultiplier = useSceneStore((s) => s.baseScaleMultiplier);
  const parts = useSceneStore((s) => s.parts);
  const frameSignal = useSceneStore((s) => s.frameSignal);
  const { camera, controls } = useThree();
  const lastAssetId = useRef<string | null>(null);
  const lastFrameSignal = useRef(frameSignal);
  const goal = useRef<{ camPos: Vector3; target: Vector3 } | null>(null);

  useEffect(() => {
    if (!baseAsset) {
      lastAssetId.current = null;
      return;
    }
    if (baseAsset.id === lastAssetId.current) return;
    lastAssetId.current = baseAsset.id;

    const bounds = computeSceneBounds(baseAsset, baseScaleMultiplier, parts);
    if (bounds) goal.current = framingGoal(bounds);
  }, [baseAsset, baseScaleMultiplier, parts]);

  useEffect(() => {
    if (frameSignal === lastFrameSignal.current) return;
    lastFrameSignal.current = frameSignal;

    const bounds = computeSceneBounds(baseAsset, baseScaleMultiplier, parts);
    if (bounds) goal.current = framingGoal(bounds);
  }, [frameSignal, baseAsset, baseScaleMultiplier, parts]);

  // Cancel any in-progress auto-frame the instant the learner interacts, so
  // zoom/drag/pan is never fought by the camera snapping back mid-gesture.
  useEffect(() => {
    const ctrl = controls as unknown as {
      addEventListener?: (event: string, cb: () => void) => void;
      removeEventListener?: (event: string, cb: () => void) => void;
    } | null;
    if (!ctrl?.addEventListener) return;
    const onUserStart = () => {
      goal.current = null;
    };
    ctrl.addEventListener("start", onUserStart);
    return () => ctrl.removeEventListener?.("start", onUserStart);
  }, [controls]);

  useFrame(() => {
    const g = goal.current;
    if (!g) return;
    camera.position.lerp(g.camPos, 0.12);
    const ctrl = controls as unknown as {
      target?: Vector3;
      update?: () => void;
    } | null;
    if (ctrl?.target) {
      ctrl.target.lerp(g.target, 0.12);
      ctrl.update?.();
    } else {
      camera.lookAt(g.target);
    }
    // Stop tweening once we're basically there.
    if (camera.position.distanceTo(g.camPos) < 0.05) {
      goal.current = null;
    }
  });

  return null;
}
