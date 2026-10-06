/** Create a fresh desktop test home; refuses to overwrite any existing profile. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = process.argv.slice(2)
if (argument.length > 1) throw new Error('Usage: node scripts/prepare-desktop.mjs [new-test-home]')
const home = path.resolve(argument[0] ?? path.join(pluginRoot, '..', '.dsh-guardian-desktop'))
const production = path.resolve(os.homedir(), '.dsh')
if (home.toLowerCase() === production.toLowerCase() || home.toLowerCase().startsWith(production.toLowerCase()+path.sep)) throw new Error('Refusing to modify the production DSH home')
const profile = path.join(home, 'profiles', 'desktop')
if (fs.existsSync(profile)) throw new Error(`Profile already exists; no files changed: ${profile}`)
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop', private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2)+'\n', { flag: 'wx' })
fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), `- insert:\n    - id: codex-guardian\n      name: ${JSON.stringify(path.join(pluginRoot, 'src', 'index.js').replaceAll('\\', '/'))}\n      config:\n        enabled: true\n        usageGuard: true\n        maxReviewsPerHour: 120\n`, { flag: 'wx' })
fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', { flag: 'wx' })
const quote = (value) => value.replaceAll("'", "''")
const launcher = `$ErrorActionPreference = 'Stop'
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  throw 'Fully exit DeepSeek Harness (including its tray process) before starting this isolated test.'
}
$dshExecutable = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $dshExecutable)) { throw 'DeepSeek Harness executable not found.' }
$previousDshHome = $env:DSH_HOME
$previousElectronMode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:DSH_HOME = '${quote(home)}'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  & $dshExecutable
} finally {
  $env:DSH_HOME = $previousDshHome
  $env:ELECTRON_RUN_AS_NODE = $previousElectronMode
}
`
fs.writeFileSync(path.join(home, 'launch-desktop.ps1'), launcher, { flag: 'wx' })
console.log(`Prepared: ${profile}`)
console.log(`Launch: powershell -ExecutionPolicy Bypass -File "${path.join(home, 'launch-desktop.ps1')}"`)
console.log('No official Auto bundle, production profile, or credential store was modified.')
