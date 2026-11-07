import type { Cat, Flavor, HouseholdRule, Plate } from './types.js';

export type Violation = {
  rule: 'fish_trial' | 'texture' | 'dry_mix';
  catId?: string;
  flavorId?: string;
  message: string;
  certainty: 'known' | 'unknown';
};

/** Rules in force on `onDate` (YYYY-MM-DD; inclusive at both ends, null endsOn = open-ended). */
export function activeRules(rules: HouseholdRule[], onDate: string): HouseholdRule[] {
  return rules.filter((r) => r.startsOn <= onDate && (r.endsOn === null || onDate <= r.endsOn));
}

export function checkFlavorForCat(f: Flavor, cat: Cat, rules: HouseholdRule[], onDate: string): Violation[] {
  const out: Violation[] = [];
  for (const r of activeRules(rules, onDate)) {
    if (r.kind === 'exclude-ingredient' && r.value === 'fish' && f.containsFish !== false) {
      const until = r.endsOn ? ` until ${r.endsOn}` : '';
      out.push(
        f.containsFish === true
          ? { rule: 'fish_trial', catId: cat.id, flavorId: f.id, certainty: 'known',
              message: `Contains fish; the fish trial is active${until}.` }
          : { rule: 'fish_trial', catId: cat.id, flavorId: f.id, certainty: 'unknown',
              message: `Fish content unknown; the fish trial is active${until}.` },
      );
    }
  }
  if (f.kind !== 'kibble' && cat.textureRules.blocked.includes(f.texture)) {
    out.push({ rule: 'texture', catId: cat.id, flavorId: f.id, certainty: 'known',
      message: `${cat.name} cannot have ${f.texture.replace(/_/g, ' ')} texture.` });
  }
  return out;
}

export function checkPlate(
  plate: Plate, cat: Cat, flavors: Map<string, Flavor>, rules: HouseholdRule[], onDate: string,
): Violation[] {
  const ids = [...plate.items, ...plate.toppers].map((i) => i.flavorId);
  if (plate.side) ids.push(plate.side.flavorId);
  const out: Violation[] = [];
  for (const id of ids) {
    const f = flavors.get(id);
    if (!f) continue;
    out.push(...checkFlavorForCat(f, cat, rules, onDate));
    if (cat.noMixDryIntoWet && f.kind === 'kibble') {
      out.push({ rule: 'dry_mix', catId: cat.id, flavorId: f.id, certainty: 'known',
        message: `${cat.name} gets no dry food mixed into wet.` });
    }
  }
  return out;
}

/** True only when there are no violations, including unknown ones. */
export function servableFor(f: Flavor, cat: Cat, rules: HouseholdRule[], onDate: string): boolean {
  return checkFlavorForCat(f, cat, rules, onDate).length === 0;
}
