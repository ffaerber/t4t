/**
 * Upload dist/ to a Bee node as a single Swarm collection, then print the
 * Swarm reference + the EIP-1577 contenthash to set on ENS for t4t.eth.
 *
 *   BEE_API_URL=http://localhost:1633 \
 *   POSTAGE_BATCH_ID=0x… \
 *   node deploy-swarm.mjs
 *
 * Setting ENS contenthash itself is a manual step — this script just gives
 * you the value to paste into the ENS app.
 *
 * BEE_API_KEY is optional and only needed when BEE_API_URL points at
 * swarm-stamp-monitor rather than a Bee node directly. The monitor speaks
 * Bee's upload API but authenticates per app, which is what lets the node stay
 * off the public internet — it also ignores the batch header and uses the
 * batch assigned to the key's app, so the two cannot drift apart.
 */
import {readdir, readFile, stat} from 'node:fs/promises'
import {join, relative, posix} from 'node:path'

const ROOT = 'dist'
const BEE = process.env.BEE_API_URL ?? 'http://localhost:1633'
const API_KEY = process.env.BEE_API_KEY
const BATCH = process.env.POSTAGE_BATCH_ID
if (!BATCH) {
  console.error('POSTAGE_BATCH_ID env var required (your funded Bee postage stamp).')
  process.exit(1)
}

const files = await walk(ROOT)
if (files.length === 0) {
  console.error(`No files under ${ROOT}/. Run \`npm run build\` first.`)
  process.exit(1)
}

// Build a multipart/form-data body that Bee's `/bzz` endpoint accepts as a
// collection. Each part is one file; `index.html` is marked as the default.
const boundary = '----t4t-' + Math.random().toString(16).slice(2)
const parts = []
const enc = new TextEncoder()
for (const path of files) {
  const rel = posix.normalize(relative(ROOT, path).split(/[\\/]/).join('/'))
  const buf = await readFile(path)
  parts.push(enc.encode(`--${boundary}\r\n`))
  parts.push(
    enc.encode(
      `content-disposition: form-data; name="file"; filename="${rel}"\r\n` +
        `content-type: ${guessMime(rel)}\r\n\r\n`,
    ),
  )
  parts.push(buf)
  parts.push(enc.encode('\r\n'))
}
parts.push(enc.encode(`--${boundary}--\r\n`))
const body = concatBytes(parts)

console.log(`uploading ${files.length} file(s), ${body.length} bytes to ${BEE} …`)
const res = await fetch(`${BEE}/bzz?name=t4t-website`, {
  method: 'POST',
  headers: {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'swarm-postage-batch-id': BATCH,
    'swarm-index-document': 'index.html',
    'swarm-error-document': 'index.html',
    'swarm-collection': 'true',
    ...(API_KEY ? {'x-api-key': API_KEY} : {}),
  },
  body,
})
if (!res.ok) {
  console.error(`Bee upload failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
const {reference} = await res.json()
const contenthash = `0xe40101fa011b20${reference}` // bzz codec, EIP-1577

console.log('')
console.log('  Swarm reference :', reference)
console.log('  Gateway preview :', `https://${reference}.bzz.link/`)
console.log('  ENS contenthash :', contenthash)
console.log('')
console.log('Set the contenthash on t4t.eth via the ENS app (Records → Content).')

function concatBytes(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

async function walk(dir) {
  const out = []
  for (const ent of await readdir(dir, {withFileTypes: true})) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else if ((await stat(p)).isFile()) out.push(p)
  }
  return out
}

function guessMime(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8'
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.css')) return 'text/css; charset=utf-8'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}
