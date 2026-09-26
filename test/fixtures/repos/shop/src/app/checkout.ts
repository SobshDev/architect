import chunk from "lodash/chunk";
import { money, placeOrder } from "../domain/index.ts";

export function checkout(id: string) {
  return chunk([placeOrder({ id, total: money(100) })], 1);
}
