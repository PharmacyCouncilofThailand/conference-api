import { TeamRegistrationError } from "./errors.js";

export interface PriceEntry {
  categoryId: number;
  amount: string;
  currency: "THB";
}

export interface PricingRoundWithPrices {
  id: number;
  code: string;
  displayName: string;
  startsAt: Date;
  endsAt: Date;
  prices: PriceEntry[];
}

export interface SelectedPrice extends PriceEntry {
  pricingRoundId: number;
  pricingRoundCode: string;
  pricingRoundName: string;
}

export function selectPriceForTime(
  rounds: PricingRoundWithPrices[],
  categoryId: number,
  now: Date,
): SelectedPrice {
  const activeRounds = rounds.filter(
    (round) => round.startsAt.getTime() <= now.getTime() && round.endsAt.getTime() > now.getTime(),
  );

  if (activeRounds.length !== 1) {
    throw new TeamRegistrationError(
      activeRounds.length === 0 ? 409 : 500,
      activeRounds.length === 0 ? "REGISTRATION_ROUND_CLOSED" : "PRICING_CONFIGURATION_INVALID",
      activeRounds.length === 0 ? "ขณะนี้ไม่อยู่ในรอบที่เปิดรับชำระเงิน" : "พบช่วงราคาซ้อนกัน",
    );
  }

  const round = activeRounds[0];
  const price = round.prices.find((entry) => entry.categoryId === categoryId);
  if (!price) {
    throw new TeamRegistrationError(500, "PRICING_CONFIGURATION_INVALID", "ไม่พบราคาสำหรับประเภททีมนี้");
  }

  return {
    ...price,
    pricingRoundId: round.id,
    pricingRoundCode: round.code,
    pricingRoundName: round.displayName,
  };
}
