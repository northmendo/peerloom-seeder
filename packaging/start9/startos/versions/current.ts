import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

// Matches package.json's version and the image tag in manifest/index.ts; the
// release sets all three.
export const current = VersionInfo.of({
  version: '0.1.0:0',
  releaseNotes: {
    en_US: 'First release. Keeps your PeerLoom apps in sync while your phones sleep.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
