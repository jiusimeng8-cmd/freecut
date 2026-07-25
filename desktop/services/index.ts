export { CredentialStore } from './credential-store'
export {
  DashScopeAsrService,
  type DashScopeAsrInput,
  type DashScopeAsrResumeInput,
  type DashScopeAsrRunOptions,
  type DashScopeAsrSubmission,
} from './dashscope-asr-service'
export { CloudBridgeService } from './cloud-bridge-service'
export { DiagnosticsService } from './diagnostics-service'
export { FfmpegService, type FfmpegPaths } from './ffmpeg-service'
export {
  LocalAgentHostService,
  type AgentTurnRequest,
  type AgentTurnToolDescriptor,
  type AgentTurnTransport,
  type LocalAgentHostRunInput,
  type LocalAgentHostRunResult,
  type LocalAgentHostServiceOptions,
} from './local-agent-host-service'
export {
  TaskRepository,
  type DesktopTask,
  type DesktopTaskKind,
  type DesktopTaskStatus,
} from './task-repository'
export { TranscriptionTaskService } from './transcription-task-service'
export {
  UpdateNotificationService,
  type DesktopReleaseNotification,
} from './update-notification-service'
