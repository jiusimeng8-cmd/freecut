# shared/state

Cross-feature Zustand stores.

The home for any store consumed by more than one feature. Includes
shell-level UI state, transport state, and workflow stores that
coordinate multi-step interactions across features (dialogs that one
feature opens while another renders).

Current modules:

- `selection`: cross-feature clip/track/marker selection and active tool state
- `clipboard`: transition and item clipboard data for copy/paste
- `playback`: global transport/playhead state for preview and timeline
- `preview-bridge`: preview presentation state (displayed overlay frame, frame capture hooks)
- `source-player`: source monitor/player interaction state (in/out points, hover target)
- `editor`: editor shell UI state (panels, sidebar sizing, source monitor)
- `clear-keyframes-dialog`: workflow state for bulk keyframe deletion
- `project-media-match-dialog`: workflow state for reconciling project/media metadata
- `tts-generate-dialog`: workflow state for the editor TTS generation dialog
- `mixer-live-gain`, `transition-drag`: misc shared state
