"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { Mesh } from "three";
import type { Part } from "@/lib/schema";
import { useSceneStore } from "@/lib/sceneStore";

/** How long a freshly-added part takes to scale in from 0 to full size. */
const GROW_MS = 400;

/**
 * Builds the right Three.js geometry element for a part's `shape` +
 * `dimensions`. Only the keys relevant to each primitive are read, with
 * sensible fallbacks so a slightly under-specified manifest still renders.
 */
function geometryFor(part: Part) {
  const d = part.dimensions;

  switch (part.shape) {
    case "box":
      return (
        <boxGeometry args={[d.width ?? 1, d.height ?? 1, d.depth ?? 1]} />
      );
    case "sphere":
      return <sphereGeometry args={[d.radius ?? 0.5, 32, 32]} />;
    case "cylinder":
      return (
        <cylinderGeometry
          args={[
            d.radiusTop ?? d.radius ?? 0.5,
            d.radiusBottom ?? d.radius ?? 0.5,
            d.height ?? 1,
            32,
          ]}
        />
      );
    case "cone":
      // A cone is a cylinder with a zero-radius top; supporting radiusTop /
      // radiusBottom also lets us render truncated cones like an engine bell.
      return (
        <cylinderGeometry
          args={[
            d.radiusTop ?? 0,
            d.radiusBottom ?? d.radius ?? 0.5,
            d.height ?? 1,
            32,
          ]}
        />
      );
    case "torus":
      return (
        <torusGeometry
          args={[d.radius ?? 0.5, (d.radius ?? 0.5) * 0.35, 16, 48]}
        />
      );
    case "capsule":
      return (
        <capsuleGeometry args={[d.radius ?? 0.3, d.height ?? 1, 8, 24]} />
      );
    default:
      return <boxGeometry args={[1, 1, 1]} />;
  }
}

export default function PartMesh({ part }: { part: Part }) {
  const selectedPartId = useSceneStore((s) => s.selectedPartId);
  const selectPart = useSceneStore((s) => s.selectPart);
  const [hovered, setHovered] = useState(false);

  const isSelected = selectedPartId === part.id;
  const geometry = useMemo(() => geometryFor(part), [part]);

  // Assembly polish: scale the mesh in from 0 → 1 over GROW_MS when it first
  // appears, so newly-added parts pop into place instead of blinking on. The
  // start time is captured on mount, so each part animates once.
  const meshRef = useRef<Mesh>(null);
  const startRef = useRef<number | null>(null);
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (startRef.current === null) startRef.current = performance.now();
    const t = Math.min((performance.now() - startRef.current) / GROW_MS, 1);
    // easeOutBack for a subtle overshoot that reads as "snapping" into place.
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const eased = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    const s = t >= 1 ? 1 : eased;
    mesh.scale.setScalar(s);
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    selectPart(part.id);
  };

  const handleOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
  };

  const handleOut = () => setHovered(false);

  // Highlight priority: selected reads strongest, hover is a gentle hint.
  const emissive = isSelected ? part.color : hovered ? "#ffffff" : "#000000";
  const emissiveIntensity = isSelected ? 0.55 : hovered ? 0.12 : 0;

  return (
    <mesh
      ref={meshRef}
      position={part.position}
      rotation={part.rotation}
      scale={0}
      onClick={handleClick}
      onPointerOver={handleOver}
      onPointerOut={handleOut}
      castShadow
      receiveShadow
    >
      {geometry}
      <meshStandardMaterial
        color={part.color}
        metalness={0.6}
        roughness={0.35}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
      />
    </mesh>
  );
}
