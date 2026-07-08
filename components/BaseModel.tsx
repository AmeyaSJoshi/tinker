"use client";

import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Html, useGLTF } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Vector3, type Mesh, type Object3D } from "three";
import { BASE_SELECTION_ID, useSceneStore } from "@/lib/sceneStore";
import type { BaseAsset } from "@/lib/schema";

/**
 * Renders the actual GLB. Suspends while the file loads (see <Suspense> below);
 * throws to the error boundary if the file is missing or corrupt. The mesh is
 * scaled + rested on the ground exactly as lib/autoManifest.ts computed, so the
 * server's anchors line up with what's on screen.
 */
function GltfModel({ asset }: { asset: BaseAsset }) {
  const { scene } = useGLTF(asset.url);
  const selectPart = useSceneStore((s) => s.selectPart);

  // Clone so multiple loads / HMR don't mutate the cached original, and turn on
  // shadows for every mesh in the hierarchy.
  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((obj: Object3D) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return clone;
  }, [scene]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    selectPart(BASE_SELECTION_ID);
  };

  return (
    <group
      scale={asset.scale}
      position={[0, asset.yOffset, 0]}
      onClick={handleClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "auto";
      }}
    >
      <primitive object={model} />
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

/**
 * Smoothly frames the camera on a newly-loaded base model. Watches the store's
 * baseAsset; when a new one appears, it eases the camera + orbit target to fit
 * the model's bounding box over a few frames. Requires OrbitControls with
 * `makeDefault` so `controls` is available from the R3F state.
 */
export function CameraRig() {
  const baseAsset = useSceneStore((s) => s.baseAsset);
  const { camera, controls } = useThree();
  const lastId = useRef<string | null>(null);
  const goal = useRef<{ camPos: Vector3; target: Vector3 } | null>(null);

  useEffect(() => {
    if (!baseAsset) {
      lastId.current = null;
      return;
    }
    if (baseAsset.id === lastId.current) return;
    lastId.current = baseAsset.id;

    const bb = baseAsset.boundingBox;
    const target = new Vector3(
      (bb.min[0] + bb.max[0]) / 2,
      (bb.min[1] + bb.max[1]) / 2,
      (bb.min[2] + bb.max[2]) / 2,
    );
    const extent = Math.max(bb.size[0], bb.size[1], bb.size[2], 1);
    const dist = extent * 1.9 + 2;
    const dir = new Vector3(1, 0.65, 1).normalize();
    goal.current = {
      camPos: target.clone().add(dir.multiplyScalar(dist)),
      target,
    };
  }, [baseAsset]);

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
