import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { CREDITS_PATH, type CreditEntry } from "@/lib/polypizza";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves public/models/CREDITS.json so the footer can list attribution for
 * every downloaded model. CC-BY models require credit; this endpoint (fed
 * automatically by every download) is what keeps us compliant.
 */
export async function GET() {
  try {
    const raw = await fs.readFile(CREDITS_PATH, "utf8");
    const credits = JSON.parse(raw) as CreditEntry[];
    return NextResponse.json({ credits });
  } catch {
    // No models downloaded yet — an empty ledger is a valid state.
    return NextResponse.json({ credits: [] });
  }
}
