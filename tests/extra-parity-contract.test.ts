import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "src", "renderer", "src", "pages", "ImagePage.tsx"), "utf8");

describe("extra original UI parity", () => {
  it("provides the original image prompt edit-save-cancel and resend flow", () => {
    expect(page).toContain("beginPromptEdit(result)");
    expect(page).toContain("savePromptEdit(result)");
    expect(page).toContain("提示词不能为空");
    expect(page).toContain("<Pencil size={15} /> 编辑");
    expect(page).toContain("setEditingPrompt(null)}>取消");
    expect(page).toContain("onClick={() => void regenerate(result)}");
    expect(page).toContain("重发</button>");
  });
});
