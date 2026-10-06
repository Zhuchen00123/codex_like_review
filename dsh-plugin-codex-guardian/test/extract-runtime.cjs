// Read-only extraction of the installed desktop's JS runtime for isolated QA.
const fs = require('node:fs'), path = require('node:path')
const archive = 'C:/Users/15185/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const destination = path.resolve(__dirname, '../../.dsh-guardian-runtime')
const fd = fs.openSync(archive, 'r'), head = Buffer.alloc(16)
try {
  fs.readSync(fd, head, 0, 16, 0)
  const data = Buffer.alloc(head.readUInt32LE(8)); fs.readSync(fd, data, 0, data.length, 16)
  const str = data.toString('utf8'), header = JSON.parse(str.slice(0, str.lastIndexOf('}')+1))
  let count = 0
  function copy(node, relative) {
    const target = path.resolve(destination, relative)
    if (!target.startsWith(destination+path.sep) && target !== destination) throw new Error('Invalid archive path')
    if (node.files) { fs.mkdirSync(target, { recursive: true }); for (const [name, child] of Object.entries(node.files)) copy(child, path.join(relative, name)); return }
    if (node.link) return // No external links or executable addon files are followed.
    if (node.unpacked) { fs.copyFileSync(path.join(archive+'.unpacked', 'dsh', relative), target); count++; return }
    const content = Buffer.alloc(node.size); fs.readSync(fd, content, 0, content.length, 8+head.readUInt32LE(4)+Number(node.offset))
    fs.writeFileSync(target, content); count++
  }
  copy(header.files.dsh, '')
  console.log(`Extracted ${count} installed runtime files to workspace QA directory`)
} finally { fs.closeSync(fd) }
