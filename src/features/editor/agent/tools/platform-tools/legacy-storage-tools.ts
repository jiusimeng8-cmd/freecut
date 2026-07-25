import { z } from 'zod'
import {
  deleteLegacyIDB,
  getMigrationErrors,
  getMigrationStatus,
  hasLegacyData,
  migrateFromLegacyIDB,
} from '@/infrastructure/storage/legacy-idb'
import { definePlatformTool, objectSchema } from './shared'

const readLegacyStorage = definePlatformTool({
  name: 'read_legacy_storage',
  requiresProject: false,
  title: 'Read legacy storage',
  description:
    'Read whether legacy IndexedDB data exists, its workspace migration status, and persisted migration errors.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'Read FreeCut legacy storage',
  execute: async () => {
    const [hasData, status, errors] = await Promise.all([
      hasLegacyData(),
      getMigrationStatus(),
      getMigrationErrors(),
    ])
    return {
      ok: true,
      message: hasData
        ? 'Legacy FreeCut storage is available for migration.'
        : 'No legacy FreeCut project data was found.',
      data: { hasLegacyData: hasData, status, errors },
    }
  },
})

const manageLegacyStorage = definePlatformTool({
  name: 'manage_legacy_storage',
  requiresProject: false,
  title: 'Manage legacy storage',
  description:
    'Migrate legacy IndexedDB data into the active workspace or permanently delete the legacy database.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['migrate', 'delete'] },
    },
    ['operation'],
  ),
  destructive: true,
  schema: z.object({
    operation: z.enum(['migrate', 'delete']),
  }),
  summarize: ({ operation }) => `${operation} FreeCut legacy storage`,
  execute: async ({ operation }) => {
    if (operation === 'delete') {
      await deleteLegacyIDB()
      return {
        ok: true,
        message: 'Deleted the legacy FreeCut IndexedDB database.',
        data: { operation },
        changed: true,
      }
    }

    try {
      const report = await migrateFromLegacyIDB()
      const status = await getMigrationStatus()
      if (report.errors.length > 0) {
        return {
          ok: false,
          message: `Legacy storage migration completed with ${report.errors.length} error${report.errors.length === 1 ? '' : 's'}.`,
          data: { report, errors: report.errors, status },
          error: {
            code: 'LEGACY_MIGRATION_PARTIAL',
            message: 'One or more legacy storage records could not be migrated.',
            retryable: true,
          },
          changed: true,
        }
      }
      return {
        ok: true,
        message: `Migrated ${report.projects} project${report.projects === 1 ? '' : 's'} and ${report.media} media item${report.media === 1 ? '' : 's'} from legacy storage.`,
        data: { report, errors: report.errors, status },
        changed: true,
      }
    } catch (error) {
      const [status, errors] = await Promise.all([getMigrationStatus(), getMigrationErrors()])
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        message: 'Legacy storage migration failed.',
        data: { report: null, errors, status },
        error: {
          code: 'LEGACY_MIGRATION_FAILED',
          message,
          retryable: true,
        },
      }
    }
  },
})

export const LEGACY_STORAGE_PLATFORM_TOOLS = [readLegacyStorage, manageLegacyStorage] as const
