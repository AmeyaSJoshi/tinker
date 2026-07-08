import { NextResponse } from "next/server";
import { listAssets } from "@/lib/assetManifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lists every library asset with its full manifest entry (anchors included).
 * Used by the /inspector page to render and fine-tune auto-anchors.
 */
export async function GET() {
  return NextResponse.json({ assets: listAssets() });
}
