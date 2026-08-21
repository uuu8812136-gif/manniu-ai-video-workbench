import { load } from "cheerio";

export type QqNovelSource = {
  url: string;
  title: string;
  text: string;
};

const MAX_HTML_BYTES = 12 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["book.qq.com", "reader.qq.com"]);

function validatedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("QQ 阅读链接格式不正确");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("目前只支持 book.qq.com 或 reader.qq.com 链接");
  }
  return url;
}

function normalizedText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function jsonArticleBody(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonArticleBody);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = [record.articleBody, record.text, record.content]
    .filter((item): item is string => typeof item === "string" && item.trim().length >= 80);
  return [...direct, ...Object.values(record).flatMap(jsonArticleBody)];
}

export function parseQqNovelHtml(url: string, html: string): QqNovelSource {
  const canonicalUrl = validatedUrl(url).toString();
  const $ = load(html);
  $("script,style,noscript,svg").not('script[type="application/ld+json"]').remove();

  const titleCandidates = [
    $('meta[property="og:title"]').attr("content"),
    $('meta[name="twitter:title"]').attr("content"),
    $("h1").first().text(),
    $("title").text().replace(/[-_|].*?(?:QQ阅读|腾讯文学).*$/i, ""),
  ].map((item) => normalizedText(item ?? "")).filter(Boolean);

  const bodyCandidates: string[] = [];
  const selectors = [
    "article",
    "[class*=chapter-content]",
    "[class*=chapterContent]",
    "[class*=read-content]",
    "[class*=reader-content]",
    "[id*=chapterContent]",
    "main",
  ];
  for (const selector of selectors) {
    $(selector).each((_index, element) => {
      const text = normalizedText($(element).text());
      if (text.length >= 80) bodyCandidates.push(text);
    });
  }
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      bodyCandidates.push(...jsonArticleBody(JSON.parse($(element).text())).map(normalizedText));
    } catch {
      // Invalid third-party JSON-LD is ignored in favor of visible article text.
    }
  });

  const text = bodyCandidates.sort((left, right) => right.length - left.length)[0] ?? "";
  if (text.length < 80) throw new Error("页面未返回可读取的正文，可能需要先在浏览器打开具体章节或手动导入 TXT/DOCX");
  return {
    url: canonicalUrl,
    title: titleCandidates[0] || "QQ阅读文案",
    text,
  };
}

export async function fetchQqNovel(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<QqNovelSource> {
  const url = validatedUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("QQ 阅读页面请求超时")), 30_000);
  try {
    const response = await fetcher(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`QQ 阅读页面请求失败：HTTP ${response.status}`);
    validatedUrl(response.url || url.toString());
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_HTML_BYTES) throw new Error("QQ 阅读页面超过 12 MB，已停止读取");
    return parseQqNovelHtml(response.url || url.toString(), new TextDecoder("utf-8").decode(buffer));
  } finally {
    clearTimeout(timer);
  }
}
