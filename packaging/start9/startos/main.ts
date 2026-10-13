import { i18n } from './i18n'
import { sdk } from './sdk'
import { uiPort } from './utils'

// The seeder and its dashboard (host/server.js). The dashboard asks for a password, made on first start and
// saved in the data volume (the "Show password" action reads it). Update
// checks are off: StartOS updates the package.
export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting PeerLoom Seeder'))
  return sdk.Daemons.of(effects).addDaemon('seeder', {
    subcontainer: sdk.SubContainer.of(
      effects,
      { imageId: 'seeder' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      }),
      'seeder',
    ),
    exec: {
      command: ['node', '/app/host/server.js'],
      env: {
        SEEDER_HOST: '0.0.0.0',
        SEEDER_PORT: String(uiPort),
        SEEDER_DATA: '/data',
        SEEDER_NO_UPDATE_CHECK: '1',
      },
      runAsInit: true,
    },
    ready: {
      display: i18n('Dashboard'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, uiPort, {
          successMessage: i18n('The dashboard is ready'),
          errorMessage: i18n('The dashboard is not ready'),
        }),
    },
    requires: [],
  })
})
