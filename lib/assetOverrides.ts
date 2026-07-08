/**
 * Hand-tuned overrides, merged ON TOP of the generated manifest.
 *
 * The generated data (lib/assetManifest.generated.json) is produced automatically
 * by `npm run fetch-assets` and should never be edited by hand. When a specific
 * model needs a nudge — a better `top` anchor, an extra alias, a sharper intro —
 * add a partial entry here keyed by asset id. Anchors and aliases are MERGED so
 * you only specify what changes; use the /inspector page to generate an anchor
 * override and paste it in.
 *
 * Example:
 *   export const assetOverrides: AssetOverrides = {
 *     lighthouse: {
 *       aliases: ["beacon", "light tower"],
 *       anchors: { top: [0, 5.2, 0] },
 *     },
 *   };
 */
import type { AnchorMap } from "./autoManifest";
import type { AssetEntry } from "./assetManifest";

/** A partial entry; `anchors` is a partial anchor map (merged key-by-key). */
export type AssetOverride = Partial<Omit<AssetEntry, "anchors">> & {
  anchors?: Partial<AnchorMap>;
};

export type AssetOverrides = Record<string, AssetOverride>;

export const assetOverrides: AssetOverrides = {
  // No overrides yet — auto-anchors are working for every asset.
};
