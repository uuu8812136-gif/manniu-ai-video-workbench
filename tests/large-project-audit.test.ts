import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("../src/renderer/src/pages/ProjectDetailPage.tsx", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("../src/renderer/src/components/StoryboardMediaPreview.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/renderer/src/styles.css", import.meta.url), "utf8");
const auditSource = readFileSync(new URL("../scripts/audit-large-project-166.cjs", import.meta.url), "utf8");

describe("large project runtime acceptance contract", () => {
  it("uses project-scoped job lookup and a non-overlapping five-second poll", () => {
    expect(pageSource).toContain("window.offline.jobs.latestForStoryboards");
    expect(pageSource).toContain("job.status === \"running\"");
    expect(pageSource).toContain("window.setTimeout(() => void poll(), 5_000)");
    expect(pageSource).not.toContain("window.setInterval");
  });

  it("keeps the original 316px two-scroll-pane layout and browser rendering containment", () => {
    expect(styles).toMatch(/\.project-detail-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+316px;/su);
    expect(styles).toMatch(/\.project-storyboard-main\s*\{[^}]*overflow:\s*auto;/su);
    expect(styles).toMatch(/\.automation-sidebar\s*\{[^}]*width:\s*316px;[^}]*overflow-y:\s*auto;/su);
    expect(styles).toMatch(/\.storyboard-card-row\s*\{[^}]*content-visibility:\s*auto;/su);
  });

  it("unmounts offscreen media and exposes a reproducible 166-row CDP audit", () => {
    expect(previewSource).toContain("setVisible(entries.some((entry) => entry.isIntersecting))");
    expect(previewSource).toContain("export const StoryboardMediaPreview = memo(");
    expect(auditSource).toContain("const storyboardCount = 166");
    expect(auditSource).toContain('AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK: "1"');
    expect(auditSource).toContain('Page.captureScreenshot');
    expect(auditSource).toContain('realViduTriggered: false');
  });
});
