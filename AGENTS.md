# Tinker — AI Tutor That Teaches by Building

## What this is
AI for Education Hackathon @ Stanford project. A learner tells the AI tutor what they want to build ("a rocket"), a realistic 3D model appears, and the tutor guides upgrades ("add a bigger thruster"), attaching parts at physically plausible points and teaching the science behind every component. Every part — of the base model AND added parts — is clickable and explains itself. Learners accumulate concepts, get quizzed, and are remembered across sessions (EverOS). Core promise: infinite creativity — the user can build ANYTHING, and the system always produces something real-looking and teachable.

## Stack
- Next.js 14+ (App Router) + React + TypeScript, Tailwind CSS
- three.js via @react-three/fiber + @react-three/drei (useGLTF)
- LLMs via NVIDIA NIM (OpenAI-compatible, https://integrate.api.nvidia.com/v1), multiple named model slots:
  - TUTOR model: `deepseek-ai/deepseek-v4-flash`, reasoning_effort from `LLM_REASONING_EFFORT` (default max) — JSON build responses
  - EXPLAINER model: `minimaxai/minimax-m2.7` (env `EXPLAIN_LLM_MODEL`) — plain-text explanations, intent classification, part naming, chitchat
  - AUTO-FAILOVER: 2 consecutive tutor failures → switch to `mistralai/mistral-nemotron` for the server session; 25s timeouts; `LLM_FORCE_MODEL` pins a model
- 3D assets: Poly Pizza API (search + GLB download, key `POLY_PIZZA_API_KEY`) + Meshy text-to-3D API (generation tier, key `MESHY_API_KEY`) — planned, see Tier 3
- Memory: EverOS (Phase 4, env `EVEROS_API_KEY`, `EVEROS_BASE_URL`)
- Deploy: Vercel. GLBs + generated manifest are COMMITTED so deploys never re-fetch.

## THE PIPELINE (how a user message becomes a scene)

### 1. Intent Router — EVERY message goes through this first [Phase 3.4A — NOT YET BUILT]
`lib/intentRouter.ts`, one cheap explainer-model call, classifies:
`build_new | replace_base | add_parts | modify_scene | explain | chitchat` + `targetObject` (clean noun phrase, NEVER the raw sentence) + `isCompound`.
- replace_base ("this is not a mousepad, make a mousepad") → re-resolve targetObject, exclude rejected model ids (rejection memory in store)
- explain → explainer model, plain text, NO JSON schema (cannot fail validation)
- modify_scene → sceneOps; add_parts → tutor JSON path; chitchat → explainer
- Keyword-heuristic fallback if the classifier call fails

### 2. Asset resolution — four tiers, in order
1. **Library**: prefetched GLBs in /public/models, manifest at lib/assetManifest.generated.json (+ assetOverrides.ts merged on top), matched by id/alias — instant
2. **Live fetch**: Poly Pizza search (top 8 candidates) → SEMANTIC VALIDATION → download, auto-process, cache into library forever. Validation is one explainer-model call judging candidate TITLES against the user's ORIGINAL FULL PHRASE ("peanut jar" ≠ "peanut"; an Oculus controller is NOT an Xbox; single object, not a scene/pack). No candidate qualifies → answer 0 → next tier. EVERY selection path (fresh, cache, library alias) must have passed validation at least once. Cache keys use the full phrase, not the stripped noun.
3. **Meshy generation** [Phase 3.5 — NOT YET BUILT]: when search finds nothing valid, POST to Meshy text-to-3d (mode preview, GLB). ~30-60s, so: show the Tier-4 primitives version IMMEDIATELY, generate in background, then offer "✨ built a better model — swap it in?". Cache generated GLBs + credit CC BY 4.0 in CREDITS.json like everything else.
4. **Primitives fallback**: dedicated build prompt, ≥6 primitives, multiple real-object colors, never all-grey/black, distinctive features reasoned first [quality rules in Phase 3.4A].

Compound requests (`isCompound`, e.g. "gaming setup") [Phase 3.4A]: decompose into 2-6 objects, resolve each through the tiers in parallel (10s budget), arrange on floor/surfaces (store supports `baseAssets: PlacedAsset[]`; single-asset behavior unchanged).

### 3. Auto-processing every GLB (`lib/autoManifest.ts` — built)
Bounding box via @gltf-transform/core → scale to ~5 units tall, yOffset to rest on y=0 → auto-anchors from bbox faces: top, bottom, front, rear, left_side, right_side, center. CREDITS.json records {name, author, license, url} per model; footer link renders it.

### 4. Part inspection [naming quality = Phase 3.4B — NOT YET BUILT]
- Multi-mesh GLBs: submeshes enumerated, hover-highlight + tooltip, click → ExplanationCard (explainer model, cached per assetId+component). Names come from a semantic-naming LLM pass (position/size metadata → real names like "Nose cone", never "Cone 1") [3.4B]
- Single-mesh GLBs ("Bike Mesh"): 4-8 VIRTUAL hotspot dots at normalized positions with real component names, clickable like real submeshes [3.4B]
- Parts list panel lists all components (real + virtual)

### 5. Attachments [quality overhaul = Phase 3.4B — NOT YET BUILT]
LLM output contract (Zod, lib/schema.ts): reasoning field FIRST (plan anchors/sizing/symmetry before coordinates); parts carry `attachTo: {anchor} | {partId, offset}`; anchor names resolve server-side (lib/anchorResolver.ts) — the LLM NEVER invents raw coordinates near a base model. 3.4B adds: attachment contract enforced server-side (missing attachTo → retry; floating part → snap to surface), compound parts via `group` field (thruster = bell cone + throat cylinder + collar), physics orientation rules (exhaust points away, wings mirrored, sized relative to base bbox), anchor outward-direction auto-rotation.
Known bug to fix in 3.4B: resolved anchor positions may not be applied to rendered parts (parts float beside the model).

### 6. Scene ops (built)
`sceneOps` on responses: scale_base (0.2-3x clamp), recolor_base/part (clone materials, never mutate GLTF cache), brighten_base (dark models auto-brighten at load too), reset_camera, frame_all. Deterministic client-side. Stop button aborts in-flight requests. OrbitControls: zoom always enabled, user input cancels camera animations, reset-view button.

## EDUCATION RULES (this is an education product first)
- Every part carries `education`: whatItIs, howItWorks (real science), realWorld (real machine example), funFact, concepts[] — REAL and SPECIFIC, no filler
- Tutor replies: acknowledge → teach ONE idea with an analogy → ONE follow-up question. ≤120 words
- Learner levels: explorer (kid) / builder (teen) / engineer (adult) — depth adapts [Phase 4]
- Concept states: introduced → quizzed → mastered; quiz every ~3rd build action [Phase 4]
- suggestedActions always include one learning action ("Why is it cone-shaped?")

## SCHEMA NOTES (lib/schema.ts is source of truth)
Only reasoning, action, reply truly required — everything else optional-with-defaults (parts [], removedPartIds [], suggestedActions [], quiz null, followUpQuestion null, baseAssetId null, sceneOps []). Salvage pass before failing: extract largest {...} block, strip unknown keys, re-validate. Fallback error messages are dynamic and specific, never one canned line. Every fallback logs raw output + Zod error tagged [TUTOR-FALLBACK].

## STATUS — what's BUILT vs PLANNED
BUILT: phases 1-3.3 (scaffold; chat pipeline; NIM + failover; library + live fetch + validation w/ full-phrase fix; rejection memory v1; explain path split; explainer model; submesh clicking v1; stop button; sceneOps; camera fixes; demo scenes; deploy prep)
NOT YET BUILT: 3.4A (intent router, validator hardening, quality primitives, compound scenes) → 3.4B (semantic part names, virtual hotspots, attachment overhaul) → 3.5 (Meshy tier) → 4 (levels, concepts sidebar, quizzes, EverOS) → 5 (polish, demo hardening)

## CODING CONVENTIONS
TypeScript strict, no `any`. Logic in lib/, presentation in components/. lib/llm.ts is the ONLY file that talks to LLM endpoints. One phase per session; `npm run build` clean at every phase end. API keys server-side only. Never mutate the shared GLTF cache. All manual user steps must be given as a numbered list with exact commands.

## DEMO CONSTRAINTS
Rehearsed paths: rocket, volcano, human heart (library + scripted). Hidden `/demo <name>` chat command plays offline scripted sequences. `?kiosk=1` hides dev UI. Malformed LLM output must never crash the scene. Live "build anything" moments should hit tiers 1-2; tier 3 (Meshy, ~60s) is wow-insurance, not the main path.
