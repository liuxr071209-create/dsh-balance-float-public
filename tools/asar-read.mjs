/**
 * Read files out of an Electron `app.asar` archive.
 *
 * DSH Desktop packs its whole runtime into `app.asar`. That path is an archive,
 * not a directory: shell tools, `ripgrep` (and therefore the `glob`/`grep`
 * tools), `node`, and `pnpm` all fail on it. This reader is the way to look at
 * the installed sources, which is how the plugin API statements in the
 * repository README were verified against a specific DSH build.
 *
 * Usage:
 *   node tools/asar-read.mjs list <app.asar> [innerPathPrefix]
 *   node tools/asar-read.mjs read <app.asar> <innerPath>
 *
 * Examples:
 *   node tools/asar-read.mjs list '<dsh>/resources/app.asar' 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/'
 *   node tools/asar-read.mjs read '<dsh>/resources/app.asar' 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'
 *
 * Format reminder: a small binary preamble, then the header JSON (padded to a
 * 4-byte boundary), then the concatenated file contents. The header is located
 * by searching for its `{"files":` marker and brace-matching it, which keeps
 * this reader independent of the exact preamble field order.
 */
import { closeSync, openSync, readSync, writeSync } from 'node:fs'

/** Bytes probed for the header. Far larger than any real header. */
const PROBE_BYTES = 8 * 1024 * 1024

/**
 * Read the header JSON and the absolute offset where file contents begin.
 * @param asar - path to the archive.
 * @returns the open descriptor, the parsed header, and the content offset.
 */
function readHeader(asar) {
  const fd = openSync(asar, 'r')
  const probe = Buffer.alloc(PROBE_BYTES)
  const read = readSync(fd, probe, 0, PROBE_BYTES, 0)
  const text = probe.subarray(0, read)
  const start = text.indexOf('{"files":')
  if (start < 0) throw new Error('asar header marker not found — is this an asar archive?')

  // Brace-match the header object, honouring string literals and escapes.
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < read; i += 1) {
    const ch = probe[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === 0x5c) escaped = true
      else if (ch === 0x22) inString = false
      continue
    }
    if (ch === 0x22) inString = true
    else if (ch === 0x7b) depth += 1
    else if (ch === 0x7d) {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error('asar header is truncated or malformed')
  return { fd, header: JSON.parse(text.toString('utf8', start, end)), dataStart: Math.ceil(end / 4) * 4 }
}

/** Flatten the header tree into `innerPath -> entry`. */
function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) walk(entry, path, out)
    else out.set(path, entry)
  }
}

const [command, asar, argument] = process.argv.slice(2)
if (command === undefined || asar === undefined) {
  console.error('usage: node tools/asar-read.mjs <list|read> <app.asar> [prefix|innerPath]')
  process.exit(2)
}

const { fd, header, dataStart } = readHeader(asar)
const files = new Map()
walk(header, '', files)
try {
  if (command === 'list') {
    for (const path of [...files.keys()].sort()) {
      if (path.startsWith(argument ?? '')) console.log(path)
    }
  } else if (command === 'read') {
    const entry = files.get(argument)
    if (entry === undefined) throw new Error(`not in archive: ${argument}`)
    const buffer = Buffer.alloc(Number(entry.size))
    readSync(fd, buffer, 0, buffer.length, dataStart + Number(entry.offset))
    try {
      writeSync(1, buffer)
    } catch (error) {
      /* Piping into `Select-Object -First n` closes stdout early; that is the
         consumer's choice, not a failure of this tool. */
      if (error?.code !== 'EPIPE') throw error
    }
  } else {
    throw new Error(`unknown command: ${command}`)
  }
} finally {
  closeSync(fd)
}
