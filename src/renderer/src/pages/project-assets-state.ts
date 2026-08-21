import type { CharacterProfile, Storyboard } from "../../../shared/contracts";
import { extractAssetNames, mergeAssetNames } from "../../../shared/asset-names";

export function pendingProjectAssetNames(
  storyboards: readonly Pick<Storyboard, "subjects" | "prompt">[],
  profiles: readonly Pick<CharacterProfile, "name" | "aliases">[],
): string[] {
  const profiledNames = new Set(
    profiles
      .flatMap((profile) => [profile.name, ...profile.aliases])
      .map((name) => name.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const referencedNames = storyboards.flatMap((storyboard) =>
    mergeAssetNames(storyboard.subjects, extractAssetNames(storyboard.prompt)),
  );
  return mergeAssetNames(referencedNames)
    .filter((name) => !profiledNames.has(name.toLocaleLowerCase()));
}
