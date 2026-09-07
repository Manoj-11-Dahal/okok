const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { resolve, join } = require('node:path')

const builderRequire = createRequire(require.resolve('electron-builder'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = appBuilderRequire('@electron/asar')
const release = resolve(__dirname, '../../..', 'release')
const archive = join(release, 'win-unpacked/resources/app.asar')
const paths = asar.listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\//, ''))
const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString())
assert.equal(manifest.main, './out/main/index.js')
for (const required of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  assert(paths.includes(required), `Missing runtime file: ${required}`)
}
for (const path of paths) {
  assert(/^(?:out(?:\/|$)|node_modules(?:\/|$)|package\.json$)/.test(path), `Unexpected package path: ${path}`)
  assert(!/(?:^|\/)(?:credentials|\.local-ai|\.codex|\.env(?:\.[^/]*)?)(?:\/|$)/i.test(path), `Private data path in package: ${path}`)
}
const main = asar.extractFile(archive, join('out', 'main', 'index.js')).toString()
assert(main.includes('configureInstalledLocalAiHome'), 'Installed model storage configuration is missing')
const artifacts = ['Setup', 'Portable'].map(kind => `ALTREX-CODE-${kind}-${manifest.version}-x64.exe`)
const sums = artifacts.map(name => {
  const file = join(release, name)
  assert(statSync(file).size > 1_000_000, `Invalid executable size: ${name}`)
  const data = readFileSync(file)
  assert.equal(data.subarray(0, 2).toString(), 'MZ', `Not a Windows executable: ${name}`)
  return `${createHash('sha256').update(data).digest('hex')}  ${name}`
})
assert(readdirSync(join(release, 'win-unpacked')).includes('LICENSES.chromium.html'), 'Chromium license notices missing')
writeFileSync(join(release, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
console.log(JSON.stringify({ archiveEntries: paths.length, artifacts, checksums: 'SHA256SUMS.txt', result: 'passed' }, null, 2))
