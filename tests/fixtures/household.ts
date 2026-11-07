import type { Cat, Flavor, HouseholdRule } from '../../src/domain/types.js';

function cat(over: Partial<Cat> & Pick<Cat, 'id' | 'name' | 'proteinPrefs'>): Cat {
  return {
    age: null,
    breed: null,
    weight: null,
    allergies: [],
    textureRules: { allowed: [], blocked: [] },
    noMixDryIntoWet: false,
    sideSwingsWet: false,
    fixedPortionOz: null,
    eatsAnythingWeight: 0,
    dailyOz: 6.5,
    usualPlate: null,
    ...over,
  };
}

export const vanta = cat({ id: 'vanta', name: 'Vanta', proteinPrefs: ['chicken'], sideSwingsWet: true });
export const sinbad = cat({
  id: 'sinbad',
  name: 'Sinbad',
  proteinPrefs: ['fish', 'chicken', 'duck', 'turkey', 'lamb', 'beef'],
  eatsAnythingWeight: 0.5,
  allergies: [{ substance: 'fish', status: 'suspected', until: null }],
});
export const lordBuggins = cat({
  id: 'lord-buggins',
  name: 'Lord Buggins',
  proteinPrefs: ['chicken', 'duck', 'lamb', 'salmon', 'fish'],
});
export const pixel = cat({
  id: 'pixel',
  name: 'Pixel',
  proteinPrefs: [],
  textureRules: { allowed: ['pate', 'soft_shreds'], blocked: ['chunks_in_gravy', 'structured'] },
  noMixDryIntoWet: true,
  fixedPortionOz: 6.5,
});
export const pharaoh = cat({
  id: 'pharaoh',
  name: 'Pharaoh',
  proteinPrefs: ['chicken', 'duck', 'lamb', 'turkey', 'beef'],
});
export const cats: Cat[] = [vanta, sinbad, lordBuggins, pixel, pharaoh];

function flavor(over: Partial<Flavor> & Pick<Flavor, 'id' | 'name' | 'primaryProtein'>): Flavor {
  return {
    productId: `p-${over.id}`,
    texture: 'pate',
    containsFish: false,
    ingredientsText: null,
    cansPerCase: 12,
    kind: 'wet',
    unit: 'can',
    canOz: 3,
    ...over,
  };
}

export const salmonPate = flavor({ id: 'salmon-pate', name: 'Salmon Pate', primaryProtein: 'salmon', containsFish: true });
export const chickenPate = flavor({ id: 'chicken-pate', name: 'Chicken Pate', primaryProtein: 'chicken' });
export const chunksInGravy = flavor({
  id: 'chunks-in-gravy',
  name: 'Chicken Chunks in Gravy',
  primaryProtein: 'chicken',
  texture: 'chunks_in_gravy',
});
export const kibble = flavor({
  id: 'kibble',
  name: 'Dry Kibble',
  primaryProtein: 'chicken',
  texture: 'other',
  kind: 'kibble',
  unit: 'cup',
  canOz: 0,
});
export const purrlySalmonChicken = flavor({
  id: 'purrly-salmon-chicken',
  name: 'Purrly salmon & chicken',
  primaryProtein: 'chicken',
  texture: 'other',
  containsFish: true,
  kind: 'topper',
  unit: 'tube',
  canOz: 0.5,
});
export const funkInTheTrunk = flavor({
  id: 'funk-in-the-trunk',
  name: 'Funk in the Trunk',
  primaryProtein: 'chicken',
  texture: 'minced',
});

export const flavors: Map<string, Flavor> = new Map(
  [salmonPate, chickenPate, chunksInGravy, kibble, purrlySalmonChicken, funkInTheTrunk].map((f) => [f.id, f]),
);

export const fishTrial: HouseholdRule = {
  id: 'r1',
  kind: 'exclude-ingredient',
  value: 'fish',
  startsOn: '2026-11-01',
  endsOn: '2026-12-13',
  outcome: null,
};
