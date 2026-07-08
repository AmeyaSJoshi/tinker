"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, Html, OrbitControls, useGLTF } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { Object3D, Mesh } from "three";
import type { AssetEntry } from "@/lib/assetManifest";
import type { AnchorMap, Vec3 } from "@/lib/autoManifest";

/**
 * Optional fine-tuning tool (not required by the pipeline).
 *
 * Loads any library asset, shows its auto-anchors as labeled markers, and lets
 * you click the model to move the selected anchor. When it looks right, copy the
 * generated override entry into lib/assetOverrides.ts. The auto-anchors are
 * usually good enough — this is just for the rare model that needs a nudge.
 */
export default function InspectorPage() {
  const [assets, setAssets] = useState<AssetEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<AnchorMap | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<string>("top");
  const [newAnchorName, setNewAnchorName] = useState("");

  useEffect(() => {
    fetch("/api/assets")
      .then((r) => r.json())
      .then((d) => setAssets(Array.isArray(d?.assets) ? d.assets : []))
      .catch(() => setAssets([]));
  }, []);

  const asset = useMemo(
    () => assets?.find((a) => a.id === selectedId) ?? null,
    [assets, selectedId],
  );

  // Load an asset's anchors into editable local state when it's selected.
  useEffect(() => {
    if (asset) {
      setAnchors({ ...asset.anchors });
      setActiveAnchor(Object.keys(asset.anchors)[0] ?? "top");
    } else {
      setAnchors(null);
    }
  }, [asset]);

  function placeAnchor(point: Vec3) {
    if (!activeAnchor) return;
    setAnchors((prev) => ({ ...(prev ?? {}), [activeAnchor]: point }) as AnchorMap);
  }

  function addAnchor() {
    const name = newAnchorName.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!name || !anchors) return;
    setAnchors({ ...anchors, [name]: anchors.center ?? [0, 0, 0] });
    setActiveAnchor(name);
    setNewAnchorName("");
  }

  const overrideSnippet = useMemo(() => {
    if (!asset || !anchors) return "";
    const lines = Object.entries(anchors)
      .map(
        ([name, pos]) =>
          `      ${name}: [${pos.map((n) => Number(n.toFixed(3))).join(", ")}],`,
      )
      .join("\n");
    return `  "${asset.id}": {\n    anchors: {\n${lines}\n    },\n  },`;
  }, [asset, anchors]);

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-lab-bg text-gray-200">
      {/* Controls */}
      <aside className="flex w-[360px] flex-col gap-4 overflow-y-auto border-r border-lab-border bg-lab-panel p-5">
        <div>
          <h1 className="text-lg font-bold text-white">Anchor Inspector</h1>
          <p className="mt-1 text-xs text-gray-400">
            Pick an asset, select an anchor, then click the model to move it.
            Copy the override into{" "}
            <code className="rounded bg-lab-bg px-1">lib/assetOverrides.ts</code>.
          </p>
        </div>

        <label className="text-xs text-gray-400">
          Asset
          <select
            className="mt-1 w-full rounded-md border border-lab-border bg-lab-bg px-2 py-1.5 text-sm text-white"
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value || null)}
          >
            <option value="">— choose —</option>
            {(assets ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </label>

        {assets && assets.length === 0 && (
          <p className="text-xs text-amber-300">
            No assets yet. Run{" "}
            <code className="rounded bg-lab-bg px-1">npm run fetch-assets</code>.
          </p>
        )}

        {anchors && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-gray-300">Anchors</div>
            {Object.entries(anchors).map(([name, pos]) => (
              <button
                key={name}
                onClick={() => setActiveAnchor(name)}
                className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs ${
                  activeAnchor === name
                    ? "border-lab-accent bg-lab-accent/15 text-white"
                    : "border-lab-border bg-lab-bg text-gray-400 hover:text-white"
                }`}
              >
                <span>{name}</span>
                <span className="text-[10px] text-gray-500">
                  [{pos.map((n) => n.toFixed(1)).join(", ")}]
                </span>
              </button>
            ))}

            <div className="flex gap-2 pt-1">
              <input
                value={newAnchorName}
                onChange={(e) => setNewAnchorName(e.target.value)}
                placeholder="new anchor name"
                className="flex-1 rounded-md border border-lab-border bg-lab-bg px-2 py-1 text-xs text-white"
              />
              <button
                onClick={addAnchor}
                className="rounded-md bg-lab-accent px-2 py-1 text-xs text-white"
              >
                Add
              </button>
            </div>
          </div>
        )}

        {overrideSnippet && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-300">
                Override snippet
              </span>
              <button
                onClick={() => navigator.clipboard?.writeText(overrideSnippet)}
                className="rounded-md border border-lab-border px-2 py-0.5 text-[11px] text-indigo-300 hover:text-white"
              >
                Copy
              </button>
            </div>
            <pre className="max-h-56 overflow-auto rounded-md border border-lab-border bg-lab-bg p-2 text-[10px] leading-relaxed text-gray-300">
              {overrideSnippet}
            </pre>
          </div>
        )}
      </aside>

      {/* Viewport */}
      <div className="relative flex-1">
        <Canvas shadows camera={{ position: [6, 5, 8], fov: 45 }}>
          <color attach="background" args={["#0a0a12"]} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[6, 10, 4]} intensity={1.3} castShadow />
          <directionalLight position={[-6, 4, -4]} intensity={0.4} />

          {asset && anchors && (
            <Suspense fallback={null}>
              <InspectorModel
                url={asset.url}
                scale={asset.scale}
                yOffset={asset.yOffset}
                onPick={placeAnchor}
              />
              <AnchorMarkers anchors={anchors} active={activeAnchor} />
            </Suspense>
          )}

          <Grid
            position={[0, 0, 0]}
            args={[40, 40]}
            cellSize={1}
            cellColor="#1e1e2e"
            sectionSize={5}
            sectionColor="#33334d"
            fadeDistance={40}
            infiniteGrid
          />
          <OrbitControls makeDefault enableDamping />
        </Canvas>

        {!asset && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-500">
            Choose an asset to inspect its anchors.
          </div>
        )}
      </div>
    </main>
  );
}

function InspectorModel({
  url,
  scale,
  yOffset,
  onPick,
}: {
  url: string;
  scale: number;
  yOffset: number;
  onPick: (point: Vec3) => void;
}) {
  const { scene } = useGLTF(url);
  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return clone;
  }, [scene]);

  return (
    <group
      scale={scale}
      position={[0, yOffset, 0]}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onPick([e.point.x, e.point.y, e.point.z]);
      }}
    >
      <primitive object={model} />
    </group>
  );
}

function AnchorMarkers({
  anchors,
  active,
}: {
  anchors: AnchorMap;
  active: string;
}) {
  return (
    <>
      {Object.entries(anchors).map(([name, pos]) => (
        <group key={name} position={pos}>
          <mesh>
            <sphereGeometry args={[0.12, 16, 16]} />
            <meshStandardMaterial
              color={name === active ? "#f472b6" : "#6366f1"}
              emissive={name === active ? "#f472b6" : "#6366f1"}
              emissiveIntensity={0.5}
            />
          </mesh>
          <Html distanceFactor={10}>
            <div className="pointer-events-none whitespace-nowrap rounded bg-black/70 px-1 text-[10px] text-white">
              {name}
            </div>
          </Html>
        </group>
      ))}
    </>
  );
}
