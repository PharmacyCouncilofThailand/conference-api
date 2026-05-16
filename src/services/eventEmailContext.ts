import { eq } from "drizzle-orm";
import { db } from "../database/index.js";
import { events } from "../database/schema.js";
import {
  buildEventEmailContext,
  getDefaultEventEmailContext,
  type EventEmailContext,
  type EventEmailRow,
} from "./emailTemplates.types.js";

export class EventEmailContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventEmailContextError";
  }
}

export async function resolveEventEmailContext(
  eventId: number | null | undefined,
  options: { requireEvent?: boolean } = {},
): Promise<EventEmailContext> {
  if (!eventId) {
    if (options.requireEvent) {
      throw new EventEmailContextError("eventId is required");
    }
    return getDefaultEventEmailContext();
  }

  const [row] = await db
    .select({
      eventName: events.eventName,
      startDate: events.startDate,
      endDate: events.endDate,
      location: events.location,
      websiteUrl: events.websiteUrl,
      shortName: events.shortName,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!row) {
    if (options.requireEvent) {
      throw new EventEmailContextError(`Event #${eventId} not found`);
    }
    return getDefaultEventEmailContext();
  }

  return buildEventEmailContext(row as EventEmailRow);
}

