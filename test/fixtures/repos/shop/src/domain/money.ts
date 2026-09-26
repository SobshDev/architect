export interface Money {
  cents: number;
  currency: string;
}

export function money(cents: number, currency = "EUR"): Money {
  return { cents, currency };
}
