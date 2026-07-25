import { safeStorage } from 'electron'
import { z } from 'zod'
import { SerializedJsonFile } from './serialized-json-file'

type CredentialDocument = Record<string, string>
const credentialDocumentSchema = z.record(z.string(), z.string())

export class CredentialStore {
  private readonly file: SerializedJsonFile<CredentialDocument>

  constructor(filePath: string) {
    this.file = new SerializedJsonFile(filePath, () => ({}), {
      parse: (value) => credentialDocumentSchema.parse(value),
      recoverInvalid: true,
    })
  }

  async get(key: string): Promise<string | null> {
    const encrypted = (await this.file.read())[key]
    if (!encrypted) return null
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.')
    }
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }

  async has(key: string): Promise<boolean> {
    return Boolean((await this.file.read())[key])
  }

  async set(key: string, value: string): Promise<void> {
    await this.setMany({ [key]: value })
  }

  async setMany(values: Record<string, string>): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.')
    }
    const encrypted = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        safeStorage.encryptString(value).toString('base64'),
      ]),
    )
    await this.file.update((document) => ({ ...document, ...encrypted }))
  }

  async delete(key: string): Promise<void> {
    await this.deleteMany([key])
  }

  async deleteMany(keys: string[]): Promise<void> {
    await this.file.update((document) => {
      const next = { ...document }
      for (const key of keys) delete next[key]
      return next
    })
  }
}
