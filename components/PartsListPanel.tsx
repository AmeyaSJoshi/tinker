"use client";

import { useState } from "react";
import { useSceneStore } from "@/lib/sceneStore";
import { isVirtualComponentKey } from "./VirtualHotspots";

/**
 * Small collapsible "what is this thing made of" panel in the viewport corner
 * — every detected component of the current base GLB, click to highlight +
 * explain (same selection path as clicking the submesh directly).
 */
export default function PartsListPanel() {
  const baseAsset = useSceneStore((s) => s.baseAsset);
  const baseComponents = useSceneStore((s) => s.baseComponents);
  const selectedComponent = useSceneStore((s) => s.selectedComponent);
  const selectComponent = useSceneStore((s) => s.selectComponent);
  const [collapsed, setCollapsed] = useState(false);

  if (!baseAsset || baseComponents.length === 0) return null;

  return (
    <div className="pointer-events-auto absolute right-4 top-4 w-52 overflow-hidden rounded-xl border border-lab-border bg-lab-panel/95 shadow-2xl backdrop-blur">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-gray-300 hover:text-white"
      >
        <span>🔩 Parts list ({baseComponents.length})</span>
        <span className="text-gray-500">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <ul className="max-h-64 space-y-0.5 overflow-y-auto px-2 pb-2">
          {baseComponents.map((c) => {
            const isSelected =
              selectedComponent?.assetId === baseAsset.id &&
              selectedComponent.key === c.key;
            return (
              <li key={c.key}>
                <button
                  onClick={() =>
                    selectComponent({ assetId: baseAsset.id, key: c.key, label: c.label })
                  }
                  className={`flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-xs transition-colors ${
                    isSelected
                      ? "bg-lab-accent text-white"
                      : "text-gray-300 hover:bg-lab-bg hover:text-white"
                  }`}
                >
                  {isVirtualComponentKey(c.key) && (
                    <span className="flex-shrink-0 text-[8px] opacity-70" aria-hidden>
                      ●
                    </span>
                  )}
                  <span className="truncate">{c.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
