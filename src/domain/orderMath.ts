export type MixLine = { productId: string; cases: number; caseOz: number; casePrice: number };

export type OrderSummary = {
  totalOz: number;
  daysOfFood: number;
  intervalWeeks: number;
  slackDays: number;
  costPerShipment: number;
  costPerDay: number;
  costPerMonth: number;
  costPerOzByProduct: Record<string, number>;
};

const DAYS_PER_MONTH = 30.4375;

export function summarizeOrder(lines: MixLine[], dailyOz: number, pantryOz = 0): OrderSummary {
  const totalOz = lines.reduce((n, l) => n + l.cases * l.caseOz, 0);
  const costPerShipment = lines.reduce((n, l) => n + l.cases * l.casePrice, 0);
  const daysOfFood = dailyOz > 0 ? (totalOz + pantryOz) / dailyOz : 0;
  // Epsilon guards float error turning an exact N-week supply into N-1 weeks.
  const intervalWeeks = Math.floor(daysOfFood / 7 + 1e-9);
  const slackDays = Math.max(0, daysOfFood - intervalWeeks * 7);
  // Cost per day uses the order alone, not pantry stock.
  const costPerDay = totalOz > 0 && dailyOz > 0 ? costPerShipment / (totalOz / dailyOz) : 0;
  const costPerOzByProduct: Record<string, number> = {};
  for (const l of lines) costPerOzByProduct[l.productId] = l.caseOz > 0 ? l.casePrice / l.caseOz : 0;
  return {
    totalOz,
    daysOfFood,
    intervalWeeks,
    slackDays,
    costPerShipment,
    costPerDay,
    costPerMonth: costPerDay * DAYS_PER_MONTH,
    costPerOzByProduct,
  };
}

export function casesForShare(
  ozPerDay: number,
  intervalDays: number,
  caseOz: number,
  onHandOz: number,
): number {
  if (caseOz <= 0) return 0;
  const needOz = ozPerDay * intervalDays - onHandOz;
  return needOz <= 0 ? 0 : Math.ceil(needOz / caseOz);
}
