// Read-only inspection of the installed desktop archive; never modifies the app.
import fs from 'node:fs'
const archive = process.env.DSH_GUARDIAN_ASAR ?? 'C:/Users/15185/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const [target, from = '1', to = '100000'] = process.argv.slice(2)
if (!target) throw new Error('Usage: node notes/read-desktop-source.mjs /archive/path [from] [to]')
const fd = fs.openSync(archive, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const buffer = Buffer.alloc(head.readUInt32LE(8))
  fs.readSync(fd, buffer, 0, buffer.length, 16)
  const text = buffer.toString('utf8')
  const header = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1))
  let node = header
  for (const segment of target.split('/').filter(Boolean)) node = node.files?.[segment]
  if (!node || node.files || node.unpacked) throw new Error(`Not a packed file: ${target}`)
  const content = Buffer.alloc(node.size)
  fs.readSync(fd, content, 0, content.length, 8 + head.readUInt32LE(4) + Number(node.offset))
  const lines = content.toString('utf8').split('\n')
  for (let line = Number(from); line <= Math.min(Number(to), lines.length); line++) console.log(`${line}: ${lines[line - 1]}`)
} finally { fs.closeSync(fd) }
