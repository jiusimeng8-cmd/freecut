import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outdir = resolve(root, 'dist-electron')

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

await build({
  absWorkingDir: root,
  entryPoints: {
    main: 'desktop/main.ts',
    preload: 'desktop/preload.ts',
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outExtension: { '.js': '.cjs' },
  sourcemap: true,
  logLevel: 'info',
})
