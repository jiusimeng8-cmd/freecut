import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { FreeCutBridgeRunner } from '@/features/editor/components/freecut-bridge-runner'
import { getEditorProjectIdFromPathname } from '@/shared/projects/last-editor-project'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const projectId = getEditorProjectIdFromPathname(pathname) ?? null

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const detail = (event as CustomEvent<
        { to: 'projects' } | { to: 'editor'; projectId: string }
      >).detail
      if (detail.to === 'projects') {
        void navigate({ to: '/projects' })
      } else {
        void navigate({
          to: '/editor/$projectId',
          params: { projectId: detail.projectId },
        })
      }
    }
    window.addEventListener('freecut:navigate', handleNavigate)
    return () => window.removeEventListener('freecut:navigate', handleNavigate)
  }, [navigate])

  return (
    <>
      <FreeCutBridgeRunner projectId={projectId} />
      <Outlet />
    </>
  )
}
