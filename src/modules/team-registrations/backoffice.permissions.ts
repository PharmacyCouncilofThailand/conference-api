export function canReadTeamRegistration(role: string, assignedEventIds: number[], eventId: number): boolean {
  return role === "admin" || (role === "team_registration_viewer" && assignedEventIds.includes(eventId));
}

export function canWriteTeamRegistration(role: string): boolean {
  return role === "admin";
}
