import type { ResolvedPris2026Pricing } from "../pris2026/pricing-policy.js";
import { filterTicketCandidatesByPrisDecision } from "../pris2026/pricing-policy.js";
import { ticketAllowsEffectiveIdentity } from "../../utils/ticketEligibility.js";

export function authorizePrimaryTicketCandidates<
  T extends {
    id: number;
    allowedRoles: string | null;
    allowedStudentLevels: string | null;
  },
>(
  tickets: T[],
  identity: { effectiveRole: string; effectiveStudentLevel: string | null },
  pricing: ResolvedPris2026Pricing | null,
): T[] {
  const identityEligible = tickets.filter((ticket) =>
    ticketAllowsEffectiveIdentity(ticket, identity),
  );
  return filterTicketCandidatesByPrisDecision(identityEligible, pricing);
}
