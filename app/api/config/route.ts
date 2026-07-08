import { NextResponse } from "next/server";
import { getModelLabel } from "@/lib/llm";

// Never cache: the active model can change mid-session (auto-switch on repeated
// failures), and the badge must reflect that live rather than a build-time value.
export const dynamic = "force-dynamic";

/**
 * Exposes the currently-ACTIVE LLM label so the chat panel can show which
 * "brain" is answering. Reflects both env config and any runtime auto-switch.
 * No secrets are returned (never the API key).
 */
export async function GET() {
  return NextResponse.json({ model: getModelLabel() });
}
