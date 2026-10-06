/**
 * Print the `tools/pre-execute` wiring of the desktop bundle's official
 * auto-review plugin, so the lead can state how codex-guardian would compose with
 * it. Read-only.
 */
import { open } from 'node:fs/promises'

const ASAR = 'C:\\Users\\15185\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const TARGET = '/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js'
const [from, to] = [Number(process.argv[2] ?? 440), Number(process.argv[3] ?? 505)]

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

  let found
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${key}`
      if (value.files) walk(value, path)
      else if (path === TARGET) found = value
    }
  }
  walk(header, '')
  if (found === undefined) throw new Error(`not found: ${TARGET}`)

  const buf = Buffer.alloc(found.size)
  await fh.read(buf, 0, found.size, dataStart + Number(found.offset))
  const lines = buf.toString('utf8').split('\n')
  if (process.argv[2] === '--grep') {
    const pattern = new RegExp(process.argv[3], 'i')
    for (let i = 1; i <= lines.length; i += 1) {
      if (pattern.test(lines[i - 1])) console.log(`${String(i).padStart(4)}: ${lines[i - 1]}`)
    }
    process.exit(0)
  }
  for (let i = from; i <= Math.min(to, lines.length); i += 1) {
    console.log(`${String(i).padStart(4)}: ${lines[i - 1]}`)
  }
} finally {
  await fh.close()
}
