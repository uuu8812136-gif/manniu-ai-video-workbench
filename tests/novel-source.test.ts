import { describe, expect, it } from "vitest";
import { fetchQqNovel, parseQqNovelHtml } from "../src/main/novel-source";

describe("QQ novel source", () => {
  it("extracts a structured title and the longest chapter body", () => {
    const parsed = parseQqNovelHtml("https://book.qq.com/book-detail/123", `
      <html><head><meta property="og:title" content="测试小说"></head>
      <body><main><article><p>${"这是章节正文。".repeat(30)}</p></article></main></body></html>
    `);
    expect(parsed.title).toBe("测试小说");
    expect(parsed.text).toContain("这是章节正文");
  });

  it("rejects non-QQ hosts before sending a request", async () => {
    let called = false;
    await expect(fetchQqNovel("https://example.com/book", async () => {
      called = true;
      throw new Error("should not run");
    })).rejects.toThrow(/只支持/);
    expect(called).toBe(false);
  });

  it("rejects redirects that leave the QQ reading hosts", async () => {
    await expect(fetchQqNovel("https://book.qq.com/book-detail/123", async () => new Response("ok", {
      status: 200,
    }) as Response)).rejects.toThrow();
  });
});
