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

type DatedOrder = { id: string; date: string; status: 'planned' | 'confirmed-in-chewy' | 'arrived' };

/**
 * Orders that count as the household's autoship baseline (R19): confirmed in Chewy or arrived,
 * never merely planned. Most recent first: by date, then by id (later id wins a tie).
 */
export function baselineOrders<T extends DatedOrder>(orders: T[]): T[] {
  return orders
    .filter((o) => o.status === 'confirmed-in-chewy' || o.status === 'arrived')
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The current order (R19): the most recent confirmed-in-chewy or arrived order. */
export function currentOrderOf<T extends DatedOrder>(orders: T[]): T | null {
  return baselineOrders(orders)[0] ?? null;
}
