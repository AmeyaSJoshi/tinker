import type { TutorResponse } from "./schema";

/**
 * DEMO INSURANCE — fully hardcoded build sequences that play with no network.
 *
 * If the wifi or the LLM dies on stage, typing the hidden command `/demo
 * spaceship` (or `volcano` / `heart`) in chat replays one of these scripted
 * sequences step by step, exactly as if the model had produced it. Each array
 * is an ordered list of TutorResponses: step 0 is a create_base, the rest are
 * add_parts that build on it. These bypass the API entirely, so their geometry
 * (e.g. a magma chamber below ground) is never touched by the server sanity
 * pass — they render as authored.
 */

const spaceship: TutorResponse[] = [
  {
    reasoning:
      "create_base for a rocket. Fuselage is a 3-tall cylinder centered at origin (y[-1.5,1.5]). Nose cone sits ON TOP at y=2.1; engine bell hangs BELOW at y=-2. Three fins at 120° around the base at y=-1. Portholes on the +z face.",
    action: "create_base",
    reply:
      "Here's your starter spaceship — a fuselage to hold everything, a pointed nose to cut through air, an engine bell at the bottom, and three fins for stability. Together they form the classic rocket recipe: thrust at the base, low drag up front, and passive steadying from the fins. Click any part to dig into the science.",
    parts: [
      {
        id: "fuselage",
        shape: "cylinder",
        dimensions: { radiusTop: 0.5, radiusBottom: 0.5, height: 3 },
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        color: "#b8c0cc",
        name: "Fuselage",
        explanation:
          "The fuselage is the main body that holds fuel, crew, and cargo. Rockets are thin-walled cylinders because a cylinder is one of the strongest, lightest shapes for containing pressurized propellant.",
        concepts: ["structural efficiency", "pressure vessels"],
      },
      {
        id: "nose_cone",
        shape: "cone",
        dimensions: { radius: 0.5, height: 1.2 },
        position: [0, 2.1, 0],
        rotation: [0, 0, 0],
        color: "#d0d6df",
        name: "Nose Cone",
        explanation:
          "The pointed nose slices through the atmosphere, keeping drag low as the rocket accelerates past the speed of sound, and shields the payload from the heat that builds on the leading surface.",
        concepts: ["aerodynamics", "drag", "supersonic flight"],
      },
      {
        id: "engine_bell",
        shape: "cone",
        dimensions: { radiusTop: 0.15, radiusBottom: 0.6, height: 1 },
        position: [0, -2, 0],
        rotation: [0, 0, 0],
        color: "#2a2a30",
        name: "Engine Bell (Nozzle)",
        explanation:
          "The flared bell is a de Laval nozzle: hot gas is squeezed through a narrow throat, then expands down the widening cone into high-speed exhaust. That exhaust pushes the rocket forward by Newton's third law.",
        concepts: ["Newton's third law", "thrust", "nozzle expansion"],
      },
      {
        id: "fin_1",
        shape: "box",
        dimensions: { width: 0.08, height: 1, depth: 0.8 },
        position: [0, -1, 0.55],
        rotation: [0, 0, 0],
        color: "#8a94a3",
        name: "Stabilizer Fin A",
        explanation:
          "Fins push the rocket's center of pressure behind its center of mass, so oncoming air straightens any wobble instead of amplifying it — the same reason an arrow flies true.",
        concepts: ["stability", "center of pressure"],
      },
      {
        id: "fin_2",
        shape: "box",
        dimensions: { width: 0.08, height: 1, depth: 0.8 },
        position: [0.476, -1, -0.275],
        rotation: [0, 2.094, 0],
        color: "#8a94a3",
        name: "Stabilizer Fin B",
        explanation:
          "This fin sits 120° around the base. Spacing three fins symmetrically means their restoring forces cancel in steady flight and only kick in when the rocket tips.",
        concepts: ["stability", "symmetry"],
      },
      {
        id: "fin_3",
        shape: "box",
        dimensions: { width: 0.08, height: 1, depth: 0.8 },
        position: [-0.476, -1, -0.275],
        rotation: [0, 4.189, 0],
        color: "#8a94a3",
        name: "Stabilizer Fin C",
        explanation:
          "The third fin completes the 120° triangle. Three fins resist tumbling about every axis while carrying less drag and mass than four would.",
        concepts: ["stability", "drag"],
      },
    ],
    removedPartIds: [],
    sceneOps: [],
    followUpQuestion: "Should we make it survive a fiery re-entry next?",
    suggestedActions: [
      "Make it survive re-entry",
      "Add landing legs",
      "Why are there exactly three fins?",
    ],
  },
  {
    reasoning:
      "add_parts: re-entry survival = heat shield. Anchor is the fuselage bottom at y=-1.5. A blunt, wide shield spreads and deflects the shock-heated air. Place a shallow truncated cone (radiusBottom 1.0) just under the fuselage at y=-1.65 so it overlaps the base — no gap.",
    action: "add_parts",
    reply:
      "To survive re-entry I added a broad, blunt heat shield across the base. Counterintuitively, a BLUNT shape survives better than a sharp one: it pushes a bow shockwave out ahead of the craft so most of the searing heat stays in the air, not the vehicle. The wide disc also spreads that heat over a large area instead of a point.",
    parts: [
      {
        id: "heat_shield",
        shape: "cone",
        dimensions: { radiusTop: 1.0, radiusBottom: 0.55, height: 0.4 },
        position: [0, -1.7, 0],
        rotation: [0, 0, 0],
        color: "#7a3b2e",
        name: "Ablative Heat Shield",
        explanation:
          "The heat shield is a blunt disc that faces the direction of travel during re-entry. Its bluntness forces a detached bow shock that carries away most of the heat, and an ablative coating burns off in a controlled way to soak up the rest.",
        concepts: ["bow shock", "ablation", "thermal protection"],
      },
    ],
    removedPartIds: [],
    sceneOps: [],
    followUpQuestion: "Now that it can come home, should we give it legs to land on?",
    suggestedActions: [
      "Add landing legs",
      "Add a parachute",
      "How does an ablative shield work?",
    ],
  },
  {
    reasoning:
      "add_parts: landing legs. Symmetric set of three splaying from the lower fuselage (y≈-1.4) outward and down to ~y=-2.7, matching the 120° fin spacing so the stance is balanced. Each leg touches the fuselage at the top.",
    action: "add_parts",
    reply:
      "I added three splayed landing legs, one under each fin line, so the ship lands on a wide, stable tripod. A tripod is the fewest legs that can't rock, and spreading them wide lowers the effective center of mass between the contact points — that's what keeps a tall rocket from tipping over on touchdown.",
    parts: [
      {
        id: "leg_1",
        shape: "cylinder",
        dimensions: { radiusTop: 0.06, radiusBottom: 0.09, height: 1.6 },
        position: [0, -2.3, 0.9],
        rotation: [0.5, 0, 0],
        color: "#5b616b",
        name: "Landing Leg A",
        explanation:
          "Each leg is a strut angled outward from the body. Splaying the legs widens the base so the craft's weight lands inside the triangle of contact points, resisting tip-over.",
        concepts: ["stability", "base of support"],
      },
      {
        id: "leg_2",
        shape: "cylinder",
        dimensions: { radiusTop: 0.06, radiusBottom: 0.09, height: 1.6 },
        position: [0.78, -2.3, -0.45],
        rotation: [0.5, 2.094, 0],
        color: "#5b616b",
        name: "Landing Leg B",
        explanation:
          "The second leg sits 120° around. Even spacing means each leg carries a third of the landing load, so no single strut is overstressed at touchdown.",
        concepts: ["load sharing", "symmetry"],
      },
      {
        id: "leg_3",
        shape: "cylinder",
        dimensions: { radiusTop: 0.06, radiusBottom: 0.09, height: 1.6 },
        position: [-0.78, -2.3, -0.45],
        rotation: [0.5, 4.189, 0],
        color: "#5b616b",
        name: "Landing Leg C",
        explanation:
          "The third leg completes the tripod. Three points always define a stable plane, so the craft won't rock even on uneven ground.",
        concepts: ["tripod stability", "geometry"],
      },
    ],
    removedPartIds: [],
    sceneOps: [],
    followUpQuestion: "Want to explore how the whole thing works together, or build something new?",
    suggestedActions: [
      "Explain the full flight profile",
      "Build something new",
      "Why is a tripod more stable than four legs?",
    ],
  },
];

const volcano: TutorResponse[] = [
  {
    reasoning:
      "create_base for a volcano. Mountain is a big truncated cone with base ON the ground: height 3, center y=1.5 (spans y[0,3]). Crater rim torus at the top y=3. Glowing lava pool cylinder just inside the crater. A magma chamber sphere sits BELOW ground (y=-1) — intentional, teaching where the melt comes from.",
    action: "create_base",
    reply:
      "Here's a volcano: a broad cone of built-up rock, a crater at the summit, a pool of glowing lava in it, and — hidden below ground — the magma chamber that feeds it. The shape isn't random: runny or explosive eruptions stack lava and ash into this cone over time, and the deep chamber is the pressurized reservoir driving the whole system.",
    parts: [
      {
        id: "mountain",
        shape: "cone",
        dimensions: { radiusTop: 0.9, radiusBottom: 2.6, height: 3 },
        position: [0, 1.5, 0],
        rotation: [0, 0, 0],
        color: "#5a4a42",
        name: "Volcanic Cone",
        explanation:
          "The cone is built from layers of cooled lava and ash piled up by past eruptions. Its slope reflects the eruption style — runny lava spreads into gentle shield slopes, stickier lava and ash pile into steeper cones.",
        concepts: ["stratovolcano", "deposition", "geology"],
      },
      {
        id: "crater_rim",
        shape: "torus",
        dimensions: { radius: 0.9 },
        position: [0, 3, 0],
        rotation: [1.5708, 0, 0],
        color: "#463a34",
        name: "Crater Rim",
        explanation:
          "The crater is the vent's mouth at the summit, ringed by the rim. It forms where erupted material is thrown out around the opening and where the ground can collapse back into the emptying vent.",
        concepts: ["vent", "crater formation"],
      },
      {
        id: "lava_pool",
        shape: "cylinder",
        dimensions: { radiusTop: 0.7, radiusBottom: 0.7, height: 0.3 },
        position: [0, 3.0, 0],
        rotation: [0, 0, 0],
        color: "#ff5a1f",
        name: "Lava Pool",
        explanation:
          "This glowing pool is molten rock that has risen up the vent. Its color maps to temperature — brighter orange-yellow is hotter — and its thickness (viscosity) controls whether it oozes out gently or traps gas and erupts violently.",
        concepts: ["magma", "viscosity", "temperature"],
      },
      {
        id: "magma_chamber",
        shape: "sphere",
        dimensions: { radius: 1.1 },
        position: [0, -1.0, 0],
        rotation: [0, 0, 0],
        color: "#8c1d0f",
        name: "Magma Chamber",
        explanation:
          "Deep below the surface, the magma chamber is a reservoir of molten rock under enormous pressure. As fresh magma rises into it and gases build up, that pressure eventually forces material up the vent — the engine behind every eruption.",
        concepts: ["magma chamber", "pressure", "buoyancy"],
      },
    ],
    removedPartIds: [],
    sceneOps: [],
    followUpQuestion: "Ready to make it erupt with an ash plume and a lava flow?",
    suggestedActions: [
      "Make it erupt",
      "Add a lava flow down the side",
      "Why does trapped gas cause explosions?",
    ],
  },
  {
    reasoning:
      "add_parts: an eruption = ash plume + lava flow. Plume is a stack of grey spheres rising above the crater (y from 4 up), widening as it rises. Lava flow is a thin bright strip running down the +z flank from the crater lip (~y=3) to the ground, hugging the cone surface.",
    action: "add_parts",
    reply:
      "Eruption time! I sent up a billowing ash plume and let a lava flow spill down the flank. These two show the volcano's split personality: the plume is buoyant hot gas and fine ash punched skyward, while the flow is denser molten rock that can't stay airborne, so gravity drags it down the slope. Same vent, two very different behaviors driven by density.",
    parts: [
      {
        id: "ash_lower",
        shape: "sphere",
        dimensions: { radius: 0.8 },
        position: [0, 4.1, 0],
        rotation: [0, 0, 0],
        color: "#6b6b6b",
        name: "Ash Plume (base)",
        explanation:
          "The plume's base is hot gas and ash rushing out of the vent. It's less dense than the surrounding air, so it rockets upward — the same buoyancy that lifts a hot-air balloon, but far more violent.",
        concepts: ["buoyancy", "convection", "pyroclastic"],
      },
      {
        id: "ash_mid",
        shape: "sphere",
        dimensions: { radius: 1.0 },
        position: [0.2, 5.2, 0],
        rotation: [0, 0, 0],
        color: "#808080",
        name: "Ash Plume (middle)",
        explanation:
          "As the plume rises it entrains and heats surrounding air, expanding and mushrooming outward. The widening shape traces the column slowing down as it climbs.",
        concepts: ["entrainment", "expansion"],
      },
      {
        id: "ash_top",
        shape: "sphere",
        dimensions: { radius: 1.3 },
        position: [0.5, 6.4, 0],
        rotation: [0, 0, 0],
        color: "#9a9a9a",
        name: "Ash Cloud (top)",
        explanation:
          "At the top the plume loses its upward push and spreads sideways into an umbrella cloud, where fine ash drifts on the wind and can travel for hundreds of kilometers.",
        concepts: ["umbrella cloud", "ash dispersal"],
      },
      {
        id: "lava_flow",
        shape: "box",
        dimensions: { width: 0.5, height: 0.15, depth: 2.6 },
        position: [0.9, 1.6, 0.9],
        rotation: [0.9, 0.6, 0],
        color: "#ff7a33",
        name: "Lava Flow",
        explanation:
          "The flow is molten rock too dense to loft into the air, so it streams downhill under gravity, cooling and darkening at its crust while staying hot and fluid inside. Its speed depends on slope and viscosity.",
        concepts: ["gravity flow", "viscosity", "cooling"],
      },
    ],
    removedPartIds: [],
    sceneOps: [],
    followUpQuestion: "Want to explore what determines whether a volcano oozes or explodes?",
    suggestedActions: [
      "Explain effusive vs explosive",
      "Build something new",
      "Why does the ash cloud spread sideways at the top?",
    ],
  },
];

const heart: TutorResponse[] = [
  {
    reasoning:
      "create_base for a human heart. Four chambers as overlapping blobs: two lower ventricles (capsules) and two upper atria (spheres). Left side is bigger/darker (oxygen-poor vs -rich convention flipped for teaching). Centered near origin, spanning roughly y[-1,1.4]. Chambers overlap so nothing floats.",
    action: "create_base",
    reply:
      "Here's the heart's core: four chambers. The two lower ventricles are the powerful pumps, and the two upper atria are the collecting rooms that fill them. They're arranged as two side-by-side pumps — the right side sends blood to the lungs, the left side pushes it to the whole body, which is why the left ventricle is the thickest, strongest chamber.",
    parts: [
      {
        id: "left_ventricle",
        shape: "capsule",
        dimensions: { radius: 0.85, height: 1.3 },
        position: [0.35, -0.2, 0],
        rotation: [0.2, 0, 0.2],
        color: "#b21b1b",
        name: "Left Ventricle",
        explanation:
          "The left ventricle is the heart's main pump, driving oxygen-rich blood out to the entire body. Its wall is the thickest of all four chambers because it must generate enough pressure to reach your toes and brain.",
        concepts: ["circulation", "pressure", "muscle"],
      },
      {
        id: "right_ventricle",
        shape: "capsule",
        dimensions: { radius: 0.72, height: 1.15 },
        position: [-0.55, -0.15, 0.15],
        rotation: [0.2, 0, -0.15],
        color: "#c8322f",
        name: "Right Ventricle",
        explanation:
          "The right ventricle pumps oxygen-poor blood the short distance to the lungs. It needs far less pressure than the left, so its wall is noticeably thinner.",
        concepts: ["pulmonary circulation", "pressure"],
      },
      {
        id: "left_atrium",
        shape: "sphere",
        dimensions: { radius: 0.58 },
        position: [0.5, 0.85, -0.05],
        rotation: [0, 0, 0],
        color: "#8f1414",
        name: "Left Atrium",
        explanation:
          "The left atrium receives oxygen-rich blood returning from the lungs and empties it into the left ventricle. Atria are thin-walled because they only push blood a few centimeters into the ventricle below.",
        concepts: ["blood return", "chambers"],
      },
      {
        id: "right_atrium",
        shape: "sphere",
        dimensions: { radius: 0.58 },
        position: [-0.6, 0.85, 0.1],
        rotation: [0, 0, 0],
        color: "#a52222",
        name: "Right Atrium",
        explanation:
          "The right atrium collects oxygen-poor blood arriving from the body and passes it to the right ventricle. It's the first stop on blood's journey back to the lungs to reload with oxygen.",
        concepts: ["blood return", "chambers"],
      },
    ],
    removedPartIds: [],
    sceneOps: [],
    followUpQuestion: "Shall we plumb in the great vessels that carry blood in and out?",
    suggestedActions: [
      "Add the great vessels",
      "Add the heart valves",
      "Why is the left ventricle so much thicker?",
    ],
  },
  {
    reasoning:
      "add_parts: the great vessels rising from the top of the chambers. Aorta arches up from the left ventricle (anchor at ~[0.3,0.6]); pulmonary artery from the right ventricle; superior vena cava into the right atrium. Each is a cylinder whose base overlaps its chamber (no gap) and rises above y=1.4.",
    action: "add_parts",
    reply:
      "I plumbed in the great vessels — the pipes that connect the heart to the rest of the body. The aorta carries high-pressure oxygen-rich blood out from the left ventricle; the pulmonary artery routes oxygen-poor blood to the lungs; and the vena cava returns spent blood to the right atrium. Follow them and you can trace the entire double loop: body → heart → lungs → heart → body.",
    parts: [
      {
        id: "aorta",
        shape: "cylinder",
        dimensions: { radiusTop: 0.26, radiusBottom: 0.3, height: 1.6 },
        position: [0.25, 1.5, -0.1],
        rotation: [0.25, 0, 0.15],
        color: "#c0392b",
        name: "Aorta",
        explanation:
          "The aorta is the body's largest artery, taking oxygen-rich blood from the left ventricle out to everything. Its thick, elastic wall stretches with each powerful beat and recoils to keep blood flowing smoothly between beats.",
        concepts: ["arteries", "elasticity", "systemic circulation"],
      },
      {
        id: "pulmonary_artery",
        shape: "cylinder",
        dimensions: { radiusTop: 0.22, radiusBottom: 0.26, height: 1.3 },
        position: [-0.35, 1.45, 0.2],
        rotation: [0.35, 0, -0.25],
        color: "#7d6bd6",
        name: "Pulmonary Artery",
        explanation:
          "The pulmonary artery is unusual: it's an artery that carries oxygen-POOR blood, sending it from the right ventricle to the lungs to pick up oxygen. It's shown in blue-purple to mark that low-oxygen blood.",
        concepts: ["pulmonary circulation", "gas exchange"],
      },
      {
        id: "vena_cava",
        shape: "cylinder",
        dimensions: { radiusTop: 0.2, radiusBottom: 0.22, height: 1.2 },
        position: [-0.75, 1.4, -0.15],
        rotation: [-0.2, 0, -0.1],
        color: "#4a6fa5",
        name: "Superior Vena Cava",
        explanation:
          "The superior vena cava is a large vein returning oxygen-poor blood from the upper body into the right atrium. Veins run at low pressure, so their walls are thinner than arteries and they rely on one-way valves to keep blood moving toward the heart.",
        concepts: ["veins", "venous return", "low pressure"],
      },
    ],
    removedPartIds: [],
    sceneOps: [],
    followUpQuestion: "Want to trace one full loop of a blood cell, or build something new?",
    suggestedActions: [
      "Trace a blood cell's journey",
      "Add the heart valves",
      "Why is the pulmonary artery carrying low-oxygen blood?",
    ],
  },
];

export type DemoName = "spaceship" | "volcano" | "heart";

export const demoScenes: Record<DemoName, TutorResponse[]> = {
  spaceship,
  volcano,
  heart,
};

/** Parse a hidden "/demo <name>" command. Returns the name or null. */
export function parseDemoCommand(text: string): DemoName | null {
  const match = /^\/demo\s+(spaceship|volcano|heart)\s*$/i.exec(text.trim());
  return match ? (match[1].toLowerCase() as DemoName) : null;
}
