import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('FreeCut development signing is supported on Windows only.')
}

const root = resolve(import.meta.dirname, '..')
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const electronBuilderCli = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`)
  }
}

const configuredManifestUrl = process.env.FREECUT_UPDATE_MANIFEST_URL?.trim()
let manifestUrl = null
if (configuredManifestUrl) {
  manifestUrl = new URL(configuredManifestUrl)
  if (manifestUrl.protocol !== 'https:' || manifestUrl.username || manifestUrl.password) {
    throw new Error('FREECUT_UPDATE_MANIFEST_URL must use HTTPS without embedded credentials.')
  }
}

run(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'scripts', 'ensure-development-certificate.ps1'),
  ],
  'Development certificate preparation',
)
run(process.execPath, [npmCli, 'run', 'desktop:prepare-resources'], 'Windows resource preparation')
run(process.execPath, [npmCli, 'run', 'desktop:build'], 'Desktop build')

const builderArgs = [
  '--win',
  'nsis',
  '--publish',
  'never',
  '--config.productName=FreeCut Development',
  '--config.appId=com.freecut.desktop.dev',
  '--config.directories.output=release-dev',
  '--config.extraMetadata.freecutReleaseChannel=development',
  `--config.extraMetadata.freecutUpdateMode=${manifestUrl ? 'notification' : 'disabled'}`,
  '--config.win.artifactName=FreeCut-Development-${version}-${arch}.${ext}',
  '--config.win.signtoolOptions.certificateSubjectName=FreeCut Development',
  '--config.publish.url=https://updates.invalid',
]

if (manifestUrl) {
  builderArgs.push(`--config.extraMetadata.freecutUpdateManifestUrl=${manifestUrl.href}`)
}

run(
  process.execPath,
  [electronBuilderCli, ...builderArgs],
  'Self-signed Windows installer build',
)
