/**
 * Does the desktop bundle's official auto-review plugin also answer
 * `approval/request`? That decides whether mounting codex-guardian into the
 * desktop profile would create two competing answerers.
 *
 * Read-only: opens the app.asar header, pulls the auto-review package files, and
 * reports every `approval` reference found in them.
 */
import { open } from 'node:fs/promises'

const ASAR = 'C:\\Users\\15185\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const fh = await open(ASAR, 'r')
try {
  const head = Buffer.alloc(16)
  await fh.read(head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(8)
  const raw = Buffer.alloc(jsonSize)
  await fh.read(raw, 0, jsonSize, 16)
  const text = raw.toString('utf8')
  const header = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1))
  const dataStart = 8 + headerSize

  const entries = []
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${key}`
      if (value.files) walk(value, path)
      else entries.push([path, value])
    }
  }
  walk(header, '')

  const wanted = entries.filter(([p]) => /dsh-experimental-auto-review\/(package\.json|lib\/.*\.js)$/.test(p))
  console.log(`auto-review files in asar: ${wanted.length}`)
  for (const [p, meta] of wanted) {
    const buf = Buffer.alloc(meta.size)
    await fh.read(buf, 0, meta.size, dataStart + Number(meta.offset))
    const body = buf.toString('utf8')
    if (p.endsWith('package.json')) {
      const pkg = JSON.parse(body)
      console.log(`\n--- ${p} (v${pkg.version}) ---`)
      console.log('main:', pkg.main, '| dsh:', JSON.stringify(pkg.dsh ?? null))
      continue
    }
    const lines = body.split('\n')
    const hits = []
    lines.forEach((line, index) => {
      if (/approval|answerer|pre-execute|ctx\.on\(|inject/i.test(line)) hits.push(`${index + 1}: ${line.trim().slice(0, 220)}`)
    })
    console.log(`\n--- ${p} (${meta.size} bytes) — ${hits.length} wiring-related lines ---`)
    for (const hit of hits.slice(0, 60)) console.log(hit)
  }
} finally {
  await fh.close()
}
