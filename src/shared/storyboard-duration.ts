export function originalStoryboardDuration(text: string): number {
  const chineseCharacters = Array.from(text.matchAll(/[\u4e00-\u9fff]/gu)).length;
  return Math.min(5, Math.max(2, Math.floor((chineseCharacters + 3) / 6)));
}
