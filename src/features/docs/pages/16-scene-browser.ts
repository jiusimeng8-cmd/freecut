import type { DocPageContent } from '../docs-content'

const page = {
  order: 16,
  slug: 'scene-browser',
  title: 'Scene Browser',
  description: 'Search existing scene captions by keyword and browse stored color palettes.',
  category: 'Creative Tools',
  related: ['media', 'source-monitor'],
  sections: [
    {
      title: 'Open the Scene Browser',
      blocks: [
        {
          kind: 'list',
          items: [
            'Open the Scene Browser from the media library, or with `Ctrl+Shift+F`.',
            'It searches caption and scene data already stored in the workspace.',
            'Set the scope to all captioned media or a single clip, and sort by **Relevance**, **Timestamp**, or **Media name**.',
            'Switch between **List view** and **Grid view** to suit browsing or scanning.',
          ],
        },
      ],
    },
    {
      title: 'Search modes',
      blocks: [
        {
          kind: 'table',
          headers: ['Mode', 'Matches by'],
          rows: [
            ['Keyword', 'The exact words in a caption — good for a specific object or label.'],
            ['Color', 'A similar stored palette — pick a swatch from the library palette.'],
          ],
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'Results carry match badges — Strong, Good, or Fair — and note whether the match was by keyword or color.',
        },
      ],
    },
    {
      title: 'Use a result',
      blocks: [
        {
          kind: 'list',
          items: [
            'Click a scene to preview it in the source monitor.',
            'Drag a scene to the timeline to add that moment to your edit.',
            'If nothing is found, confirm the workspace already contains captions or scene data for that clip.',
          ],
        },
      ],
    },
  ],
} satisfies DocPageContent

export default page
