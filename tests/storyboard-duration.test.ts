import { describe, expect, it } from "vitest";
import { originalStoryboardDuration } from "../src/shared/storyboard-duration";

describe("original storyboard duration", () => {
  it("uses the original two-to-five second Chinese character formula", () => {
    expect(originalStoryboardDuration("字".repeat(6))).toBe(2);
    expect(originalStoryboardDuration("字".repeat(15))).toBe(3);
    expect(originalStoryboardDuration("字".repeat(21))).toBe(4);
    expect(originalStoryboardDuration("字".repeat(27))).toBe(5);
  });
});
