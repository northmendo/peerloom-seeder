// From pearoffice/scripts/serve-local-release.js.
// A stand-in for GitHub's "latest release" API, for testing updates without
// publishing anything. Serves every file in a folder as a release asset.
//
//   node scripts/serve-local-release.js <version> <folder> [port]
//
// then point the app at it:
//   SEEDER_UPDATE_LATEST_URL=http://127.0.0.1:<port>/latest
const fs = require('fs')
const http = require('http')
const path = require('path')

function serveRelease ({ version, dir, port = 0, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const base = 'http://' + host + ':' + server.address().port
    const url = decodeURIComponent(req.url.split('?')[0])
    if (url === '/latest') {
      const assets = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
        .map((name) => ({ name, browser_download_url: base + '/files/' + encodeURIComponent(name) }))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ tag_name: 'v' + version, name: 'PeerLoom Seeder ' + version, draft: false, prerelease: false, html_url: base + '/release', published_at: new Date().toISOString(), assets }, null, 2))
    }
    const m = url.match(/^\/files\/([^/]+)$/)
    if (m && fs.existsSync(path.join(dir, m[1]))) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return fs.createReadStream(path.join(dir, m[1])).pipe(res)
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}

if (require.main === module) {
  const [version, dir, port] = process.argv.slice(2)
  if (!version || !dir) { console.error('usage: node scripts/serve-local-release.js <version> <folder> [port]'); process.exit(1) }
  serveRelease({ version, dir: path.resolve(dir), port: Number(port || 0) }).then((s) => console.log('release ' + version + ' at http://127.0.0.1:' + s.address().port + '/latest'))
}

module.exports = { serveRelease }
