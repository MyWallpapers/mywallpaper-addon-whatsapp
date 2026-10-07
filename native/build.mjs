import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const root = dirname(directory)
const scratch = join(directory, '.build')
const output = join(directory, 'out', 'windows-x86_64', 'bin')
const nodeVersion = '22.22.3'
const hashes = {
  windows: '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b',
  linux: '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f',
}
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' && command.endsWith('.cmd') })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited with ${result.status}`)
}
async function download(path, url, sha256) {
  let bytes
  try { bytes = await readFile(path) } catch {}
  if (bytes && createHash('sha256').update(bytes).digest('hex') === sha256) return
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Pinned Node download returned ${response.status}`)
  bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Pinned Node checksum mismatch')
  await writeFile(path, bytes)
}
await mkdir(scratch, { recursive: true }); await mkdir(output, { recursive: true })
// CI rebuilds from committed sources/lockfile; author-supplied binaries are never required.
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
const { build } = await import('esbuild')
const { inject } = await import('postject')
const built = await build({
  entryPoints: [join(directory, 'src', 'main.ts')], outfile: join(scratch, 'companion.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true,
  sourcemap: false, legalComments: 'none', metafile: true,
  // Only Node built-ins are external; Baileys and its WASM are inside this bundle.
  logLevel: 'warning', absWorkingDir: root,
})
const windowsNode = join(scratch, 'node.exe')
await download(windowsNode, `https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`, hashes.windows)
let generator = windowsNode
if (process.platform === 'linux' && process.arch === 'x64') {
  const archive = join(scratch, `node-v${nodeVersion}-linux-x64.tar.xz`)
  await download(archive, `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz`, hashes.linux)
  const sdk = join(scratch, 'linux-node')
  await mkdir(sdk, { recursive: true })
  run('tar', ['-xJf', archive, '--strip-components=1', '-C', sdk])
  generator = join(sdk, 'bin', 'node')
} else if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64 or Linux x64.')
// No snapshot/code cache: the blob can be generated on Linux for Windows, with
// the exact same Node version, and contains no absolute build-directory paths.
await writeFile(join(scratch, 'sea.json'), JSON.stringify({ main: 'companion.cjs', output: 'companion.blob', useSnapshot: false, useCodeCache: false, disableExperimentalSEAWarning: true }))
run(generator, ['--experimental-sea-config', 'sea.json'], scratch)
const executable = join(output, 'whatsapp.exe')
await copyFile(windowsNode, executable)
// The vendor's Authenticode signature describes the original Node executable.
// Remove its certificate table before embedding our application; retaining it
// would misrepresent the modified binary as vendor-signed.
const pe = await readFile(executable)
const optionalHeader = pe.readUInt32LE(0x3c) + 24
if (pe.readUInt16LE(optionalHeader) !== 0x20b) throw new Error('Expected an x64 PE executable')
const certificateEntry = optionalHeader + 112 + 4 * 8
const certificateOffset = pe.readUInt32LE(certificateEntry)
const certificateSize = pe.readUInt32LE(certificateEntry + 4)
pe.writeUInt32LE(0, certificateEntry); pe.writeUInt32LE(0, certificateEntry + 4)
pe.writeUInt32LE(0, optionalHeader + 64)
await writeFile(executable, certificateOffset && certificateOffset + certificateSize === pe.length ? pe.subarray(0, certificateOffset) : pe)
await inject(executable, 'NODE_SEA_BLOB', await readFile(join(scratch, 'companion.blob')), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' })

// Keep the licences of dependencies actually present in the compiled payload.
const packageDirectories = new Map()
for (const input of Object.keys(built.metafile.inputs)) {
  let candidate = dirname(resolve(root, input))
  while (candidate.includes('node_modules')) {
    try {
      const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
      if (pkg.name && pkg.version) { packageDirectories.set(`${pkg.name}@${pkg.version}`, candidate); break }
    } catch {}
    candidate = dirname(candidate)
  }
}
const notices = [await readFile(join(directory, 'NODE-LICENSE.txt'), 'utf8')]
for (const [name, path] of [...packageDirectories].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const licenses = (await readdir(path)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file)).sort()
  notices.push(`\n\n=== ${name} ===\n`)
  if (!licenses.length) {
    const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (metadata.license !== 'MIT') throw new Error(`No licence text for bundled dependency ${name}`)
    // Some MIT packages publish their SPDX declaration without a licence file.
    // Attribute the published metadata explicitly; do not invent a copyright.
    notices.push(`Publisher: ${typeof metadata.author === 'object' ? metadata.author.name : metadata.author ?? 'See upstream repository'}\nDeclared licence: MIT (package.json)\nRepository: ${typeof metadata.repository === 'object' ? metadata.repository.url : metadata.repository ?? metadata.homepage ?? ''}\n`, await readFile(join(directory, 'licenses', 'MIT.txt'), 'utf8'))
  }
  for (const license of licenses) notices.push(await readFile(join(path, license), 'utf8'))
}
await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'))
console.log(`Windows companion built: ${createHash('sha256').update(await readFile(executable)).digest('hex')}`)
