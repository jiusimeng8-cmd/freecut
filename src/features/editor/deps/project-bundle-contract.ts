/**
 * Adapter exports for project-bundle dependencies.
 * Editor modules should import project-bundle modules from here.
 */

export type { FixtureType } from '@/features/project-bundle/services/test-fixtures'

export const importBundleExportDialog = () =>
  import('@/features/project-bundle/components/bundle-export-dialog')
export const importTestFixtures = () => import('@/features/project-bundle/services/test-fixtures')
export const importJsonExportService = () =>
  import('@/features/project-bundle/services/json-export-service')
export const importJsonImportService = () =>
  import('@/features/project-bundle/services/json-import-service')
export const importBundleExportService = () =>
  import('@/features/project-bundle/services/bundle-export-service')
export const importBundleImportService = () =>
  import('@/features/project-bundle/services/bundle-import-service')
