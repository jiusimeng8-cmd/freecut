/**
 * Adapter exports for projects dependencies.
 * Editor modules should import projects stores/services from here.
 */

export { useProjectStore } from '@/features/projects/stores/project-store'
export {
  createProject as createProjectRecord,
  getAllProjects,
  getProject,
  getProjectMediaIds,
  listTrashedProjects,
} from '@/infrastructure/storage'
export { createProjectUpgradeBackup } from '@/features/projects/services/project-upgrade-service'
export {
  createProjectObject,
  formatProjectUpgradeBackupName,
} from '@/features/projects/utils/project-helpers'
export {
  formatFpsValue,
  isAllowedProjectFps,
  resolveAutoMatchProjectFps,
} from '@/features/projects/utils/project-fps'
export { commitProjectMetadataChange } from '@/features/editor/utils/project-metadata-history'
