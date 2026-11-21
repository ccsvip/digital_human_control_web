import { describe, expect, it } from 'vitest';
import {
  buildRoutePoints,
  buildWebSocketUrl,
  createDeviceAction,
  getCurrentTasks,
  parseFlowSnapshot,
  taskDisplayName,
} from './protocol';
import { DEFAULT_CONFIG } from './useController';

function makeMessage() {
  return {
    type: 'device.task_flow.state',
    id: 'screen-state-101',
    payload: {
      deviceCode: 'Device-A',
      deviceInfo: {
        deviceName: '展厅数字人',
        robotConnected: true,
        robotIp: '192.168.1.100',
        robotBatteryPercent: 80,
        robotCharging: false,
        robotNormal: true,
        robotErrorMessage: '',
      },
      command: {
        commandType: 'task',
        name: '展厅导览',
        tasks: [
          {
            type: 'navigation',
            step_id: 501,
            is_show: true,
            content: { pointName: '序厅', command: 'lobby' },
            inner_tasks: [
              { type: 'text', content: { text: '欢迎来到序厅' } },
              { type: 'video', content: { name: '企业介绍视频' } },
            ],
          },
          { type: 'text', content: { text: '展厅简介' } },
          {
            type: 'navigation',
            step_id: 502,
            is_show: false,
            content: { pointName: '内部通道', command: 'internal' },
          },
          {
            type: 'navigation',
            step_id: 503,
            is_show: true,
            content: { pointName: '创新中心', command: 'innovation' },
          },
          {
            type: 'navigation',
            step_id: 504,
            is_show: true,
            content: { pointName: '服务台', command: 'service' },
          },
        ],
      },
      taskState: {
        taskIndex: 3 as number | string | null,
        status: 'IN_PROGRESS',
        innerTaskIndex: -1 as number | string | null,
        innerTaskStatus: null as string | null,
      },
      buttons: {
        pauseTask: true,
        resumeTask: false,
        endTask: true,
        skipCurrentTask: true,
        startDialogue: false,
        endDialogue: false,
        interruptDialogue: false,
        stopNavigation: true,
        shutdownRobot: true,
        endRecording: false,
      },
    },
  };
}

describe('parseFlowSnapshot', () => {
  it('按原始根任务索引解析当前任务和完整设备信息', () => {
    const snapshot = parseFlowSnapshot(makeMessage());
    expect(snapshot.deviceInfo.deviceName).toBe('展厅数字人');
    expect(snapshot.command?.tasks).toHaveLength(5);
    expect(snapshot.taskState.taskIndex).toBe(3);
    expect(taskDisplayName(getCurrentTasks(snapshot).task)).toBe('创新中心');
  });

  it('主任务和子任务状态分别定位，不自动推进主任务', () => {
    const message = makeMessage();
    message.payload.taskState = {
      taskIndex: 0,
      status: 'TASK_COMPLETED',
      innerTaskIndex: 1,
      innerTaskStatus: 'IN_PROGRESS',
    };
    const snapshot = parseFlowSnapshot(message);
    const current = getCurrentTasks(snapshot);
    expect(taskDisplayName(current.task)).toBe('序厅');
    expect(taskDisplayName(current.innerTask)).toBe('企业介绍视频');
    expect(snapshot.taskState.status).toBe('TASK_COMPLETED');
    expect(snapshot.taskState.innerTaskStatus).toBe('IN_PROGRESS');
  });

  it('拒绝数字字符串索引，避免隐式转换造成错位', () => {
    const message = makeMessage();
    message.payload.taskState.taskIndex = '3';
    expect(() => parseFlowSnapshot(message)).toThrow('主任务索引无效');
  });

  it('拒绝超出原始任务数组的索引', () => {
    const message = makeMessage();
    message.payload.taskState.taskIndex = 5;
    expect(() => parseFlowSnapshot(message)).toThrow('主任务索引超出任务数组范围');
  });

  it('无主任务时要求 IDLE 且没有子任务状态', () => {
    const message = makeMessage();
    message.payload.taskState = {
      taskIndex: null,
      status: 'IN_PROGRESS',
      innerTaskIndex: -1,
      innerTaskStatus: null,
    };
    expect(() => parseFlowSnapshot(message)).toThrow('无主任务时状态必须为 IDLE');
    message.payload.taskState.status = 'IDLE';
    expect(parseFlowSnapshot(message).taskState.taskIndex).toBe(-1);
  });

  it('不会删除异常任务元素来继续解析', () => {
    const message = makeMessage();
    message.payload.command.tasks[1] = null as unknown as (typeof message.payload.command.tasks)[number];
    expect(() => parseFlowSnapshot(message)).toThrow('command.tasks[1] 必须是对象');
  });
});

describe('buildRoutePoints', () => {
  it('过滤隐藏和非导航节点，同时保留原始索引计算进度', () => {
    const snapshot = parseFlowSnapshot(makeMessage());
    const points = buildRoutePoints(snapshot, true);
    expect(points.map((point) => point.name)).toEqual(['序厅', '创新中心', '服务台']);
    expect(points.map((point) => point.rootIndex)).toEqual([0, 3, 4]);
    expect(points.map((point) => point.progress)).toEqual(['completed', 'active', 'pending']);
    expect(points[1].stepId).toBe(503);
    expect(points.every((point) => point.canNavigate)).toBe(true);
  });

  it('当前主任务为非导航或隐藏导航时可以没有当前圆点', () => {
    const message = makeMessage();
    message.payload.taskState.taskIndex = 1;
    const points = buildRoutePoints(parseFlowSnapshot(message), true);
    expect(points.map((point) => point.progress)).toEqual(['completed', 'pending', 'pending']);
  });

  it('向后跳转后按最新索引恢复后续待执行状态', () => {
    const message = makeMessage();
    message.payload.taskState.taskIndex = 0;
    const points = buildRoutePoints(parseFlowSnapshot(message), true);
    expect(points.map((point) => point.progress)).toEqual(['active', 'pending', 'pending']);
  });

  it('暂停状态禁用跳转，但保持当前导航点', () => {
    const message = makeMessage();
    message.payload.taskState.status = 'PAUSED';
    message.payload.buttons.pauseTask = false;
    message.payload.buttons.resumeTask = true;
    const points = buildRoutePoints(parseFlowSnapshot(message), true);
    expect(points[1].progress).toBe('active');
    expect(points.every((point) => !point.canNavigate)).toBe(true);
  });

  it('缺少关联点位时保留占位节点但不可点击', () => {
    const message = makeMessage();
    message.payload.command.tasks[3].content = { pointName: '', command: '' };
    const points = buildRoutePoints(parseFlowSnapshot(message), true);
    expect(points).toHaveLength(3);
    expect(points[1].canNavigate).toBe(false);
  });
});

describe('protocol writers', () => {
  it('将默认 HTTP 地址转换为 WebSocket 地址', () => {
    expect(buildWebSocketUrl(DEFAULT_CONFIG)).toBe('ws://192.168.3.248:8880/ws/realtime/');
    expect(buildWebSocketUrl({ server: 'https://example.com/controller', port: '443' })).toBe(
      'wss://example.com/controller',
    );
  });

  it('拒绝无效端口', () => {
    expect(() => buildWebSocketUrl({ server: '127.0.0.1', port: '70000' })).toThrow('端口');
  });

  it('所有动作携带平级字段，未使用参数显式为 null', () => {
    const action = createDeviceAction(' Device-A ', 'jumpToNavigationStep', { stepId: 503 });
    expect(action).toEqual({
      type: 'device.action',
      id: expect.stringMatching(/^web-/),
      payload: {
        deviceCode: 'Device-A',
        action: 'jumpToNavigationStep',
        stepId: 503,
        text: null,
        point: null,
        pointName: null,
      },
    });
  });
});
