import { getEditorProjectIdFromPathname } from '@/shared/projects/last-editor-project'

export async function installDesktopUpdateSafely(): Promise<void> {
  const desktop = window.freecutDesktop
  if (!desktop) return

  const projectId = getEditorProjectIdFromPathname(window.location.pathname)
  if (projectId) {
    const { useTimelineStore } = await import('@/features/timeline/stores/timeline-store-facade')
    await useTimelineStore.getState().saveTimeline(projectId)
  }
  await desktop.updates.install()
}
