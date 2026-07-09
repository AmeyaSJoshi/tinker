/**
 * Kenney asset catalog (SERVER-ONLY).
 *
 * Kenney publishes free CC0 asset packs at kenney.nl/assets. The direct ZIP
 * URLs below were harvested from each pack page's download modal. The fetch
 * script can rediscover a fresh ZIP URL from `pageUrl` if one of these media
 * fingerprints changes later.
 */

export interface KenneyPack {
  slug: string;
  name: string;
  pageUrl: string;
  downloadUrl: string;
  topics: string[];
  concepts: string[];
}

const KENNEY_BASE = "https://kenney.nl/assets";

export const KENNEY_PACKS: KenneyPack[] = [
  {
    slug: "modular-space-kit",
    name: "Modular Space Kit",
    pageUrl: `${KENNEY_BASE}/modular-space-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/modular-space-kit/8261428a47-1771146076/kenney_modular-space-kit_1.0.zip",
    topics: ["space", "station", "sci-fi"],
    concepts: ["spaceflight", "modular design", "habitats"],
  },
  {
    slug: "space-kit",
    name: "Space Kit",
    pageUrl: `${KENNEY_BASE}/space-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/space-kit/20874c75ac-1677698978/kenney_space-kit.zip",
    topics: ["rocket", "satellite", "asteroid"],
    concepts: ["orbit", "propulsion", "space"],
  },
  {
    slug: "space-station-kit",
    name: "Space Station Kit",
    pageUrl: `${KENNEY_BASE}/space-station-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/space-station-kit/6475288f2e-1712749919/kenney_space-station-kit.zip",
    topics: ["space station", "solar array", "module"],
    concepts: ["orbit", "solar power", "structures"],
  },
  {
    slug: "car-kit",
    name: "Car Kit",
    pageUrl: `${KENNEY_BASE}/car-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip",
    topics: ["car", "vehicle", "transport"],
    concepts: ["friction", "wheels", "transportation"],
  },
  {
    slug: "train-kit",
    name: "Train Kit",
    pageUrl: `${KENNEY_BASE}/train-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/train-kit/cf8521d625-1727040883/kenney_train-kit.zip",
    topics: ["train", "rail", "locomotive"],
    concepts: ["rails", "momentum", "transportation"],
  },
  {
    slug: "watercraft-kit",
    name: "Watercraft Kit",
    pageUrl: `${KENNEY_BASE}/watercraft-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/watercraft-kit/a335cfed49-1713519620/kenney_watercraft-pack.zip",
    topics: ["boat", "ship", "watercraft"],
    concepts: ["buoyancy", "drag", "stability"],
  },
  {
    slug: "nature-kit",
    name: "Nature Kit",
    pageUrl: `${KENNEY_BASE}/nature-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip",
    topics: ["tree", "plant", "rock"],
    concepts: ["ecosystems", "photosynthesis", "geology"],
  },
  {
    slug: "city-kit-commercial",
    name: "City Kit Commercial",
    pageUrl: `${KENNEY_BASE}/city-kit-commercial`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/city-kit-commercial/a742d900eb-1753115042/kenney_city-kit-commercial_2.1.zip",
    topics: ["city", "building", "shop"],
    concepts: ["architecture", "urban planning", "structures"],
  },
  {
    slug: "city-kit-suburban",
    name: "City Kit Suburban",
    pageUrl: `${KENNEY_BASE}/city-kit-suburban`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip",
    topics: ["house", "suburb", "neighborhood"],
    concepts: ["architecture", "shelter", "community"],
  },
  {
    slug: "furniture-kit",
    name: "Furniture Kit",
    pageUrl: `${KENNEY_BASE}/furniture-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip",
    topics: ["chair", "table", "furniture"],
    concepts: ["ergonomics", "stability", "materials"],
  },
  {
    slug: "factory-kit",
    name: "Factory Kit",
    pageUrl: `${KENNEY_BASE}/factory-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/factory-kit/edaac9d4f6-1777639602/kenney_factory-kit_3.0.zip",
    topics: ["factory", "conveyor", "machine"],
    concepts: ["automation", "manufacturing", "mechanical systems"],
  },
  {
    slug: "building-kit",
    name: "Building Kit",
    pageUrl: `${KENNEY_BASE}/building-kit`,
    downloadUrl:
      "https://kenney.nl/media/pages/assets/building-kit/0de7aaa492-1743244741/kenney_building-kit.zip",
    topics: ["building", "wall", "roof"],
    concepts: ["load bearing", "architecture", "construction"],
  },
];

export function kenneyCredit(pack: KenneyPack, slug: string, modelName: string) {
  return {
    slug,
    name: modelName,
    author: "Kenney",
    license: "CC0 1.0",
    url: pack.pageUrl,
    attribution: `"${modelName}" from ${pack.name} by Kenney (kenney.nl), ${pack.pageUrl}. License: CC0 1.0.`,
  };
}

export async function discoverKenneyDownloadUrl(pack: KenneyPack): Promise<string> {
  const res = await fetch(pack.pageUrl);
  if (!res.ok) {
    throw new Error(`Kenney page fetch failed (${res.status}) for ${pack.slug}`);
  }
  const html = await res.text();
  const match = html.match(
    /https:\/\/kenney\.nl\/media\/pages\/assets\/[^'"]+\.zip/i,
  );
  return match?.[0] ?? pack.downloadUrl;
}
