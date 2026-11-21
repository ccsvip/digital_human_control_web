export const BUTTON_KEYS = [
  'pauseTask',
  'resumeTask',
  'endTask',
  'skipCurrentTask',
  'startDialogue',
  'endDialogue',
  'interruptDialogue',
  'stopNavigation',
  'shutdownRobot',
  'endRecording',
] as const;

export type ButtonKey = (typeof BUTTON_KEYS)[number];
export type ActionName =
  | ButtonKey
  | 'jumpToNavigationStep'
  | 'textQuestion'
  | 'navigateToPoint'
  | 'getState';

export interface ConnectionConfig {
  server: string;
  port: string;
  deviceCode: string;
}

export interface DeviceInfo {
  deviceName: string;
  robotConnected: boolean;
  robotIp: string | null;
  robotBatteryPercent: number | null;
  robotCharging: boolean | null;
  robotNormal: boolean;
  robotErrorMessage: string;
}

export interface TaskNode {
  type: string;
  content: Record<string, unknown>;
  inner_tasks?: TaskNode[];
  step_id?: number;
  is_show?: boolean;
  [key: string]: unknown;
}

export interface TaskCommand {
  name: string;
  tasks: TaskNode[];
  [key: string]: unknown;
}

export interface TaskState {
  taskIndex: number;
  status: string;
  innerTaskIndex: number;
  innerTaskStatus: string | null;
}

export interface FlowSnapshot {
  deviceCode: string;
  deviceInfo: DeviceInfo;
  command: TaskCommand | null;
  taskState: TaskState;
  buttons: Record<ButtonKey, boolean>;
}

export interface ActionParams {
  stepId?: number | null;
  text?: string | null;
  point?: string | null;
  pointName?: string | null;
}

export interface DeviceAction {
  type: 'device.action';
  id: string;
  payload: {
    deviceCode: string;
    action: ActionName;
    stepId: number | null;
    text: string | null;
    point: string | null;
    pointName: string | null;
  };
}

export type RouteProgress = 'completed' | 'active' | 'pending';

export interface RoutePoint {
  key: string;
  name: string;
  rootIndex: number;
  stepId: number;
  point: string;
  pointName: string;
  progress: RouteProgress;
  canNavigate: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  IDLE: '空闲',
  NOT_STARTED: '尚未开始',
  PREPARING: '正在准备',
  IN_PROGRESS: '正在执行',
  PAUSED: '已暂停',
  TASK_COMPLETED: '动作完成，等待后续',
  WAITING: '等待中',
  COMPLETED: '已完成',
  SKIPPED: '已跳过',
};

const TASK_TYPE_LABELS: Record<string, string> = {
  navigation: '导航',
  text: '讲解',
  image: '图片',
  video: '视频',
  command: '指令',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
  return value;
}

function normalizeIndex(value: unknown, label: string): number {
  if (value === null || value === -1) return -1;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new Error(`${label}索引无效`);
  }
  return value;
}

function parseTask(value: unknown, path: string): TaskNode {
  const task = requiredRecord(value, path);
  let innerTasks: TaskNode[] | undefined;
  if (task.inner_tasks !== undefined && task.inner_tasks !== null) {
    if (!Array.isArray(task.inner_tasks)) throw new Error(`${path}.inner_tasks 必须是数组`);
    innerTasks = task.inner_tasks.map((inner, index) =>
      parseTask(inner, `${path}.inner_tasks[${index}]`),
    );
  }

  return {
    ...task,
    type: typeof task.type === 'string' ? task.type : '',
    content: isRecord(task.content) ? task.content : {},
    ...(innerTasks ? { inner_tasks: innerTasks } : {}),
    ...(typeof task.step_id === 'number' ? { step_id: task.step_id } : {}),
    ...(typeof task.is_show === 'boolean' ? { is_show: task.is_show } : {}),
  } as TaskNode;
}

export function parseFlowSnapshot(message: unknown): FlowSnapshot {
  const root = requiredRecord(message, '状态消息');
  if (root.type !== 'device.task_flow.state') throw new Error('消息类型不是设备状态');
  const payload = requiredRecord(root.payload, 'payload');
  if (!('command' in payload)) throw new Error('payload 缺少 command 字段');

  const rawInfo = requiredRecord(payload.deviceInfo, 'deviceInfo');
  const battery = rawInfo.robotBatteryPercent;
  if (
    battery !== null &&
    (typeof battery !== 'number' || !Number.isInteger(battery) || battery < 0 || battery > 100)
  ) {
    throw new Error('robotBatteryPercent 必须是 0–100 的整数或 null');
  }
  if (rawInfo.robotIp !== null && typeof rawInfo.robotIp !== 'string') {
    throw new Error('robotIp 必须是字符串或 null');
  }
  if (rawInfo.robotCharging !== null && typeof rawInfo.robotCharging !== 'boolean') {
    throw new Error('robotCharging 必须是布尔值或 null');
  }
  if (typeof rawInfo.deviceName !== 'string') throw new Error('deviceName 必须是字符串');
  if (typeof rawInfo.robotErrorMessage !== 'string') {
    throw new Error('robotErrorMessage 必须是字符串');
  }

  const deviceInfo: DeviceInfo = {
    deviceName: rawInfo.deviceName,
    robotConnected: requiredBoolean(rawInfo.robotConnected, 'robotConnected'),
    robotIp: rawInfo.robotIp as string | null,
    robotBatteryPercent: battery as number | null,
    robotCharging: rawInfo.robotCharging as boolean | null,
    robotNormal: requiredBoolean(rawInfo.robotNormal, 'robotNormal'),
    robotErrorMessage: rawInfo.robotErrorMessage,
  };

  let command: TaskCommand | null = null;
  if (payload.command !== null) {
    const rawCommand = requiredRecord(payload.command, 'command');
    if (!Array.isArray(rawCommand.tasks)) throw new Error('command.tasks 必须是数组');
    command = {
      ...rawCommand,
      name: typeof rawCommand.name === 'string' && rawCommand.name.trim() ? rawCommand.name : '未命名流程',
      tasks: rawCommand.tasks.map((task, index) => parseTask(task, `command.tasks[${index}]`)),
    };
  }

  const rawState = requiredRecord(payload.taskState, 'taskState');
  for (const key of ['taskIndex', 'status', 'innerTaskIndex', 'innerTaskStatus']) {
    if (!(key in rawState)) throw new Error(`taskState 缺少 ${key} 字段`);
  }
  if (typeof rawState.status !== 'string') throw new Error('主任务状态必须是字符串');
  if (rawState.innerTaskStatus !== null && typeof rawState.innerTaskStatus !== 'string') {
    throw new Error('子任务状态必须是字符串或 null');
  }

  const taskIndex = normalizeIndex(rawState.taskIndex, '主任务');
  const innerTaskIndex = normalizeIndex(rawState.innerTaskIndex, '子任务');
  const hasTask = taskIndex >= 0;
  const hasInnerTask = innerTaskIndex >= 0;

  if (!hasTask) {
    if (rawState.status !== 'IDLE') throw new Error('无主任务时状态必须为 IDLE');
    if (hasInnerTask) throw new Error('无主任务时不能存在当前子任务');
  } else {
    if (!command) throw new Error('有当前任务时 command 不能为 null');
    if (taskIndex >= command.tasks.length) throw new Error('主任务索引超出任务数组范围');
    if (rawState.status === 'IDLE') throw new Error('有主任务时状态不能为 IDLE');
  }

  if (!hasInnerTask) {
    if (rawState.innerTaskStatus !== null) throw new Error('无当前子任务时子状态必须为 null');
  } else {
    if (!hasTask || !command) throw new Error('有子任务时必须先有主任务');
    const inners = command.tasks[taskIndex].inner_tasks ?? [];
    if (innerTaskIndex >= inners.length) throw new Error('子任务索引超出子任务数组范围');
    if (typeof rawState.innerTaskStatus !== 'string') throw new Error('当前子任务缺少状态');
  }

  const rawButtons = requiredRecord(payload.buttons, 'buttons');
  const buttons = {} as Record<ButtonKey, boolean>;
  for (const key of BUTTON_KEYS) {
    buttons[key] = requiredBoolean(rawButtons[key], `buttons.${key}`);
  }

  return {
    deviceCode: typeof payload.deviceCode === 'string' ? payload.deviceCode : '',
    deviceInfo,
    command,
    taskState: {
      taskIndex,
      status: rawState.status,
      innerTaskIndex,
      innerTaskStatus: rawState.innerTaskStatus as string | null,
    },
    buttons,
  };
}

export function buildWebSocketUrl(config: Pick<ConnectionConfig, 'server' | 'port'>): string {
  const server = config.server.trim();
  const port = Number(config.port);
  if (!server) throw new Error('请输入服务器地址');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数');

  let url: URL;
  try {
    url = new URL(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(server) ? server : `http://${server}`);
  } catch {
    throw new Error('服务器地址格式无效');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('服务器地址仅支持 HTTP(S) 或 WebSocket 协议');
  }
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.port = String(port);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/ws/realtime/';
  }
  url.hash = '';
  return url.toString();
}

export function createDeviceAction(
  deviceCode: string,
  action: ActionName,
  params: ActionParams = {},
): DeviceAction {
  const code = deviceCode.trim();
  if (!code) throw new Error('设备号不能为空');
  const randomPart = Math.random().toString(36).slice(2, 9);
  return {
    type: 'device.action',
    id: `web-${Date.now().toString(36)}-${randomPart}`,
    payload: {
      deviceCode: code,
      action,
      stepId: params.stepId ?? null,
      text: params.text ?? null,
      point: params.point ?? null,
      pointName: params.pointName ?? null,
    },
  };
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '无';
  return STATUS_LABELS[status] ?? status;
}

export function taskDisplayName(task: TaskNode | null | undefined): string {
  if (!task) return '无';
  const content = task.content ?? {};
  if (task.type === 'navigation') {
    return typeof content.pointName === 'string' && content.pointName.trim()
      ? content.pointName
      : '未关联导航点位';
  }
  if (task.type === 'text') {
    return typeof content.text === 'string' && content.text.trim() ? content.text : '空讲解';
  }
  if (['image', 'video', 'command'].includes(task.type)) {
    return typeof content.name === 'string' && content.name.trim() ? content.name : '未关联资源';
  }
  return `未知步骤：${task.type || '未提供类型'}`;
}

export function taskTypeLabel(task: TaskNode | null | undefined): string {
  if (!task) return '任务';
  return TASK_TYPE_LABELS[task.type] ?? '步骤';
}

export function getCurrentTasks(snapshot: FlowSnapshot | null) {
  if (!snapshot?.command || snapshot.taskState.taskIndex < 0) {
    return { task: null, innerTask: null };
  }
  const task = snapshot.command.tasks[snapshot.taskState.taskIndex] ?? null;
  const innerTask =
    task && snapshot.taskState.innerTaskIndex >= 0
      ? (task.inner_tasks?.[snapshot.taskState.innerTaskIndex] ?? null)
      : null;
  return { task, innerTask };
}

export function buildRoutePoints(snapshot: FlowSnapshot | null, canControl: boolean): RoutePoint[] {
  if (!snapshot?.command) return [];
  const currentIndex = snapshot.taskState.taskIndex;
  return snapshot.command.tasks.flatMap((task, rootIndex) => {
    if (
      task.type !== 'navigation' ||
      task.is_show === false ||
      typeof task.step_id !== 'number' ||
      !Number.isInteger(task.step_id) ||
      task.step_id <= 0
    ) {
      return [];
    }
    const point = typeof task.content.command === 'string' ? task.content.command.trim() : '';
    const pointName = typeof task.content.pointName === 'string' ? task.content.pointName.trim() : '';
    const progress: RouteProgress =
      currentIndex >= 0 && rootIndex < currentIndex
        ? 'completed'
        : rootIndex === currentIndex
          ? 'active'
          : 'pending';
    return [
      {
        key: `step:${task.step_id}`,
        name: taskDisplayName(task),
        rootIndex,
        stepId: task.step_id,
        point,
        pointName,
        progress,
        canNavigate: Boolean(canControl && snapshot.buttons.pauseTask && point && pointName),
      },
    ];
  });
}
