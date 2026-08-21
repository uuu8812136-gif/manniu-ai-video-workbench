import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "styles.css"),
  "utf8",
);

function blockContents(header: string, fromEnd = false): string {
  const headerIndex = fromEnd ? styles.lastIndexOf(header) : styles.indexOf(header);
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  const openIndex = styles.indexOf("{", headerIndex + header.length);
  expect(openIndex).toBeGreaterThan(headerIndex);
  let depth = 0;
  for (let index = openIndex; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") depth -= 1;
    if (depth === 0) return styles.slice(openIndex + 1, index);
  }
  throw new Error(`CSS block is not closed: ${header}`);
}

describe("responsive CSS contract", () => {
  it("releases the desktop minimum width before narrow tablet layouts", () => {
    expect(blockContents("body")).toMatch(/min-width:\s*1080px;/u);
    expect(blockContents("@media (max-width: 1079px)")).toMatch(
      /body\s*\{\s*min-width:\s*0;\s*min-height:\s*0;/u,
    );
  });

  it("stacks the inference workbench and constrains task content on mobile", () => {
    const narrowInferenceIndex = styles.lastIndexOf("@media (max-width: 1180px)");
    const mobileIndex = styles.lastIndexOf("@media (max-width: 700px)");
    expect(mobileIndex).toBeGreaterThan(narrowInferenceIndex);
    const mobile = blockContents("@media (max-width: 700px)", true);
    expect(mobile).toMatch(
      /\.inference-workbench-body\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*min-height:\s*0;/u,
    );
    expect(mobile).toMatch(
      /\.inference-control-panel,\s*\.inference-task-list,\s*\.inference-task-card\s*\{\s*width:\s*100%;\s*max-width:\s*100%;\s*min-width:\s*0;/u,
    );
  });
});
