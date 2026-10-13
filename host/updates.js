// "A new version is out" and "Update now" for the dashboard, through
// @peerloom/host's update-check and update-apply (vendored).
//
// The check runs everywhere except in a container (Umbrel and Start9 update
// the image) or with SEEDER_NO_UPDATE_CHECK set. Updating from the dashboard
// works where the package can install itself:
//
// - Windows: the verified installer runs silently; it stops the service,
//   replaces the files and starts it again.
// - macOS: the verified .pkg goes to a root helper the package installed
//   (packaging/macos/updater-helper.sh), which checks it again and installs it.
// - Linux: the launcher updates (`peerloom-seeder update`), so the dashboard
//   says to run that.
//
// SEEDER_UPDATE_LATEST_URL points the check at another release list (tests);
// SEEDER_UPDATE_DELAY is the first check's delay in seconds (default 60).

const fs = require('node:fs')
const { createUpdateChecker } = require('./vendor/peerloom-host/update-check')
const { UpdateApplier } = require('./vendor/peerloom-host/update-apply')

const PKG_REQUESTS = '/Library/Application Support/PeerLoom Seeder/updates/requests'

const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
const aiArch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]

const CONFIG = {
  name: 'PeerLoom Seeder',
  slug: 'peerloom-seeder',
  repo: 'peerloomllc/peerloom-seeder',
  envPrefix: 'SEEDER',
  assets: {
    win32: /^PeerLoomSeeder-Setup-\d[\w.-]*\.exe$/i,
    darwinArm64: /^PeerLoomSeeder-\d[\w.-]*-arm64\.pkg$/i,
    darwinX64: /^PeerLoomSeeder-\d[\w.-]*-x64\.pkg$/i,
    appImage: (name) => name.startsWith('PeerLoomSeeder-') && name.endsWith('-' + aiArch + '.AppImage'),
    deb: (name) => name.startsWith('peerloom-seeder_') && name.endsWith('_' + debArch + '.deb')
  },
  mac: { teamId: 'G79ALD29NA', pkgRequestDir: PKG_REQUESTS },
  linux: { unit: null, debHelper: null },
  windows: { service: 'PeerLoomSeeder', installerArgs: ['/S'] }
}

// Can this install update itself from the dashboard?
function canApply ({ platform = process.platform, packaged }) {
  if (!packaged) return false
  if (platform === 'win32') return true
  if (platform === 'darwin') return fs.existsSync(PKG_REQUESTS)
  return false
}

function createUpdates ({ version, packaged, log = () => {}, env = process.env, config = CONFIG }) {
  const firstDelayMs = Number(env.SEEDER_UPDATE_DELAY ?? 60) * 1000
  const { checker, reason } = createUpdateChecker({ config, currentVersion: version, env, firstDelayMs, log: (what, data) => log(what + ' ' + JSON.stringify(data)) })
  if (!checker) log('update check off (' + reason + ')')
  const applier = new UpdateApplier({ config, getUpdate: () => checker && checker.get(), log: (what, data) => log(what + ' ' + JSON.stringify(data)) })
  const apply = canApply({ packaged })

  return {
    state () {
      const c = checker ? checker.get() : { available: false, current: version, off: reason }
      const { assets, ...check } = c
      return { ...check, canApply: apply, how: apply ? null : process.platform === 'linux' && packaged ? 'peerloom-seeder update' : null, apply: applier.getState() }
    },
    // Starts the apply and answers at once: on Windows the installer stops this
    // process before a long request would return.
    start () {
      if (!apply) throw new Error('This install cannot update itself from the dashboard')
      applier.apply().catch((e) => log('update failed: ' + e.message))
      return { started: true }
    },
    stop () { if (checker) checker.stop() }
  }
}

module.exports = { createUpdates, CONFIG, PKG_REQUESTS }
