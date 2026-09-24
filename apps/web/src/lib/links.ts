// The repository may be renamed. Change it here and every link follows.
export const REPO_URL = 'https://github.com/Muse-Nexus/witness';

export const repoDoc = (path: string) => `${REPO_URL}/blob/main/${path}`;
export const repoTree = (path: string) => `${REPO_URL}/tree/main/${path}`;

export const LINKS = {
  repo: REPO_URL,
  safetyDoc: repoDoc('docs/SAFETY.md'),
  privacyDoc: repoDoc('docs/PRIVACY.md'),
  selfHost: repoDoc('docs/SELF_HOSTING.md'),
  macSource: repoTree('apps/mac'),
  iphoneGuide: repoDoc('docs/guides/iphone.md'),
  license: repoDoc('LICENSE'),
  studio: 'https://musenexus.studio',
  crisisUS: 'https://988lifeline.org',
  crisisWorld: 'https://findahelpline.com',
} as const;
