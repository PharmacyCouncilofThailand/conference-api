import { eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import { staffEventAssignments } from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import { canReadTeamRegistration, canWriteTeamRegistration } from "./backoffice.permissions.js";

export async function requireTeamRegistrationReader(
  user: { id: number; role: string },
  eventId: number,
): Promise<void> {
  if (user.role === "admin") return;
  if (user.role !== "team_registration_viewer") {
    throw new TeamRegistrationError(403, "TEAM_REGISTRATION_FORBIDDEN", "ไม่มีสิทธิ์เข้าถึงข้อมูลทีม");
  }
  const rows = await db.select({ eventId: staffEventAssignments.eventId })
    .from(staffEventAssignments)
    .where(eq(staffEventAssignments.staffId, user.id));
  if (!canReadTeamRegistration(user.role, rows.map((row) => row.eventId), eventId)) {
    throw new TeamRegistrationError(403, "TEAM_REGISTRATION_EVENT_FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง Event นี้");
  }
}

export function requireTeamRegistrationAdmin(user: { id: number; role: string }): void {
  if (!canWriteTeamRegistration(user.role)) {
    throw new TeamRegistrationError(403, "TEAM_REGISTRATION_ADMIN_REQUIRED", "เฉพาะ Admin เท่านั้น");
  }
}
