import type { Order } from "../domain/order.ts";

const rows: Order[] = [];

export function saveOrder(order: Order): void {
  rows.push(order);
}
