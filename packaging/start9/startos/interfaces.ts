import { sdk } from './sdk'
import { i18n } from './i18n'
import { uiPort } from './utils'

// The dashboard, over http on the LAN and Tor addresses StartOS gives it.
// Devices reach the seeder itself over Hyperswarm, which needs no interface.
export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const uiOrigin = await sdk.MultiHost.of(effects, 'ui').bindPort(uiPort, {
    protocol: 'http',
  })
  const ui = await uiOrigin.export([
    sdk.createInterface(effects, {
      name: i18n('Dashboard'),
      id: 'ui',
      description: i18n('Pair devices and see what the seeder holds'),
      type: 'ui',
      masked: false,
      schemeOverride: null,
      username: null,
      path: '',
      query: {},
    }),
  ])
  return [ui]
})
