// The seeder as its own Bare process, for the dashboard host. Talks newline
// JSON over stdio to src/bare.js --ipc. From pearoffice/desktop/seeder-process.js,
// plus `bootstrap` for tests.

const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

class SeederProcess extends EventEmitter {
  constructor ({ barePath, bundlePath, dataDir, bootstrap = null, onLog }) {
    super()
    this._args = [bundlePath, '--data', dataDir, '--ipc']
    if (bootstrap) this._args.push('--bootstrap', bootstrap.map((b) => b.host + ':' + b.port).join(','))
    this._barePath = barePath
    this._onLog = onLog || (() => {})
    this._proc = null
    this._buf = ''
    this._next = 1
    this._pending = new Map()
    this.seederKey = null
  }

  start () {
    if (this._proc) return this._ready
    this._proc = spawn(this._barePath, this._args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this._ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('seeder did not start')), 60000)
      this.once('ready', (d) => { clearTimeout(t); this.seederKey = d.seederKey; resolve(d) })
      this._proc.once('exit', (code) => { clearTimeout(t); reject(new Error('seeder exited (' + code + ')')) })
    })
    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk))
    this._proc.stderr.on('data', (chunk) => this._onLog('seeder', chunk.toString().trimEnd()))
    this._proc.on('exit', (code) => {
      for (const p of this._pending.values()) p.reject(new Error('seeder stopped'))
      this._pending.clear()
      this._proc = null
      this.emit('exit', code)
    })
    return this._ready
  }

  get running () { return !!this._proc }

  call (method, args = {}) {
    if (!this._proc) return Promise.reject(new Error('seeder not running'))
    const id = this._next++
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._proc.stdin.write(JSON.stringify({ id, method, args }) + '\n')
    })
  }

  _onStdout (chunk) {
    this._buf += chunk.toString('utf8')
    let nl
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl)
      this._buf = this._buf.slice(nl + 1)
      let msg
      try { msg = JSON.parse(line) } catch { this._onLog('seeder', line); continue }
      if (msg.event === 'log') { this._onLog('seeder', msg.data); continue }
      if (msg.event) { this.emit(msg.event, msg.data); continue }
      const p = this._pending.get(msg.id)
      if (!p) continue
      this._pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result)
    }
  }

  // Closing stdin asks the seeder to close its stores and exit.
  async stop () {
    const p = this._proc
    if (!p) return
    p.stdin.end()
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} resolve() }, 5000)
      p.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
}

module.exports = { SeederProcess }
