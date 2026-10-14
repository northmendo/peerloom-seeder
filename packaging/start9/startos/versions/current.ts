import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

// Matches package.json's version and the image tag in manifest/index.ts; the
// release sets all three (scripts/release/bump.js).
export const current = VersionInfo.of({
  version: '1.0.0:0',
  releaseNotes: {
    en_US: "PeerLoom Seeder is here: one always-on box that keeps all your PeerLoom apps in sync.",
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
