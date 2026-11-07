import type { Cat, Meal, Plate, Verdict } from './types.js';

export type ScoreEntry = {
  catId: string;
  flavorId: string;
  date: string;
  score: number;
  weight: number;
  withTopper: boolean;
  vomitFlag: boolean;
};

export type Summary = {
  recent: number | null;
  longRun: number | null;
  recentCount: number;
  toppedShare: number;
};

export const RECENT_WINDOW_DAYS = 21;
const SLIP_MIN_RECENT = 4;
const SLIP_DROP = 0.25;
const VANTA_FLOOR = 0.75;
const PICKED_WEIGHT = 1.5;
const UNPICKED_SCORE = 0.25;
const UNPICKED_WEIGHT = 0.5;
const UNSURE_VOMIT_WEIGHT = 0.3;
const RECALLED_FACTOR = 0.5;

const VERDICT_SCORE: Record<Exclude<Verdict, 'ate_then_vomited'>, number> = {
  clean: 1,
  bites_left: 0.75,
  half: 0.5,
  rejected: 0,
};

export function entriesFromMeal(meal: Meal, cat: Cat): ScoreEntry[] {
  let score: number;
  let weight = 1;
  let vomitFlag = false;
  const isVomit = meal.verdict === 'ate_then_vomited';

  if (isVomit) {
    if (meal.vomitCause === 'hairball') return [];
    score = 0;
    if (meal.vomitCause === 'food') vomitFlag = true;
    else weight = UNSURE_VOMIT_WEIGHT;
  } else {
    score = VERDICT_SCORE[meal.verdict as keyof typeof VERDICT_SCORE];
    if (cat.sideSwingsWet && meal.sideOutcome === 'all') score = Math.max(score, VANTA_FLOOR);
  }

  const factor = (cat.eatsAnythingWeight > 0 ? cat.eatsAnythingWeight : 1) *
    (meal.source === 'recalled' ? RECALLED_FACTOR : 1);
  const picked = meal.choice?.pickedIdx;
  const hasChoice = meal.choice !== null;

  const entries: ScoreEntry[] = [];
  meal.plates.forEach((plate: Plate, idx: number) => {
    const withTopper = plate.toppers.length > 0;
    const isPicked = !hasChoice || idx === picked;
    for (const item of plate.items) {
      entries.push({
        catId: meal.catId,
        flavorId: item.flavorId,
        date: meal.date,
        score: isPicked ? score : UNPICKED_SCORE,
        weight: (isPicked ? weight * (hasChoice ? PICKED_WEIGHT : 1) : UNPICKED_WEIGHT) * factor,
        withTopper,
        vomitFlag: isPicked ? vomitFlag : false,
      });
    }
  });
  return entries;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weightedMean(es: ScoreEntry[]): number | null {
  const total = es.reduce((s, e) => s + e.weight, 0);
  if (es.length === 0 || total <= 0) return null;
  return es.reduce((s, e) => s + e.score * e.weight, 0) / total;
}

export function summarize(entries: ScoreEntry[], asOf: string): Summary {
  const upTo = entries.filter((e) => e.date <= asOf);
  const windowStart = addDays(asOf, -(RECENT_WINDOW_DAYS - 1));
  const recent = upTo.filter((e) => e.date >= windowStart);
  return {
    recent: weightedMean(recent),
    longRun: weightedMean(upTo),
    recentCount: recent.length,
    toppedShare: upTo.length === 0 ? 0 : upTo.filter((e) => e.withTopper).length / upTo.length,
  };
}

export function isSlipping(s: Summary): boolean {
  return (
    s.recentCount >= SLIP_MIN_RECENT &&
    s.longRun !== null &&
    s.recent !== null &&
    s.longRun - s.recent >= SLIP_DROP
  );
}
