import type { DocPageContent } from '../docs-content'

const page = {
  order: 1,
  slug: 'getting-started',
  title: 'Getting Started',
  description:
    'What FreeCut is, which host to use, and your first edit from launch to export.',
  category: 'Start',
  related: ['concepts', 'workspaces', 'export'],
  sections: [
    {
      title: 'What FreeCut is',
      blocks: [
        {
          kind: 'paragraph',
          text: 'FreeCut is a **local-first** video editor. The Web editor and Electron desktop app share the same editing UI; projects, linked media, preview, and export stay on your machine.',
        },
        {
          kind: 'note',
          tone: 'tip',
          text: 'The Electron desktop app is required for the Local Agent Host, MCP tools, protected timeline writes, FFmpeg services, and safeStorage. Cloud Agent or ASR features send only the inputs needed for the task you start.',
        },
      ],
    },
    {
      title: 'Choose a host',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Use Electron for the complete product. Use a recent Chromium browser when you only need the Web editing workflow.',
        },
        {
          kind: 'table',
          headers: ['Browser', 'Status'],
          rows: [
            ['Electron desktop', 'Editing plus Local Agent, MCP, credentials, and local services'],
            ['Chrome / Edge 113+', 'Web editing; no Local Agent Host'],
            ['Brave', 'Web editing after enabling the File System Access API flag'],
            ['Safari / Firefox', 'Not yet supported for the full workflow'],
          ],
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'The Renderer uses the File System Access API, WebCodecs, WebGPU, and OPFS. Electron adds Main/Preload IPC and native local services. Keep hardware acceleration on and GPU drivers current.',
        },
        {
          kind: 'note',
          tone: 'warning',
          text: 'Brave may block folder access. Open `brave://flags/#file-system-access-api`, set it to **Enabled**, then relaunch Brave.',
        },
      ],
    },
    {
      title: 'Your first edit',
      blocks: [
        {
          kind: 'steps',
          items: [
            'Open the Electron desktop app for Agent work, or the Web editor for manual editing, then pick a **workspace folder** you can read and write.',
            'On the Projects page, choose **New Project** and set the resolution and frame rate for the edit.',
            'Open the **Media** tab and use **Import** to add files, or drag media straight into the library.',
            'Drag a clip from the Media panel onto a timeline track.',
            'Press `Space` to play, and use `Left` and `Right` to step one frame at a time.',
            'Save with `Ctrl+S` as you work, then choose **Export** to render the finished video.',
          ],
        },
      ],
    },
    {
      title: 'Confirm your setup works',
      blocks: [
        {
          kind: 'list',
          items: [
            'The workspace picker opens and accepts a normal folder (not a protected system location).',
            'Imported media appears as cards in the Media panel with thumbnails.',
            'Playback starts from the timeline when you press `Space`.',
            'Export opens and the preflight check reports no blocking problems.',
          ],
        },
        {
          kind: 'note',
          tone: 'tip',
          text: 'If any step fails, see the **Troubleshooting** page for the matching symptom.',
        },
      ],
    },
  ],
} satisfies DocPageContent

export default page
