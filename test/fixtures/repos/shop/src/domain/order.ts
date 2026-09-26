import { saveOrder } from "../infra/db.ts";
import type { Money } from "./money.ts";

export interface Order {
  id: string;
  total: Money;
}

export function placeOrder(order: Order): Order {
  saveOrder(order);
  return order;
}
