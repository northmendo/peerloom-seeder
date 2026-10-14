// Set the release version everywhere it is written (scripts/release.sh,
// step 0): package.json and its lockfile, the StartOS image tag and the
// StartOS version graph (the current version moves to versions/v<old>.ts and
// a new current.ts takes the new one). Run again at the same version (a
// --retag), it changes nothing. From PearOffice's scripts/release/bump.js.
//
//   node scripts/release/bump.js <version>
//   node scripts/release/bump.js --notes <notes-file>     (step 5)

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', '..')
const at = (p) => path.join(root, p)
const read = (p) => fs.readFileSync(at(p), 'utf8')
const write = (p, s) => fs.writeFileSync(at(p), s)
const json = (p, fn) => { const o = JSON.parse(read(p)); fn(o); write(p, JSON.stringify(o, null, 2) + '\n') }
const dir = 'packaging/start9/startos/versions'

if (process.argv[2] === '--notes') {
  // The notes as one plain line for StartOS: the first paragraph or bullets,
  // without headings or markdown, at most 500 characters.
  const text = fs.readFileSync(path.resolve(process.argv[3]), 'utf8')
  const lines = text.split('\n').filter((l) => !/^\s*#/.test(l))
  const block = lines.join('\n').trim().split(/\n\s*\n/)[0] || ''
  let notes = block.split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').trim()).filter(Boolean).map((l) => (/[.!?]$/.test(l) ? l : l + '.')).join(' ')
  if (notes.length > 500) notes = notes.slice(0, 500).replace(/\s+\S*$/, '') + '...'
  const file = dir + '/current.ts'
  write(file, read(file).replace(/en_US: .*,\n/, 'en_US: ' + JSON.stringify(notes) + ',\n'))
  console.log('StartOS release notes: ' + notes)
  process.exit(0)
}

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: node scripts/release/bump.js <x.y.z> | --notes <notes-file>')
  process.exit(2)
}

const old = JSON.parse(read('package.json')).version
if (old === version) { console.log('already at ' + version); process.exit(0) }

json('package.json', (o) => { o.version = version })
json('package-lock.json', (o) => { o.version = version; if (o.packages && o.packages['']) o.packages[''].version = version })

const manifest = 'packaging/start9/startos/manifest/index.ts'
write(manifest, read(manifest).replace(/peerloom-seeder:\d+\.\d+\.\d+/, 'peerloom-seeder:' + version))

const oldName = 'v' + old.replace(/\./g, '_')
const current = read(dir + '/current.ts')
write(dir + '/' + oldName + '.ts', current.replace('export const current =', 'export const ' + oldName + ' ='))
write(dir + '/current.ts', `import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

// Matches package.json's version and the image tag in manifest/index.ts; the
// release sets all three (scripts/release/bump.js).
export const current = VersionInfo.of({
  version: '${version}:0',
  releaseNotes: {
    en_US: ${JSON.stringify('PeerLoom Seeder ' + version)},
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
`)
const index = read(dir + '/index.ts')
const others = ((/other:\s*\[([^\]]*)\]/.exec(index) || [])[1] || '').split(',').map((s) => s.trim()).filter(Boolean)
others.unshift(oldName)
write(dir + '/index.ts', `import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
${others.map((n) => `import { ${n} } from './${n}'`).join('\n')}

export const versionGraph = VersionGraph.of({
  current,
  other: [${others.join(', ')}],
})
`)
console.log(`${old} -> ${version} (StartOS ${version}:0)`)
