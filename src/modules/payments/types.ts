import { db } from "../../database/index.js";

export type PaymentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PaymentProvider = "stripe" | "pay_solutions" | "ktb_fastpay" | "internal";

export interface PaymentLogger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
}
