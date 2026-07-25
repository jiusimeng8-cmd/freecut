import type { CloudBridgeTask } from './cloud-bridge-client'
import {
  CLOUD_COMMAND_CONTRACT_ID,
  CLOUD_COMMAND_VERSION,
} from './cloud-command-contract'

export function getCloudTaskProtocolError(
  task: CloudBridgeTask,
  projectId: string,
): { code: string; message: string } | null {
  return task.commandVersion !== CLOUD_COMMAND_VERSION
    ? {
        code: 'UNSUPPORTED_COMMAND_VERSION',
        message: `任务命令版本为 ${task.commandVersion ?? '未声明'}，本机仅支持 ${CLOUD_COMMAND_VERSION}。`,
      }
    : task.commandContractId !== CLOUD_COMMAND_CONTRACT_ID
      ? {
          code: 'UNSUPPORTED_COMMAND_CONTRACT',
          message: `任务命令合同为 ${task.commandContractId ?? '未声明'}，本机仅支持 ${CLOUD_COMMAND_CONTRACT_ID}。`,
        }
      : !task.projectId
        ? {
            code: 'PROJECT_REQUIRED',
            message: '云端任务未声明目标 projectId。',
          }
        : task.projectId !== projectId
          ? {
              code: 'PROJECT_MISMATCH',
              message: `任务目标项目为 ${task.projectId}，当前打开项目为 ${projectId}。`,
            }
          : null
}
