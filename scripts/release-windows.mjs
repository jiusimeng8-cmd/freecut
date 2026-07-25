import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Windows release must run on Windows.')
}

const root = resolve(import.meta.dirname, '..')
const releaseDirectory = join(root, 'release')
const dryRun = process.argv.includes('--dry-run')
const required = [
  'FREECUT_UPDATE_URL',
  'FREECUT_WINDOWS_TIMESTAMP_URL',
  'FREECUT_PUBLISHER_NAME',
  'FREECUT_FFMPEG_PATH',
  'FREECUT_FFPROBE_PATH',
  'FREECUT_FFMPEG_SOURCE_URL',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
]
const missing = required.filter((name) => !process.env[name]?.trim())
if (missing.length > 0) {
  throw new Error(`Missing Windows release environment variables: ${missing.join(', ')}`)
}

if (process.env.ELECTRON_BUILDER_OFFLINE === 'true') {
  throw new Error('ELECTRON_BUILDER_OFFLINE=true disables Authenticode timestamping.')
}

const rendererSecretNamePattern =
  /^VITE_.*(?:^|_)(?:API_?KEY|BUSINESS_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i
const rendererSecrets = Object.entries(process.env)
  .filter(([name, value]) => rendererSecretNamePattern.test(name) && value?.trim())
  .map(([name]) => name)
for (const fileName of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const contents = await readFile(join(root, fileName), 'utf8').catch(() => '')
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/i)
    if (!match || !rendererSecretNamePattern.test(match[1])) continue
    const value = match[2].replace(/^(["'])(.*)\1$/, '$2').trim()
    if (value) rendererSecrets.push(`${fileName}:${match[1]}`)
  }
}
if (rendererSecrets.length > 0) {
  throw new Error(
    `Windows release refuses secrets exposed through Vite Renderer variables: ${rendererSecrets.join(', ')}`,
  )
}

function isNonPublicIpv4(hostname) {
  const [a, b] = hostname.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function mappedIpv4(hostname) {
  if (!hostname.startsWith('::ffff:')) return null
  const groups = hostname.slice(7).split(':')
  if (groups.length !== 2) return null
  const high = Number.parseInt(groups[0], 16)
  const low = Number.parseInt(groups[1], 16)
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

function isNonPublicHost(hostname) {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true
  }
  if (
    ['example.com', 'example.net', 'example.org'].some(
      (reserved) => host === reserved || host.endsWith(`.${reserved}`),
    ) ||
    ['.example', '.test', '.invalid'].some((suffix) => host.endsWith(suffix))
  ) {
    return true
  }

  const ipVersion = isIP(host)
  if (ipVersion === 4) return isNonPublicIpv4(host)
  if (ipVersion === 6) {
    const mapped = mappedIpv4(host)
    if (mapped) return isNonPublicIpv4(mapped)
    const firstGroup = Number.parseInt(host.split(':', 1)[0] || '0', 16)
    return (
      host === '::' ||
      host === '::1' ||
      (firstGroup & 0xfe00) === 0xfc00 ||
      (firstGroup & 0xffc0) === 0xfe80
    )
  }

  return !host.includes('.')
}

function parsePublicUrl(name, value, protocols) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL.`)
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}.`)
  }
  if (url.username || url.password || isNonPublicHost(url.hostname)) {
    throw new Error(`${name} must use a public host without embedded credentials.`)
  }
  return url
}

async function assertFile(path) {
  const fileStat = await stat(path).catch(() => null)
  if (!fileStat?.isFile() || fileStat.size === 0) {
    throw new Error(`Missing or empty release resource: ${path}`)
  }
  return fileStat
}

function hashFile(path, algorithm, encoding) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash(algorithm)
    const input = createReadStream(path)
    input.on('error', rejectHash)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolveHash(hash.digest(encoding)))
  })
}

const licenseResources = [
  {
    source: join(root, 'LICENSE'),
    destination: join('licenses', 'FreeCut-LICENSE.txt'),
  },
  {
    source: join(root, 'resources', 'licenses', 'THIRD_PARTY_NOTICES.txt'),
    destination: join('licenses', 'THIRD_PARTY_NOTICES.txt'),
  },
  {
    source: join(root, 'resources', 'windows', 'ffmpeg', 'LICENSE'),
    destination: join('windows', 'ffmpeg', 'LICENSE'),
  },
  {
    source: join(root, 'resources', 'windows', 'ffmpeg', 'README.txt'),
    destination: join('windows', 'ffmpeg', 'README.txt'),
  },
  {
    source: join(root, 'resources', 'windows', 'ffmpeg', 'manifest.json'),
    destination: join('windows', 'ffmpeg', 'manifest.json'),
  },
]

async function verifyBuilderConfig() {
  const [config, mainProcess] = await Promise.all([
    readFile(join(root, 'electron-builder.yml'), 'utf8'),
    readFile(join(root, 'desktop', 'main.ts'), 'utf8'),
  ])
  const requiredFragments = [
    'url: ${env.FREECUT_UPDATE_URL}',
    'signExecutable: true',
    'signExts:',
    "- '!ffmpeg.exe'",
    "- '!ffprobe.exe'",
    'signingHashAlgorithms:',
    '- sha256',
    'verifyUpdateCodeSignature: true',
    'from: LICENSE',
    'to: licenses/FreeCut-LICENSE.txt',
    'from: resources/licenses',
  ]
  const missingFragments = requiredFragments.filter((fragment) => !config.includes(fragment))
  if (missingFragments.length > 0) {
    throw new Error(
      `electron-builder.yml is missing release controls: ${missingFragments.join(', ')}`,
    )
  }
  if (config.includes('rfc3161TimeStampServer: ${env.FREECUT_WINDOWS_TIMESTAMP_URL}')) {
    throw new Error(
      'electron-builder.yml must not use an env macro for signtoolOptions.rfc3161TimeStampServer.',
    )
  }
  if (
    mainProcess.includes('process.env.FREECUT_UPDATE_URL') ||
    mainProcess.includes('autoUpdater.setFeedURL')
  ) {
    throw new Error(
      'Packaged updates must use the signed app-update.yml instead of a runtime feed override.',
    )
  }
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (packageJson.freecutReleaseChannel !== 'production') {
    throw new Error('package.json must mark formal builds as freecutReleaseChannel=production.')
  }
}

async function verifyLicenseSources() {
  await Promise.all(licenseResources.map(({ source }) => assertFile(source)))

  const ffmpegDirectory = join(root, 'resources', 'windows', 'ffmpeg')
  const manifest = JSON.parse(await readFile(join(ffmpegDirectory, 'manifest.json'), 'utf8'))
  for (const field of ['ffmpegSha256', 'ffprobeSha256', 'ffmpegSize', 'ffprobeSize']) {
    if (!manifest[field]) {
      throw new Error(`FFmpeg manifest is missing ${field}.`)
    }
  }
  const [ffmpegStat, ffprobeStat, ffmpegHash, ffprobeHash] = await Promise.all([
    stat(join(ffmpegDirectory, 'ffmpeg.exe')),
    stat(join(ffmpegDirectory, 'ffprobe.exe')),
    hashFile(join(ffmpegDirectory, 'ffmpeg.exe'), 'sha256', 'hex'),
    hashFile(join(ffmpegDirectory, 'ffprobe.exe'), 'sha256', 'hex'),
  ])
  if (
    ffmpegStat.size !== manifest.ffmpegSize ||
    ffprobeStat.size !== manifest.ffprobeSize ||
    ffmpegHash !== manifest.ffmpegSha256 ||
    ffprobeHash !== manifest.ffprobeSha256
  ) {
    throw new Error('FFmpeg manifest does not match the bundled executable bytes.')
  }
  for (const name of ['LICENSE', 'README.txt']) {
    if (!manifest.noticeFiles?.includes(name)) {
      throw new Error(`FFmpeg manifest does not declare ${name}.`)
    }
  }

  const [license, readme, notices] = await Promise.all([
    readFile(join(ffmpegDirectory, 'LICENSE'), 'utf8'),
    readFile(join(ffmpegDirectory, 'README.txt'), 'utf8'),
    readFile(join(root, 'resources', 'licenses', 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
  ])
  if (!license.includes('GNU GENERAL PUBLIC LICENSE') || !license.includes('Version 3')) {
    throw new Error('Bundled FFmpeg GPL v3 license text is not recognizable.')
  }
  if (!readme.includes('License: GPL v3') || !readme.includes('Source Code:')) {
    throw new Error('Bundled FFmpeg build/source notice is incomplete.')
  }
  const sourceUrl = parsePublicUrl(
    'FREECUT_FFMPEG_SOURCE_URL',
    process.env.FREECUT_FFMPEG_SOURCE_URL,
    ['https:'],
  )
  if (!readme.includes(sourceUrl.href)) {
    throw new Error(
      'Bundled FFmpeg README.txt must include the exact corresponding-source delivery URL.',
    )
  }
  if (notices.includes('must complete corresponding-source delivery')) {
    throw new Error(
      'THIRD_PARTY_NOTICES.txt still marks FFmpeg corresponding-source delivery as incomplete.',
    )
  }
  for (const reference of [
    'windows/ffmpeg/LICENSE',
    'windows/ffmpeg/README.txt',
    'windows/ffmpeg/manifest.json',
  ]) {
    if (!notices.includes(reference)) {
      throw new Error(`THIRD_PARTY_NOTICES.txt does not reference ${reference}.`)
    }
  }
}

function yamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed)
  }
  return trimmed
}

function yamlStringList(contents, key) {
  const lines = contents.split(/\r?\n/)
  const prefix = `${key}:`
  const start = lines.findIndex((line) => line.startsWith(prefix))
  if (start < 0) return []

  const inline = lines[start].slice(prefix.length).trim()
  if (inline) return [yamlScalar(inline)]

  const values = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s{2}-\s+(.+)$/)
    if (!match) break
    values.push(yamlScalar(match[1]))
  }
  return values
}

function parseLatestYml(contents) {
  const lines = contents.split(/\r?\n/)
  const findValue = (pattern, name) => {
    const match = lines.map((line) => line.match(pattern)).find(Boolean)
    if (!match) throw new Error(`latest.yml is missing ${name}.`)
    return yamlScalar(match[1])
  }
  return {
    version: findValue(/^version:\s*(.+)$/, 'version'),
    path: findValue(/^path:\s*(.+)$/, 'path'),
    sha512: findValue(/^sha512:\s*(.+)$/, 'sha512'),
    fileUrl: findValue(/^\s{2}- url:\s*(.+)$/, 'files[0].url'),
    fileSha512: findValue(/^\s{4}sha512:\s*(.+)$/, 'files[0].sha512'),
    fileSize: Number(findValue(/^\s{4}size:\s*(.+)$/, 'files[0].size')),
  }
}

async function verifyLatestYml() {
  const latestPath = join(releaseDirectory, 'latest.yml')
  await assertFile(latestPath)
  const latest = parseLatestYml(await readFile(latestPath, 'utf8'))
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const expectedArtifactName = `FreeCut-Setup-${packageJson.version}-x64.exe`

  if (latest.version !== packageJson.version) {
    throw new Error(
      `latest.yml version ${latest.version} does not match package ${packageJson.version}.`,
    )
  }
  if (
    latest.path !== expectedArtifactName ||
    latest.fileUrl !== latest.path ||
    basename(latest.path) !== latest.path
  ) {
    throw new Error('latest.yml does not reference the expected Windows installer.')
  }
  if (latest.fileSha512 !== latest.sha512 || !Number.isSafeInteger(latest.fileSize)) {
    throw new Error('latest.yml installer metadata is inconsistent.')
  }

  const artifactPath = join(releaseDirectory, latest.path)
  const artifactStat = await assertFile(artifactPath)
  await assertFile(`${artifactPath}.blockmap`)
  if (artifactStat.size !== latest.fileSize) {
    throw new Error('latest.yml installer size does not match the built artifact.')
  }

  const actualSha512 = await hashFile(artifactPath, 'sha512', 'base64')
  if (actualSha512 !== latest.sha512) {
    throw new Error('latest.yml SHA-512 does not match the built installer.')
  }

  return {
    artifactPath,
    latestPath,
    latestSha256: await hashFile(latestPath, 'sha256', 'hex'),
    sha512: actualSha512,
  }
}

function canonicalUrl(value) {
  return new URL(value).href.replace(/\/+$/, '')
}

async function verifyPackagedUpdateUrl(expectedUrl, expectedPublisherName) {
  const appUpdatePath = join(releaseDirectory, 'win-unpacked', 'resources', 'app-update.yml')
  await assertFile(appUpdatePath)
  const contents = await readFile(appUpdatePath, 'utf8')
  const match = contents.match(/^url:\s*(.+)$/m)
  const publisherNames = yamlStringList(contents, 'publisherName')
  if (
    !contents.includes('provider: generic') ||
    !match ||
    canonicalUrl(yamlScalar(match[1])) !== canonicalUrl(expectedUrl.href) ||
    publisherNames.length !== 1 ||
    publisherNames[0] !== expectedPublisherName
  ) {
    throw new Error(
      'Packaged app-update.yml does not contain the production update URL and publisher name.',
    )
  }
}

async function verifyPackagedLicenses() {
  const packagedResources = join(releaseDirectory, 'win-unpacked', 'resources')
  for (const resource of licenseResources) {
    const destination = join(packagedResources, resource.destination)
    await assertFile(destination)
    const [sourceHash, destinationHash] = await Promise.all([
      hashFile(resource.source, 'sha256', 'hex'),
      hashFile(destination, 'sha256', 'hex'),
    ])
    if (sourceHash !== destinationHash) {
      throw new Error(`Packaged license resource differs from source: ${resource.destination}`)
    }
  }
}

async function verifyPackagedFfmpeg() {
  const sourceDirectory = join(root, 'resources', 'windows', 'ffmpeg')
  const packagedDirectory = join(releaseDirectory, 'win-unpacked', 'resources', 'windows', 'ffmpeg')
  const [sourceManifest, packagedManifest] = await Promise.all([
    readFile(join(sourceDirectory, 'manifest.json'), 'utf8'),
    readFile(join(packagedDirectory, 'manifest.json'), 'utf8'),
  ])
  if (sourceManifest !== packagedManifest) {
    throw new Error('Packaged FFmpeg manifest differs from the source manifest.')
  }
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const [sourceHash, packagedHash] = await Promise.all([
      hashFile(join(sourceDirectory, name), 'sha256', 'hex'),
      hashFile(join(packagedDirectory, name), 'sha256', 'hex'),
    ])
    if (sourceHash !== packagedHash) {
      throw new Error(`Packaged FFmpeg executable differs from source: ${name}`)
    }
  }
}

function readAuthenticodeSignature(path) {
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:FREECUT_SIGNATURE_TARGET',
    '[pscustomobject]@{',
    'Status = $signature.Status.ToString()',
    'StatusMessage = $signature.StatusMessage',
    'SignerSubject = $signature.SignerCertificate.Subject',
    'SignerName = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }',
    'SignerThumbprint = $signature.SignerCertificate.Thumbprint',
    'TimeStamperSubject = $signature.TimeStamperCertificate.Subject',
    'TimeStamperThumbprint = $signature.TimeStamperCertificate.Thumbprint',
    '} | ConvertTo-Json -Compress',
  ].join('\n')
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FREECUT_SIGNATURE_TARGET: path,
      },
      windowsHide: true,
    },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Authenticode inspection failed: ${path}`)
  }
  return JSON.parse(result.stdout.trim())
}

async function verifyAuthenticode(artifactPath, expectedPublisherName) {
  const targets = [artifactPath, join(releaseDirectory, 'win-unpacked', 'FreeCut.exe')]
  const signatures = []
  for (const target of targets) {
    await assertFile(target)
    const signature = readAuthenticodeSignature(target)
    if (
      signature.Status !== 'Valid' ||
      signature.SignerName !== expectedPublisherName ||
      !signature.SignerThumbprint ||
      !signature.TimeStamperThumbprint
    ) {
      throw new Error(
        `Authenticode signature or timestamp is invalid for ${target}: ${
          signature.StatusMessage || signature.Status
        }`,
      )
    }
    signatures.push({ target, ...signature })
  }
  return signatures
}

const updateUrl = parsePublicUrl('FREECUT_UPDATE_URL', process.env.FREECUT_UPDATE_URL, ['https:'])
const publisherName = process.env.FREECUT_PUBLISHER_NAME.trim()
if (!publisherName) throw new Error('FREECUT_PUBLISHER_NAME must not be empty.')
const timestampUrl = parsePublicUrl(
  'FREECUT_WINDOWS_TIMESTAMP_URL',
  process.env.FREECUT_WINDOWS_TIMESTAMP_URL,
  ['http:', 'https:'],
)
const ffmpegPath = resolve(process.env.FREECUT_FFMPEG_PATH)
const ffprobePath = resolve(process.env.FREECUT_FFPROBE_PATH)
if (dirname(ffmpegPath) !== dirname(ffprobePath)) {
  throw new Error('FREECUT_FFMPEG_PATH and FREECUT_FFPROBE_PATH must come from one distribution.')
}
await verifyBuilderConfig()
await verifyLicenseSources()

if (dryRun) {
  process.stdout.write(
    'Windows market release static preflight passed; build and artifact checks were skipped.\n',
  )
  process.exit(0)
}

const npm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['npm.cmd']
function runNpm(args, label) {
  const result = spawnSync(npm[0], [...npm.slice(1), ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`)
  }
}

for (const script of [
  'desktop:check',
  'desktop:test',
  'check',
  'check:boundaries',
  'check:deps-contracts',
  'check:legacy-lib-imports',
  'check:deps-wrapper-health',
  'check:unused-exports',
  'check:unused-class-members',
  'check:changed-health',
  'check:edge-budgets',
  'test:run',
]) {
  runNpm(['run', script], `Windows release quality gate ${script}`)
}

runNpm(['run', 'desktop:prepare-resources'], 'Windows release FFmpeg preparation')
await verifyLicenseSources()
runNpm(['run', 'desktop:build'], 'Windows release build')
runNpm(
  [
    'exec',
    '--',
    'electron-builder',
    '--win',
    'nsis',
    '--publish',
    'never',
    '--config.win.forceCodeSigning=true',
    `--config.win.signtoolOptions.rfc3161TimeStampServer=${timestampUrl.href}`,
  ],
  'Windows release build',
)

const artifact = await verifyLatestYml()
await verifyPackagedUpdateUrl(updateUrl, publisherName)
await verifyPackagedLicenses()
await verifyPackagedFfmpeg()
const signatures = await verifyAuthenticode(artifact.artifactPath, publisherName)

process.stdout.write(
  [
    'Windows market release verification passed.',
    `Installer SHA-512: ${artifact.sha512}`,
    `latest.yml SHA-256: ${artifact.latestSha256}`,
    ...signatures.map(
      ({ target, SignerSubject, TimeStamperSubject }) =>
        `${basename(target)} signer: ${SignerSubject}; timestamp: ${TimeStamperSubject}`,
    ),
  ].join('\n') + '\n',
)
