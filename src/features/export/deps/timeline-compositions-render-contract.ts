/**
 * Cross-feature contract for the frame renderer's composition dependencies.
 *
 * Keep this surface limited to the store and pure composition graph helpers;
 * editor-facing composition adapters must not enter the export Worker graph.
 */

export { useCompositionsStore } from '@/features/timeline/stores/compositions-store'
export type { SubComposition } from '@/features/timeline/stores/compositions-store'
export {
  collectReachableCompositionIdsFromItems,
  collectReachableCompositionIdsFromTracks,
} from '@/features/timeline/utils/composition-graph'
