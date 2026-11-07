export type Texture =
  | 'pate' | 'minced' | 'shredded' | 'soft_shreds'
  | 'chunks_in_gravy' | 'au_jus' | 'structured' | 'other';
export type FlavorKind = 'wet' | 'topper' | 'kibble';
export type Verdict = 'clean' | 'bites_left' | 'half' | 'rejected' | 'ate_then_vomited';
export type VomitCause = 'food' | 'hairball' | 'unsure';
export type FoodState =
  | 'unproven' | 'in_rotation' | 'slipping' | 'resting' | 'due_for_retry' | 'retired';

export interface PlateItem {
  flavorId: string;
  amountOz: number;
}

export interface Plate {
  items: PlateItem[];
  toppers: PlateItem[];
  side: { flavorId: string; amount: number } | null;
}

export interface Cat {
  id: string;
  name: string;
  age: number | null;
  breed: string | null;
  weight: number | null;
  allergies: {
    substance: string;
    status: 'suspected' | 'trial' | 'confirmed' | 'cleared';
    until: string | null;
  }[];
  textureRules: { allowed: Texture[]; blocked: Texture[] };
  noMixDryIntoWet: boolean;
  sideSwingsWet: boolean;
  fixedPortionOz: number | null;
  eatsAnythingWeight: number;
  dailyOz: number;
  proteinPrefs: string[];
  usualPlate: Plate | null;
}

export interface Product {
  id: string;
  brand: string;
  line: string;
  name: string;
  canOz: number;
  cansPerCase: number;
  isVarietyPack: boolean;
  upc: string | null;
  store: string | null;
  prices: { casePrice: number; seenOn: string; source: string }[];
  status: 'active' | 'retired';
}

export interface Flavor {
  id: string;
  productId: string;
  name: string;
  primaryProtein: string;
  texture: Texture;
  /** Ingredient groups present (lowercase); null = ingredients not yet checked. */
  contains: string[] | null;
  ingredientsText: string | null;
  cansPerCase: number;
  kind: FlavorKind;
  unit: 'can' | 'tube' | 'cup';
  canOz: number;
}

export interface Alias {
  text: string;
  flavorId: string | null;
  productId: string | null;
}

export interface Meal {
  id: string;
  catId: string;
  date: string; // YYYY-MM-DD
  slot: 'AM' | 'PM';
  plates: Plate[];
  choice: { pickedIdx: number } | null;
  verdict: Verdict;
  vomitCause: VomitCause | null;
  sideOutcome: 'all' | 'some' | 'none' | null;
  isTaster: boolean;
  source: 'observed' | 'recalled';
  note: string | null;
  loggedAt: string;
}

export interface HouseholdRule {
  id: string;
  kind: 'exclude-ingredient';
  value: string;
  startsOn: string;
  endsOn: string | null;
  outcome: 'lifted' | 'confirmed' | 'extended' | null;
}

export interface PantryEvent {
  id: string;
  flavorId: string;
  deltaCans: number;
  reason: 'shipment' | 'meal' | 'count-correction' | 'waste';
  at: string;
  refId: string | null;
}

export interface OrderLine {
  productId: string;
  qtyCases: number;
  casePrice: number | null;
}

export interface Order {
  id: string;
  chewyOrderNo: string | null;
  date: string;
  lines: OrderLine[];
  total: number | null;
  intervalWeeks: number | null;
  status: 'planned' | 'confirmed-in-chewy' | 'arrived';
}
