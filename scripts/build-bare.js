// Bundle the seeder (src/bare.js) for one platform with bare-pack, next to
// the Bare runtime for that platform:
//
//   dist/<platform>-<arch>/bare             the runtime (bare.exe on Windows)
//   dist/<platform>-<arch>/seeder.bundle    the seeder
//   dist/<platform>-<arch>/...              its native addons
//
// Run with: dist/linux-x64/bare dist/linux-x64/seeder.bundle --data <folder>
//
// Usage: node scripts/build-bare.js [platform-arch]   (default this machine)
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')

function build (target = process.platform + '-' + process.arch) {
  const out = path.join(root, 'dist', target)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })

  const runtimeVersion = require(path.join(root, 'node_modules', 'bare-runtime', 'package.json')).version
  const runtimeDir = path.join(root, 'node_modules', 'bare-runtime-' + target)
  if (!fs.existsSync(runtimeDir)) execFileSync('npm', ['install', '--no-save', '--force', 'bare-runtime-' + target + '@' + runtimeVersion], { cwd: root, stdio: 'inherit' })
  const exe = target.startsWith('win32') ? 'bare.exe' : 'bare'
  fs.copyFileSync(path.join(runtimeDir, 'bin', exe), path.join(out, exe))
  fs.chmodSync(path.join(out, exe), 0o755)

  execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'bare-pack', 'bin.js'),
    '--host', target,
    '--offload-addons',
    '-o', path.join(out, 'seeder.bundle'),
    path.join(root, 'src', 'bare.js')
  ], { cwd: root, stdio: 'inherit' })
  return { dir: out, bare: path.join(out, exe), bundle: path.join(out, 'seeder.bundle') }
}

if (require.main === module) console.log('built ' + path.relative(root, build(process.argv[2]).dir))

module.exports = { build }
