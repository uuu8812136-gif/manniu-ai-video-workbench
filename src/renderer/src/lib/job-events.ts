import type { WorkflowJobEvent } from "../../../shared/contracts";

export function issueEvents(events: WorkflowJobEvent[]): WorkflowJobEvent[] {
  return events.filter((event) => event.level === "warning" || event.level === "error");
}

export function eventDetailText(detail: unknown): string | null {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}
