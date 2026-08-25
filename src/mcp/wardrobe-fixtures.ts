export const WARDROBE_SOURCE_VERSION = 'wardrobe-fixture@1'

export interface WardrobeItem {
  id: string
  category: 'top' | 'bottom' | 'outerwear' | 'shoes'
  color: string
  warmth: 'light' | 'medium' | 'warm'
  formality: 'casual' | 'smart' | 'formal'
  material: string
  available: boolean
}

export const WARDROBE_ITEMS: Readonly<Record<string, WardrobeItem>> = {
  'w-top-silk-01': {
    id: 'w-top-silk-01', category: 'top', color: 'ivory', warmth: 'light', formality: 'formal', material: 'silk', available: true,
  },
  'w-top-knit-02': {
    id: 'w-top-knit-02', category: 'top', color: 'navy', warmth: 'warm', formality: 'smart', material: 'merino', available: true,
  },
  'w-bottom-trouser-01': {
    id: 'w-bottom-trouser-01', category: 'bottom', color: 'charcoal', warmth: 'medium', formality: 'formal', material: 'wool-blend', available: true,
  },
  'w-bottom-denim-02': {
    id: 'w-bottom-denim-02', category: 'bottom', color: 'indigo', warmth: 'medium', formality: 'casual', material: 'denim', available: true,
  },
  'w-outer-blazer-01': {
    id: 'w-outer-blazer-01', category: 'outerwear', color: 'navy', warmth: 'medium', formality: 'formal', material: 'wool', available: true,
  },
  'w-outer-jacket-02': {
    id: 'w-outer-jacket-02', category: 'outerwear', color: 'olive', warmth: 'light', formality: 'casual', material: 'cotton', available: false,
  },
  'w-shoes-loafer-01': {
    id: 'w-shoes-loafer-01', category: 'shoes', color: 'brown', warmth: 'medium', formality: 'smart', material: 'leather', available: true,
  },
  'w-shoes-sneaker-02': {
    id: 'w-shoes-sneaker-02', category: 'shoes', color: 'white', warmth: 'light', formality: 'casual', material: 'canvas', available: true,
  },
}

export function wardrobeCandidates(occasion: string, climate: string): string[] {
  if (occasion === 'client-meeting') {
    return ['w-top-silk-01', 'w-top-knit-02', 'w-bottom-trouser-01', 'w-outer-blazer-01', 'w-shoes-loafer-01']
  }
  if (occasion === 'family-trip' && climate === 'warm') {
    return ['w-top-silk-01', 'w-bottom-denim-02', 'w-outer-jacket-02', 'w-shoes-sneaker-02']
  }
  return ['w-top-knit-02', 'w-bottom-denim-02', 'w-outer-blazer-01', 'w-shoes-loafer-01', 'w-shoes-sneaker-02']
}
