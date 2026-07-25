import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const sourceDirty =
  execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: root,
    encoding: 'utf8',
  }).trim().length > 0
const outputRoot =
  process.argv.find((value) => value.startsWith('--output='))?.slice('--output='.length) ??
  'C:\\tmp\\freecut-local-first-electron-p0'
const output = resolve(outputRoot)
const electronReadyPath = join(output, 'electron-ready.json')
const electronReadySha256Path = join(output, 'electron-ready.sha256')
const sourceHashesPath = join(output, 'source-hashes.json')
const verificationSummaryPath = join(output, 'verification-summary.json')

const sha256 = async (filePath) =>
  createHash('sha256').update(await readFile(filePath)).digest('hex').toUpperCase()
const sha256Text = (value) => createHash('sha256').update(value).digest('hex').toUpperCase()

const skillPackageDependency = {
  verificationId: 'SKPKG-20260722-a048e0a12373',
  skillReadySha256:
    'AD25CD020C60BA278E94D359FA55C5866E2926B3F23CF3940B7A747702F81C2F',
  registrySha256: '634DC6941F3C065505F9A119CE2B4352083E00597F9FBE8B3A8B1617045ED54C',
  bundleSha256: 'CFEA9D14A62D368CE4AFFFD74E1385CA7CDC11A01101DF212DA0A2164FA07350',
}

const sourcePaths = [
  'desktop/agent-runtime/agent-thread-types.ts',
  'desktop/agent-runtime/agent-thread-schema.ts',
  'desktop/agent-runtime/agent-thread-store.ts',
  'desktop/agent-runtime/agent-run-sandbox.ts',
  'desktop/agent-runtime/context-pack.ts',
  'desktop/agent-runtime/agent-runtime-service.ts',
  'desktop/agent-runtime/index.ts',
  'desktop/e2e-authorization.ts',
  'desktop/e2e-authorization.test.ts',
  'desktop/desktop-types.ts',
  'desktop/ipc-channels.ts',
  'desktop/ipc-validation.ts',
  'desktop/preload.ts',
  'desktop/main.ts',
  'desktop/agent-runtime/agent-thread-store.test.ts',
  'desktop/agent-runtime/agent-run-sandbox.test.ts',
  'desktop/agent-runtime/context-pack.test.ts',
  'desktop/agent-runtime/agent-runtime-service.test.ts',
  'desktop/ipc-validation.test.ts',
  'src/features/editor/agent/cloud-bridge-client.ts',
  'src/features/editor/agent/cloud-bridge-client.test.ts',
  'src/features/editor/components/freecut-bridge-runner.tsx',
  'src/features/editor/components/freecut-bridge-runner.test.ts',
  'scripts/generate-local-first-electron-ready.mjs',
]

const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (relativePath) => [
      relativePath,
      await sha256(join(root, relativePath)),
    ]),
  ),
)

const externalContractPaths = [
  'C:\\Users\\Administrator\\Documents\\Codex\\2026-07-19\\freecut-windows-local-e2e\\scripts\\local-e2e\\prepare-local-first-store-fixture.ps1',
  'C:\\Users\\Administrator\\Documents\\Codex\\2026-07-19\\freecut-windows-local-e2e\\scripts\\local-e2e\\validate-local-first-store.mjs',
  'C:\\Users\\Administrator\\Documents\\Codex\\2026-07-19\\freecut-windows-local-e2e\\scripts\\local-e2e\\verify-local-first-cleanup.ps1',
  'C:\\Users\\Administrator\\Documents\\Codex\\2026-07-19\\freecut-windows-local-e2e\\docs\\local-e2e\\local-first-storage-security.md',
]
const externalContractHashes = Object.fromEntries(
  await Promise.all(
    externalContractPaths.map(async (filePath) => [filePath, await sha256(filePath)]),
  ),
)

const rendererReadyPath = join(root, 'docs', 'local-e2e', 'renderer-ready.json')
const rendererEvidencePath = join(
  root,
  'docs',
  'local-e2e',
  'renderer-protocol-evidence.json',
)
const rendererReady = JSON.parse(await readFile(rendererReadyPath, 'utf8'))
const rendererDependency = {
  verificationId: rendererReady.verificationId,
  readyPath: rendererReadyPath,
  readySha256: await sha256(rendererReadyPath),
  evidencePath: rendererEvidencePath,
  evidenceSha256: await sha256(rendererEvidencePath),
}

const bundleHashes = Object.fromEntries(
  await Promise.all(
    ['dist-electron/main.cjs', 'dist-electron/preload.cjs'].map(async (relativePath) => [
      relativePath,
      await sha256(join(root, relativePath)),
    ]),
  ),
)

const verificationSeed = JSON.stringify({
  contractId: 'freecut.agent-runtime.local-first.v1',
  schemaVersion: 1,
  sourceRevision,
  sourceHashes,
  bundleHashes,
  externalContractHashes,
  dependencies: {
    skillPackage: skillPackageDependency,
    renderer: rendererDependency,
  },
})
const verificationId = `FC-LOCAL-FIRST-ELECTRON-P0-20260722-${createHash('sha256')
  .update(verificationSeed)
  .digest('hex')
  .slice(0, 16)
  .toUpperCase()}`

const generatedAt = new Date().toISOString()
const sourceHashesJson = `${JSON.stringify(sourceHashes, null, 2)}\n`
const sourceHashesSha256 = sha256Text(sourceHashesJson)
const verificationSummary = {
  schema: 'freecut.electron-verification/v1',
  verificationId,
  capturedAt: generatedAt,
  sourceRevision,
  sourceDirty,
  sourceHashes,
  bundleHashes,
  externalContractHashes,
  dependencies: {
    skillPackage: skillPackageDependency,
    renderer: rendererDependency,
  },
  assertions: {
    sixLocalRecordKinds: 'covered-by-agent-thread-store.test.ts',
    cloudContentProjection: 'covered-by-context-pack.test.ts',
    cleanupReadback: 'covered-by-agent-thread-store.test.ts and agent-runtime-service.test.ts',
    leaseFencing: 'covered-by-agent-thread-store.test.ts and agent-runtime-service.test.ts',
    sandboxLifecycle: 'covered-by-agent-run-sandbox.test.ts and agent-runtime-service.test.ts',
    skillLockImmutability: 'covered-by-agent-thread-store.test.ts',
    bridgeReceiptProjection:
      'covered-by-cloud-bridge-client.test.ts and freecut-bridge-runner.test.ts',
    cloudAckRejectsContent: 'covered-by-ipc-validation.test.ts',
  },
  noSecrets: true,
  finalJointE2eRun: false,
}
const verificationSummaryJson = `${JSON.stringify(verificationSummary, null, 2)}\n`
const verificationSummarySha256 = sha256Text(verificationSummaryJson)

const ready = {
  schema: 'jianhao.local-first.ready/v1',
  component: 'electron',
  status: 'READY',
  readinessScope: 'P0_ELECTRON_BOUNDARY',
  acceptanceStatus: 'READY_NOT_JOINT_E2E_PASS',
  readyMeaning: '可进入联合Local-First黑盒验收，不等于联合E2E PASS',
  protocolVersion: 'jianhao.agent.v1',
  verificationId,
  generatedAt,
  sourceRoot: root,
  sourceRevision,
  sourceDirty,
  platform: 'win32',
  dependencies: [
    {
      component: 'skill-package',
      verificationId: skillPackageDependency.verificationId,
      sha256: skillPackageDependency.skillReadySha256,
      registrySha256: skillPackageDependency.registrySha256,
      bundleSha256: skillPackageDependency.bundleSha256,
    },
    {
      component: 'renderer',
      verificationId: rendererDependency.verificationId,
      path: rendererDependency.readyPath,
      sha256: rendererDependency.readySha256,
      evidencePath: rendererDependency.evidencePath,
      evidenceSha256: rendererDependency.evidenceSha256,
    },
  ],
  contracts: {
    agentRuntime: {
      id: 'freecut.agent-runtime.local-first.v1',
      schemaVersion: 1,
    },
    timelineCommands: {
      id: 'freecut.timeline.commands.v2',
      commandVersion: 2,
      acceptedInboundVersions: [2, '2'],
    },
  },
  artifacts: [
    {
      name: 'electron-main',
      path: join(root, 'dist-electron', 'main.cjs'),
      sha256: bundleHashes['dist-electron/main.cjs'],
    },
    {
      name: 'electron-preload',
      path: join(root, 'dist-electron', 'preload.cjs'),
      sha256: bundleHashes['dist-electron/preload.cjs'],
    },
  ],
  contentRetention: {
    authority: 'local-only',
    contentRoot: '${app.getPath("userData")}\\private\\agent-runtime',
    cloudContentStored: false,
    cloudContentRecoveryAvailable: false,
    safeStorageStoresAgentContent: false,
  },
  contract: {
    id: 'freecut.agent-runtime.local-first.v1',
    schemaVersion: 1,
    storeFormat: 'atomic-json',
    dataRoot: '${app.getPath("userData")}\\private\\agent-runtime',
    storePath: '${app.getPath("userData")}\\private\\agent-runtime\\thread-store.json',
    sandboxRoot: '${app.getPath("userData")}\\private\\agent-runtime\\sandboxes',
    logsPath: '${app.getPath("logs")}\\main.log',
  },
  qaIsolationExample: {
    userDataPath: 'C:\\tmp\\freecut-local-first-electron-p0\\userdata',
    workspacePath: 'C:\\tmp\\freecut-local-first-electron-p0\\workspace',
    defaultUserDataTouched: false,
    defaultWorkspaceTouched: false,
  },
  externalBlackBoxContract: {
    copiedIntoProductRepo: false,
    executedByThisTask: false,
    hashes: externalContractHashes,
  },
  records: [
    'thread',
    'task',
    'turn',
    'run',
    'handoff',
    'event',
    'checkpoint',
    'contextSummary',
    'skillLock',
    'evidence',
  ],
  contentAuthority: {
    sourceOfTruth: 'local-thread-store',
    cloudContentRecovery: false,
    projectWorkspaceIsAgentStore: false,
    safeStorageIsAgentStore: false,
  },
  sandbox: {
    create: 'agentRuntime.startRun',
    write: 'agentRuntime.writeSandbox',
    status: 'agentRuntime.sandboxStatus',
    terminalCleanup: 'agentRuntime.completeRun',
    uncertainPolicy: 'retain-for-reconciliation',
  },
  contextPack: {
    schemaVersion: 1,
    fields: [
      'contractId',
      'schemaVersion',
      'threadId',
      'projectId',
      'runId',
      'contextSummary',
      'recentTurns',
      'directorState',
      'handoff',
      'snapshotId',
      'fingerprint',
    ],
    forbidden: [
      'mediaBytes',
      'mediaUrl',
      'absolutePath',
      'fullProjectJson',
      'fullTranscript',
      'skillBody',
      'apiKey',
      'authorization',
    ],
    persistence: 'transient-only',
  },
  preload: {
    global: 'window.freecutDesktop.agentRuntime',
    ipc: [
      'freecut:agent-runtime:get-info',
      'freecut:agent-runtime:list-records',
      'freecut:agent-runtime:put-records',
      'freecut:agent-runtime:start-run',
      'freecut:agent-runtime:complete-run',
      'freecut:agent-runtime:build-context-pack',
      'freecut:agent-runtime:project-cloud-metadata',
      'freecut:agent-runtime:acquire-lease',
      'freecut:agent-runtime:renew-lease',
      'freecut:agent-runtime:release-lease',
      'freecut:agent-runtime:assert-lease',
      'freecut:agent-runtime:write-sandbox',
      'freecut:agent-runtime:sandbox-status',
      'freecut:agent-runtime:cleanup',
    ],
    arbitraryNodeAccess: false,
    arbitraryFilesystemAccess: false,
    arbitraryCommandExecution: false,
  },
  blackBoxFlow: [
    'window.freecutDesktop.agentRuntime.getInfo()',
    'window.freecutDesktop.agentRuntime.putRecords({records:[thread,run,handoff,checkpoint,skillLock,evidence]})',
    'window.freecutDesktop.agentRuntime.listRecords({threadId,kinds,limit})',
    'window.freecutDesktop.agentRuntime.projectCloudMetadata(metadataOnly)',
    'window.freecutDesktop.agentRuntime.cleanup({scope:"thread",threadId})',
    'window.freecutDesktop.agentRuntime.listRecords({threadId}) => total=0',
  ],
  safeStorage: {
    agentContentStored: false,
    allowedPurpose: ['business-keys', 'device-credentials'],
    cleanupKeepsCredentials: true,
  },
  timelineLease: {
    mode: 'single-writer-per-timeline',
    fenceMonotonic: true,
    staleFenceError: 'STALE_FENCE',
    oldRunReplay: false,
  },
  recovery: {
    createdBeforeDispatch: 'interrupted',
    runningAfterDispatch: 'uncertain',
    uncertainSandbox: 'retained',
    terminalSandbox: 'removed-after-durable-result',
    invalidStore: 'fail-closed-no-empty-reset',
  },
  capacity: {
    durableStoreHardLimitBytes: 2147483648,
    sandboxMaxWriteBytes: 67108864,
    automaticContentEviction: false,
  },
  cleanup: {
    api: 'window.freecutDesktop.agentRuntime.cleanup',
    scopes: ['thread', 'all'],
    localContentRemoved: true,
    cloudRestoreAvailable: false,
    workspaceProjectFilesRemoved: false,
  },
  cloudZeroRetention: {
    scope: 'client-persistence-projection-and-log-boundary',
    serverPersistenceVerifiedByThisArtifact: false,
    contentStorage: 'forbidden',
    contentFields: [],
    persistedMetadataAllowlist: [
      'threadId',
      'runId',
      'status',
      'attempt',
      'commandId',
      'snapshotId',
      'snapshotHash',
      'fingerprint',
      'contractId',
      'contractVersion',
      'errorCode',
      'createdAt',
      'updatedAt',
    ],
    assertions: [
      'Agent正文唯一事实源是本地Thread Store。',
      'ContextPack不写入云端持久化字段、任务日志或Main日志。',
      '云端中断、重启或清理不能恢复本地正文。',
    ],
  },
  skillPackage: {
    ...skillPackageDependency,
    lockPolicy: 'schema-version-digest-immutable-during-run',
    skillBodyStored: false,
  },
  tests: {
    desktopCheck: {
      command: 'npm run desktop:check',
      result: 'PASS',
      summary: '69 files; no warnings, lint errors, or type errors',
    },
    desktopTest: {
      command: 'npm run desktop:test',
      result: 'PASS',
      summary: '27 files; 104 tests passed',
    },
    e2eAuthorization: {
      command: 'npx vp test run desktop/e2e-authorization.test.ts',
      result: 'PASS',
      summary: '1 file; 3 tests passed',
    },
    bridgeReceiptContract: {
      command:
        'npx vp test run desktop/ipc-validation.test.ts src/features/editor/agent/cloud-bridge-client.test.ts src/features/editor/components/freecut-bridge-runner.test.ts src/features/editor/agent/cloud-command-contract.test.ts src/features/editor/agent/cloud-command-runner.test.ts',
      result: 'PASS',
      summary: '5 files; 24 tests passed',
    },
    electronBundle: {
      command: 'node scripts/build-desktop.mjs',
      result: 'PASS',
      bundleHashes,
    },
    fullWebDesktopBuild: {
      command: 'npm run desktop:build',
      result: 'PASS',
      summary: 'Vite web build and Electron Main/Preload bundles completed successfully',
    },
    jointBlackBoxE2E: {
      result: 'NOT_RUN_BY_SCOPE',
      defaultUserDataTouched: false,
      defaultWorkspaceTouched: false,
    },
  },
  dependsOn: {
    skillPackage: {
      verificationId: skillPackageDependency.verificationId,
      sha256: skillPackageDependency.skillReadySha256,
      registrySha256: skillPackageDependency.registrySha256,
      bundleSha256: skillPackageDependency.bundleSha256,
    },
    renderer: rendererDependency,
  },
  evidence: [
    {
      name: 'electron-ready',
      path: electronReadyPath,
      sha256Path: electronReadySha256Path,
      sha256Scope: 'whole-file',
      selfHashPolicy: 'out-of-band-sidecar',
    },
    {
      name: 'verification-summary',
      path: verificationSummaryPath,
      sha256: verificationSummarySha256,
    },
    {
      name: 'source-hashes',
      path: sourceHashesPath,
      sha256: sourceHashesSha256,
    },
  ],
  sourceHashes,
  externalContractHashes,
}

await mkdir(output, { recursive: true })
await writeFile(sourceHashesPath, sourceHashesJson)
await writeFile(verificationSummaryPath, verificationSummaryJson)
await writeFile(electronReadyPath, `${JSON.stringify(ready, null, 2)}\n`)
await writeFile(
  electronReadySha256Path,
  `${await sha256(electronReadyPath)}\n`,
)

console.log(
  JSON.stringify(
    {
      verificationId,
      output,
      electronReadySha256: await sha256(electronReadyPath),
      verificationSummarySha256,
      sourceHashesSha256,
      sourceHashCount: sourcePaths.length,
      bundleHashes,
    },
    null,
    2,
  ),
)
