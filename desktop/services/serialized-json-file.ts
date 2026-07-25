import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface SerializedJsonFileOptions<T> {
  parse?: (value: unknown) => T
  recoverInvalid?: boolean
}

export class SerializedJsonFile<T> {
  private value: T | null = null
  private loaded = false
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly createDefault: () => T,
    private readonly options: SerializedJsonFileOptions<T> = {},
  ) {}

  read(): Promise<T> {
    return this.enqueue(async () => structuredClone(await this.load()))
  }

  update(updater: (current: T) => T): Promise<T> {
    return this.enqueue(async () => {
      const next = updater(structuredClone(await this.load()))
      await this.persist(next)
      this.value = structuredClone(next)
      return structuredClone(next)
    })
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.pending.then(operation, operation)
    this.pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async load(): Promise<T> {
    if (this.loaded && this.value !== null) return this.value
    this.loaded = true
    const backupPath = `${this.filePath}.bak`
    const source = await readFile(this.filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (source) {
      try {
        this.value = this.parse(source)
        return this.value
      } catch (error) {
        const backup = await readFile(backupPath, 'utf8').catch(() => '')
        if (backup) {
          try {
            this.value = this.parse(backup)
            await mkdir(dirname(this.filePath), { recursive: true })
            await copyFile(backupPath, this.filePath)
            return this.value
          } catch {
            // Keep the primary error when both copies are invalid.
          }
        }
        if (!this.options.recoverInvalid) throw error
        await this.quarantine(this.filePath)
        await this.quarantine(backupPath)
        this.value = this.createDefault()
        return this.value
      }
    }

    const backup = await readFile(backupPath, 'utf8').catch(() => '')
    if (backup) {
      try {
        this.value = this.parse(backup)
        await mkdir(dirname(this.filePath), { recursive: true })
        await copyFile(backupPath, this.filePath)
        return this.value
      } catch (error) {
        if (!this.options.recoverInvalid) throw error
        await this.quarantine(backupPath)
      }
    }
    this.value = this.createDefault()
    return this.value
  }

  private parse(source: string): T {
    const value = JSON.parse(source) as unknown
    return this.options.parse ? this.options.parse(value) : (value as T)
  }

  private async quarantine(path: string): Promise<void> {
    await rename(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
  }

  private async persist(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    const backup = `${this.filePath}.bak`
    await writeFile(temporary, JSON.stringify(value, null, 2))
    const temporaryHandle = await open(temporary, 'r+')
    try {
      await temporaryHandle.sync()
    } finally {
      await temporaryHandle.close()
    }

    await rm(backup, { force: true })
    let previousMoved = false
    try {
      await rename(this.filePath, backup)
      previousMoved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rm(temporary, { force: true })
        throw error
      }
    }

    try {
      await rename(temporary, this.filePath)
    } catch (error) {
      if (previousMoved) {
        await rename(backup, this.filePath).catch(() => undefined)
      }
      await rm(temporary, { force: true })
      throw error
    }
    await rm(backup, { force: true })
  }
}
