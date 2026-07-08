"use client";

import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import { useSceneStore } from "@/lib/sceneStore";
import PartMesh from "./PartMesh";
import BaseModel, { CameraRig, PlacedBaseModels } from "./BaseModel";
import ExplanationCard from "./ExplanationCard";
import PartsListPanel from "./PartsListPanel";

export default function Viewport() {
  const parts = useSceneStore((s) => s.parts);
  const baseAsset = useSceneStore((s) => s.baseAsset);
  const baseAssets = useSceneStore((s) => s.baseAssets);
  const selectPart = useSceneStore((s) => s.selectPart);
  const requestFrame = useSceneStore((s) => s.requestFrame);

  const isEmpty = parts.length === 0 && baseAsset == null && baseAssets.length === 0;

  return (
    <div className="relative h-full w-full bg-lab-bg">
      <Canvas
        shadows
        camera={{ position: [5, 3, 6], fov: 45 }}
        // Clicking empty space clears the current selection.
        onPointerMissed={() => selectPart(null)}
      >
        <color attach="background" args={["#0a0a12"]} />

        {/* Soft, even lighting so every face of every primitive reads. */}
        <ambientLight intensity={0.6} />
        <directionalLight
          position={[6, 10, 4]}
          intensity={1.4}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <directionalLight position={[-6, 4, -4]} intensity={0.4} />

        {/* Realistic GLB base model (if this build started from the library). */}
        <BaseModel />

        {/* Multiple placed GLB models for a compound scene ("gaming setup"). */}
        <PlacedBaseModels />

        {parts.map((part) => (
          <PartMesh key={part.id} part={part} />
        ))}

        {/* Eases the camera to frame each newly-loaded base model. */}
        <CameraRig />

        {/* Subtle ground grid to anchor the model in space. */}
        <Grid
          position={[0, -3.2, 0]}
          args={[30, 30]}
          cellSize={1}
          cellThickness={0.6}
          cellColor="#1e1e2e"
          sectionSize={5}
          sectionThickness={1}
          sectionColor="#33334d"
          fadeDistance={35}
          fadeStrength={1}
          infiniteGrid
        />

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          enableZoom
          zoomSpeed={1}
          minDistance={0.5}
          maxDistance={100}
          // Let the learner orbit close to overhead or low, but never flip
          // under the floor grid.
          maxPolarAngle={Math.PI * 0.9}
          target={[0, 0, 0]}
        />
      </Canvas>

      {/* Empty-state hint before anything has been built. */}
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-4xl opacity-60">🧊</div>
          <p className="mt-3 max-w-xs text-sm text-gray-500">
            Your build will appear here. Tell the tutor what you want to make to
            get started.
          </p>
        </div>
      )}

      {/* Parts list lives in the opposite corner from the explanation card. */}
      <PartsListPanel />

      {/* Explanation overlay lives in the viewport's corner. */}
      <ExplanationCard />

      {!isEmpty && (
        <button
          onClick={requestFrame}
          title="Reset view"
          aria-label="Reset view"
          className="pointer-events-auto absolute bottom-4 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-lab-border bg-lab-panel/95 text-base text-gray-300 shadow-2xl backdrop-blur transition-colors hover:border-lab-accent hover:text-white"
        >
          ⛶
        </button>
      )}
    </div>
  );
}
