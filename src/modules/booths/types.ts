export type BoothType = "symposium" | "premium" | "standard";
export interface BoothSummary {
  id: number;
  eventId: number;
  name: string;
  type: BoothType;
  quota: number;
  typeLockedAt: string | null;
  memberCount: number;
  ticketCount: number;
  qualifiedCount: number;
  eligibleCount: number;
}
export interface BoothMembership {
  id: number;
  userId: number;
  eventId: number;
  booth: { id: number; eventId: number; name: string; type: BoothType };
  joinedAt: string;
  firstTicketConfirmedAt: string | null;
  qualifyingRegistrationId: number | null;
  qualifiedAt: string | null;
  qualificationSequence: number | null;
  mealCouponEligible: boolean | null;
}
export interface AttendanceColumn {
  key: string;
  date: string;
  sessionId: number;
  sessionName: string;
}
export type DailyAttendanceValue =
  "checked_in" | "not_checked_in" | "no_ticket" | "no_access";
export interface BoothMemberRow extends BoothMembership {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  attendanceByDate: Record<string, DailyAttendanceValue>;
}
export interface BoothMemberReport {
  booth: BoothSummary;
  event: { id: number; eventCode: string; eventName: string };
  generatedAt: string;
  columns: AttendanceColumn[];
  members: BoothMemberRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null;
}
