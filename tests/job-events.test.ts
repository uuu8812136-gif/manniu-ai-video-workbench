import { describe, expect, it } from "vitest";
import type { WorkflowJobEvent } from "../src/shared/contracts";
import { eventDetailText, issueEvents } from "../src/renderer/src/lib/job-events";

function event(id: number, level: WorkflowJobEvent["level"]): WorkflowJobEvent {
  return {
    id,
    jobId: "00000000-0000-4000-8000-000000000001",
    level,
    message: `event-${id}`,
    detail: null,
    createdAt: "2026-07-26T02:00:00.000Z",
  };
}

describe("batch job issue details", () => {
  it("keeps warning and error events in their original order", () => {
    expect(issueEvents([
      event(1, "info"),
      event(2, "warning"),
      event(3, "debug"),
      event(4, "error"),
    ]).map(({ id }) => id)).toEqual([2, 4]);
  });

  it("formats structured event detail for display", () => {
    expect(eventDetailText({ kind: "authentication", status: 401 })).toContain('"status": 401');
    expect(eventDetailText(null)).toBeNull();
  });
});
