// Curated, one-click prompt packs. Each pack fans out its prompts through the
// existing /api/generate endpoint (see components/PackPicker.tsx), so the
// shapes here mirror that route's request body.

export type RealismPreset = "polished" | "natural" | "documentary";
export type AspectRatio = "1:1" | "4:5" | "2:3" | "3:2" | "9:16" | "16:9";

export interface PackDefaults {
  realism: RealismPreset;
  aspectRatio: AspectRatio;
  filmGrain: boolean;
  faceCorrect: boolean;
  superResolution: boolean;
}

export interface PromptPack {
  id: string;
  name: string;
  emoji: string;
  blurb: string;
  /** Images generated per prompt. Total cost = prompts.length * imagesPerPrompt. */
  imagesPerPrompt: number;
  defaults: PackDefaults;
  prompts: string[];
}

export const PROMPT_PACKS: PromptPack[] = [
  {
    id: "professional",
    name: "Professional Headshots",
    emoji: "💼",
    blurb: "LinkedIn-ready studio headshots in business attire.",
    imagesPerPrompt: 1,
    defaults: {
      realism: "polished",
      aspectRatio: "4:5",
      filmGrain: false,
      faceCorrect: true,
      superResolution: false,
    },
    prompts: [
      "Professional LinkedIn headshot, charcoal suit, soft studio lighting, neutral gray backdrop",
      "Corporate headshot, light blue shirt, blurred modern office background, confident smile",
      "Business portrait, black blazer, dramatic side lighting, dark backdrop",
      "Friendly professional headshot, knit sweater, bright window light, plant in background",
      "Executive portrait, navy suit and tie, clean white studio background",
    ],
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    emoji: "🌃",
    blurb: "Neon-soaked futuristic city portraits.",
    imagesPerPrompt: 1,
    defaults: {
      realism: "natural",
      aspectRatio: "2:3",
      filmGrain: true,
      faceCorrect: false,
      superResolution: false,
    },
    prompts: [
      "Cyberpunk portrait, neon pink and blue lighting, rainy futuristic city street, reflective jacket",
      "Futuristic character with subtle tech wear, holographic signage glowing behind, night city",
      "Cinematic cyberpunk close-up, neon reflections on skin, dark alley, volumetric fog",
      "Blade-runner style portrait, trench coat, towering neon billboards, wet pavement",
      "Synthwave portrait, magenta and cyan rim light, retro-futuristic interior",
    ],
  },
  {
    id: "old-money",
    name: "Old Money",
    emoji: "🥂",
    blurb: "Quiet-luxury editorial in timeless settings.",
    imagesPerPrompt: 1,
    defaults: {
      realism: "natural",
      aspectRatio: "4:5",
      filmGrain: true,
      faceCorrect: false,
      superResolution: false,
    },
    prompts: [
      "Old-money portrait, cream cable-knit sweater, sailboat and coastline background, soft daylight",
      "Quiet luxury editorial, tailored beige blazer, marble villa terrace, warm afternoon light",
      "Elegant equestrian style, tweed jacket, country estate, overcast natural light",
      "Timeless portrait, white linen shirt, Mediterranean garden, golden hour",
      "Refined portrait, navy polo, vintage library interior, warm lamplight",
    ],
  },
  {
    id: "dating",
    name: "Dating Profile",
    emoji: "💛",
    blurb: "Warm, approachable shots that get right-swipes.",
    imagesPerPrompt: 1,
    defaults: {
      realism: "natural",
      aspectRatio: "4:5",
      filmGrain: true,
      faceCorrect: false,
      superResolution: false,
    },
    prompts: [
      "Candid portrait laughing in a sunny coffee shop, casual sweater, warm natural light",
      "Relaxed outdoor portrait at a farmers market, denim jacket, golden hour, genuine smile",
      "Cozy at-home portrait reading by a window, soft daylight, warm and inviting",
      "Adventurous portrait on a scenic hiking trail, light jacket, bright daylight",
      "Stylish casual portrait walking a city street, smart-casual outfit, soft evening light",
    ],
  },
  {
    id: "outdoor",
    name: "Outdoor & Adventure",
    emoji: "🏔️",
    blurb: "Epic landscapes and travel-magazine energy.",
    imagesPerPrompt: 1,
    defaults: {
      realism: "documentary",
      aspectRatio: "3:2",
      filmGrain: true,
      faceCorrect: false,
      superResolution: false,
    },
    prompts: [
      "Adventure portrait on a mountain summit, windbreaker, dramatic clouds, crisp daylight",
      "Travel portrait on a coastal cliff, sea breeze, turquoise ocean behind, bright sun",
      "Forest hike portrait, flannel shirt, dappled sunlight through tall pines",
      "Desert portrait at sunset, dust in the air, long shadows, warm rim light",
      "Lakeside portrait at dawn, light fog over the water, calm and cinematic",
    ],
  },
  {
    id: "bw-editorial",
    name: "Black & White Editorial",
    emoji: "🎞️",
    blurb: "High-contrast monochrome studio portraits.",
    imagesPerPrompt: 1,
    defaults: {
      realism: "documentary",
      aspectRatio: "4:5",
      filmGrain: true,
      faceCorrect: false,
      superResolution: false,
    },
    prompts: [
      "Black and white editorial portrait, high contrast, dramatic single-source lighting, dark background",
      "Monochrome close-up, deep shadows, sharp catchlights, fine film grain",
      "Fine-art black and white portrait, soft window light, pensive expression",
      "High-fashion monochrome portrait, strong rim light, textured backdrop",
      "Timeless black and white headshot, classic studio lighting, subtle smile",
    ],
  },
];

export function getPack(id: string): PromptPack | undefined {
  return PROMPT_PACKS.find((p) => p.id === id);
}

export function packImageCount(pack: PromptPack): number {
  return pack.prompts.length * pack.imagesPerPrompt;
}
