import { describe, expect, it } from 'vitest'
import type { CloudBridgeTask } from './cloud-bridge-client'
import {
  CLOUD_COMMAND_CONTRACT_ID,
  CLOUD_COMMAND_VERSION,
} from './cloud-command-contract'
import { getCloudTaskProtocolError } from './cloud-task-protocol'

function task(overrides: Partial<CloudBridgeTask> = {}): CloudBridgeTask {
  return {
    id: 'task-1',
    projectId: 'project-1',
    projectName: 'Fixture',
    status: 'claimed',
    commandVersion: CLOUD_COMMAND_VERSION,
    commandContractId: CLOUD_COMMAND_CONTRACT_ID,
    attempt: 2,
    commands: [
      {
        sequence: 0,
        commandId: 'command-1',
        type: 'timeline.read_project',
        params: {},
      },
    ],
    ...overrides,
  }
}

describe('FreeCut cloud task protocol checks', () => {
  it('rejects a mismatched command contract before execution', () => {
    expect(
      getCloudTaskProtocolError(
        task({ commandContractId: 'freecut.timeline.commands.v1' }),
        'project-1',
      ),
    ).toEqual({
      code: 'UNSUPPORTED_COMMAND_CONTRACT',
      message:
        '任务命令合同为 freecut.timeline.commands.v1，本机仅支持 freecut.editor.commands.v3。',
    })
  })

  it('rejects a missing command version and a different project', () => {
    expect(getCloudTaskProtocolError(task({ commandVersion: undefined }), 'project-1')).toEqual({
      code: 'UNSUPPORTED_COMMAND_VERSION',
      message: '任务命令版本为 未声明，本机仅支持 3。',
    })
    expect(getCloudTaskProtocolError(task(), 'project-2')).toEqual({
      code: 'PROJECT_MISMATCH',
      message: '任务目标项目为 project-1，当前打开项目为 project-2。',
    })
  })
})
