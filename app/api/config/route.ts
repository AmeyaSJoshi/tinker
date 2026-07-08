import { NextResponse } from "next/server";
import { getExplainerModelLabel, getModelLabel } from "@/lib/llm";

// Never cache: the active model can change mid-session (auto-switch on repeated
// failures), and the badge must reflect that live rather than a build-time value.
export const dynamic = "force-dynamic";

/**
 * Exposes the currently-ACTIVE LLM labels so the chat panel can show which
 * "brains" are answering: the main tutor model (build/modify/classify) and
 * the dedicated explainer model (fast component + standalone explanations).
 * Reflects both env config and any runtime auto-switch. No secrets are
 * returned (never an API key).
 */
export async function GET() {
  return NextResponse.json({
    tutorModel: getModelLabel(),
    explainerModel: getExplainerModelLabel(),
  });
}
