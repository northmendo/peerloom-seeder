// Copied from pearoffice/src/shared/qr.js on 2026-10-12.
// QR codes for pairing links: as SVG for the UI, as text for a terminal.
const qrcode = require('qrcode-generator')

function matrix (text) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  const n = q.getModuleCount()
  const rows = []
  for (let r = 0; r < n; r++) {
    const row = []
    for (let c = 0; c < n; c++) row.push(q.isDark(r, c))
    rows.push(row)
  }
  return rows
}

// Two rows per line with half blocks, plus a quiet zone, light on dark
// terminals reading as dark on light.
function toTerminal (text) {
  const m = matrix(text)
  const n = m.length
  const q = 2
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && m[r][c]
  const lines = []
  for (let r = -q; r < n + q; r += 2) {
    let line = ''
    for (let c = -q; c < n + q; c++) {
      const top = dark(r, c)
      const bottom = dark(r + 1, c)
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█'
    }
    lines.push(line)
  }
  return lines.join('\n')
}

function toSvg (text, size = 220) {
  const m = matrix(text)
  const n = m.length + 4
  let path = ''
  m.forEach((row, r) => row.forEach((on, c) => { if (on) path += 'M' + (c + 2) + ' ' + (r + 2) + 'h1v1h-1z' }))
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + size + '" height="' + size + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>'
}

module.exports = { matrix, toTerminal, toSvg }
