/** Use the same resolved-profile path as Electron's desktop host; no GUI or model call. */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.resolve(process.env.DSH_HOME ?? '')
const expected = path.resolve(here, '..', '..', '.dsh-guardian-desktop')
if (home !== expected) throw new Error('This test only accepts the prepared workspace test home')
const runtime = path.join(os.homedir(), 'AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh')
const installAnchor = path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')
const { loadProfileDirectory, loadLayeredEnv } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href)
const { runProfile } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')).href)
const profile = loadProfileDirectory('dsh', path.join(home, 'profiles/desktop'), installAnchor)
await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'desktop', resolvedProfile: { profile, installAnchor }, patchFiles: [path.join(here, 'mount-probe.patch.yml')], args: [] })
