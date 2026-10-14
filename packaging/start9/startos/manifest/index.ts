import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

// PeerLoom Seeder for StartOS 0.4 (proposals/2026-10-12-peerloom-seeder-product.md,
// phase 4; from PearOffice's start9/seeder). It runs the same image as the
// Umbrel app (scripts/build-umbrel-image.sh).
export const manifest = setupManifest({
  id: 'peerloom-seeder',
  title: 'PeerLoom Seeder',
  license: 'MIT',
  packageRepo: 'https://github.com/peerloomllc/peerloom-seeder',
  upstreamRepo: 'https://github.com/peerloomllc/peerloom-seeder',
  marketingUrl: 'https://peerloomllc.com',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    seeder: {
      source: { dockerTag: 'ghcr.io/peerloomllc/peerloom-seeder:1.0.0' },
      arch: ['x86_64'],
    },
  },
  dependencies: {},
})
