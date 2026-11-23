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

/**
 * 直达导航点位：从当前任务树中提取所有导航节点（不限 is_show）的点位信息。
 * 与轨迹预览不同，直达导航不要求 is_show 或 step_id 有效，只要 content.command 和 content.pointName 均非空即可。
 */
export interface DirectPoint {
  key: string;
  point: string;
  pointName: string;
  rootIndex: number;
  /** 是否为当前正在执行的主任务 */
  isActive: boolean;
}

export function buildDirectPoints(snapshot: FlowSnapshot | null): DirectPoint[] {
  if (!snapshot?.command) return [];
  const currentIndex = snapshot.taskState.taskIndex;
  const seen = new Set<string>();
  return snapshot.command.tasks.flatMap((task, rootIndex) => {
    if (task.type !== 'navigation') return [];
    const point = typeof task.content.command === 'string' ? task.content.command.trim() : '';
    const pointName = typeof task.content.pointName === 'string' ? task.content.pointName.trim() : '';
    if (!point || !pointName) return [];
    const key = `${point}:${pointName}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        point,
        pointName,
        rootIndex,
        isActive: rootIndex === currentIndex,
      },
    ];
  });
}

// ===================== 点位分组与任务模式读取协议 =====================

/** 点位信息 */
export interface PointItem {
  id: number;
  groupId: number;
  groupName: string;
  name: string;
  command: string;
  isActive: boolean;
  isShow: boolean;
  isChargingPile: boolean;
  isUiVisible: boolean;
  sortOrder: number;
}

/** 点位分组 */
export interface PointGroup {
  id: number;
  name: string;
  pointCount: number;
  points: PointItem[];
}

/** 任务模式分类 */
export interface TaskModes {
  guide: string[];
  explain: string[];
  unassigned: string[];
}

/** 点位分组请求 */
export interface PointGroupRequest {
  type: 'device.point_group.get';
  id: string;
  payload: { deviceCode: string };
}

/** 任务模式请求 */
export interface TaskModeRequest {
  type: 'device.task_mode.get';
  id: string;
  payload: { deviceCode: string };
}

/** 错误响应 */
export interface ErrorResponse {
  type: 'error';
  id: string | null;
  error: { code: string; message: string };
}

export function createPointGroupRequest(deviceCode: string, id?: string): PointGroupRequest {
  const code = deviceCode.trim();
  if (!code) throw new Error('设备号不能为空');
  return {
    type: 'device.point_group.get',
    id: id ?? `web-pg-${Date.now().toString(36)}`,
    payload: { deviceCode: code },
  };
}

export function createTaskModeRequest(deviceCode: string, id?: string): TaskModeRequest {
  const code = deviceCode.trim();
  if (!code) throw new Error('设备号不能为空');
  const reqId = id?.trim();
  if (!reqId) throw new Error('任务模式请求 id 不能为空');
  return {
    type: 'device.task_mode.get',
    id: reqId,
    payload: { deviceCode: code },
  };
}

function parsePointItem(value: unknown, path: string): PointItem {
  const obj = requiredRecord(value, path);
  return {
    id: typeof obj.id === 'number' ? obj.id : 0,
    groupId: typeof obj.groupId === 'number' ? obj.groupId : 0,
    groupName: typeof obj.groupName === 'string' ? obj.groupName : '',
    name: typeof obj.name === 'string' ? obj.name : '',
    command: typeof obj.command === 'string' ? obj.command : '',
    isActive: requiredBoolean(obj.isActive, `${path}.isActive`),
    isShow: requiredBoolean(obj.isShow, `${path}.isShow`),
    isChargingPile: requiredBoolean(obj.isChargingPile, `${path}.isChargingPile`),
    isUiVisible: requiredBoolean(obj.isUiVisible, `${path}.isUiVisible`),
    sortOrder: typeof obj.sortOrder === 'number' ? obj.sortOrder : 0,
  };
}

export function parsePointGroup(message: unknown): { deviceCode: string; pointGroup: PointGroup | null } {
  const root = requiredRecord(message, '点位分组消息');
  if (root.type !== 'device.point_group') throw new Error('消息类型不是点位分组');
  const payload = requiredRecord(root.payload, 'payload');
  const deviceCode = typeof payload.deviceCode === 'string' ? payload.deviceCode : '';
  if (payload.pointGroup === null) return { deviceCode, pointGroup: null };
  const raw = requiredRecord(payload.pointGroup, 'pointGroup');
  if (!Array.isArray(raw.points)) throw new Error('pointGroup.points 必须是数组');
  const points = raw.points.map((p, i) => parsePointItem(p, `pointGroup.points[${i}]`));
  return {
    deviceCode,
    pointGroup: {
      id: typeof raw.id === 'number' ? raw.id : 0,
      name: typeof raw.name === 'string' ? raw.name : '',
      pointCount: typeof raw.pointCount === 'number' ? raw.pointCount : points.length,
      points,
    },
  };
}

export function parseTaskModes(message: unknown): { deviceCode: string; modes: TaskModes } {
  const root = requiredRecord(message, '任务模式消息');
  if (root.type !== 'device.task_mode') throw new Error('消息类型不是任务模式');
  const payload = requiredRecord(root.payload, 'payload');
  const deviceCode = typeof payload.deviceCode === 'string' ? payload.deviceCode : '';
  const rawModes = requiredRecord(payload.modes, 'modes');
  const extract = (key: string): string[] => {
    const arr = rawModes[key];
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === 'string');
  };
  return {
    deviceCode,
    modes: {
      guide: extract('guide'),
      explain: extract('explain'),
      unassigned: extract('unassigned'),
    },
  };
}

export function isErrorResponse(message: unknown): message is ErrorResponse {
  if (!isRecord(message)) return false;
  return message.type === 'error' && isRecord(message.error);
}

// ===================== 音色绑定协议 =====================

/** 音色信息 */
export interface VoiceTone {
  id: number;
  displayName: string;
  voiceCode: string;
  audioUrl: string;
  iconUrl: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  customTestText: string;
  gender: string;
  isDefault: boolean;
}

/** 音色列表响应（GET /ai-models/tts/options/） */
export interface TtsOptionsResponse {
  voices: VoiceTone[];
  defaultVoiceId: number | null;
}

/** 音色绑定请求 */
export interface VoiceBindRequest {
  type: 'device.voice.bind';
  id: string;
  payload: {
    deviceCode: string;
    voice: {
      id: number;
      name: string;
      voiceCode: string;
    };
  };
}

/** 音色绑定成功回执 */
export interface VoiceBoundMessage {
  type: 'device.voice.bound';
  id: string;
  payload: {
    deviceCode: string;
    voice: {
      id: number;
      name: string;
      voiceCode: string;
    };
  };
}

export function buildHttpBaseUrl(config: Pick<ConnectionConfig, 'server' | 'port'>): string {
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
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('服务器地址仅支持 HTTP(S) 协议');
  }
  url.port = String(port);
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function buildTtsOptionsUrl(config: Pick<ConnectionConfig, 'server' | 'port'>): string {
  return `${buildHttpBaseUrl(config)}/api/v1/ai-models/tts/options/`;
}

export function buildTtsRuntimeUrl(config: Pick<ConnectionConfig, 'server' | 'port'>): string {
  return `${buildHttpBaseUrl(config)}/api/v1/ai-models/tts/runtime/`;
}

export function buildDeviceRuntimeConfigUrl(config: Pick<ConnectionConfig, 'server' | 'port'>): string {
  return `${buildHttpBaseUrl(config)}/api/v1/device-runtime/config/`;
}

export function createVoiceBindRequest(deviceCode: string, voice: VoiceTone, id?: string): VoiceBindRequest {
  const code = deviceCode.trim();
  if (!code) throw new Error('设备号不能为空');
  return {
    type: 'device.voice.bind',
    id: id ?? `web-voice-bind-${Date.now().toString(36)}`,
    payload: {
      deviceCode: code,
      voice: {
        id: voice.id,
        name: voice.displayName,
        voiceCode: voice.voiceCode,
      },
    },
  };
}

function parseVoiceTone(value: unknown, path: string): VoiceTone {
  const obj = requiredRecord(value, path);
  return {
    id: typeof obj.id === 'number' ? obj.id : 0,
    displayName: typeof obj.displayName === 'string' ? obj.displayName : (typeof obj.name === 'string' ? obj.name : ''),
    voiceCode: typeof obj.voiceCode === 'string' ? obj.voiceCode : '',
    audioUrl: typeof obj.audioUrl === 'string' ? obj.audioUrl : '',
    iconUrl: typeof obj.iconUrl === 'string' ? obj.iconUrl : (typeof obj.avatarPath === 'string' ? obj.avatarPath : ''),
    speechRate: typeof obj.speechRate === 'number' ? obj.speechRate : 1,
    pitchRate: typeof obj.pitchRate === 'number' ? obj.pitchRate : 1,
    volume: typeof obj.volume === 'number' ? obj.volume : 50,
    customTestText: typeof obj.customTestText === 'string' ? obj.customTestText : '',
    gender: typeof obj.gender === 'string' ? obj.gender : '',
    isDefault: typeof obj.isDefault === 'boolean' ? obj.isDefault : false,
  };
}

export function parseTtsOptions(data: unknown): TtsOptionsResponse {
  const root = requiredRecord(data, 'TTS options');
  const rawVoices = root.voices ?? root.items ?? root.list;
  if (!Array.isArray(rawVoices)) throw new Error('音色列表必须是数组');
  const voices = rawVoices.map((v, i) => parseVoiceTone(v, `voices[${i}]`));
  const defaultVoice = voices.find((v) => v.isDefault);
  const defaultVoiceId = defaultVoice ? defaultVoice.id : (typeof root.defaultVoiceId === 'number' ? root.defaultVoiceId : null);
  return { voices, defaultVoiceId };
}

export function isVoiceBoundMessage(message: unknown): message is VoiceBoundMessage {
  if (!isRecord(message)) return false;
  return message.type === 'device.voice.bound' && isRecord(message.payload);
}

// ===================== 运行时配置（设备当前音色） =====================

/** 设备当前绑定的音色（来自运行时配置） */
export interface DeviceVoiceInfo {
  id: number;
  name: string;
  voiceCode: string;
}

export interface RuntimeConfigSubscribeRequest {
  type: 'device.runtime_config.subscribe';
  id: string;
  payload: { deviceCode: string };
}

export function createRuntimeConfigSubscribeRequest(deviceCode: string, id?: string): RuntimeConfigSubscribeRequest {
  const code = deviceCode.trim();
  if (!code) throw new Error('设备号不能为空');
  return {
    type: 'device.runtime_config.subscribe',
    id: id ?? `web-rc-sub-${Date.now().toString(36)}`,
    payload: { deviceCode: code },
  };
}

function toVoiceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 从运行时配置对象中提取设备当前音色。
 * 支持：配置对象本身 / 包在 data 里 / 包在 WS 消息 payload（或 payload.config）里。
 * 优先 device.voiceToneId，其次 voiceConfiguration.voiceTones[0]，再次 resources.voiceTones[0]。
 * 返回 undefined 表示这不是运行时配置；返回 null 表示是配置但没有音色。
 */
export function extractDeviceVoice(source: unknown): DeviceVoiceInfo | null | undefined {
  const candidates: unknown[] = [];
  if (isRecord(source)) {
    candidates.push(source, source.data, source.config);
    if (isRecord(source.payload)) candidates.push(source.payload, source.payload.config, source.payload.data);
  }
  const config = candidates.find(
    (c): c is Record<string, unknown> =>
      isRecord(c) && (isRecord(c.device) || isRecord(c.voiceConfiguration) || isRecord(c.agentApplication)),
  );
  if (!config) return undefined;

  const device = isRecord(config.device) ? config.device : null;
  const deviceVoiceId = toVoiceId(device?.voiceToneId);
  if (device && deviceVoiceId !== null) {
    return {
      id: deviceVoiceId,
      name: typeof device.voiceToneName === 'string' ? device.voiceToneName : '',
      voiceCode: typeof device.voiceToneCode === 'string' ? device.voiceToneCode : '',
    };
  }

  const pickFirst = (holder: unknown): DeviceVoiceInfo | null => {
    if (!isRecord(holder) || !Array.isArray(holder.voiceTones) || holder.voiceTones.length === 0) return null;
    const first = holder.voiceTones[0];
    if (!isRecord(first)) return null;
    const id = toVoiceId(first.id);
    if (id === null) return null;
    return {
      id,
      name: typeof first.name === 'string' ? first.name : typeof first.displayName === 'string' ? first.displayName : '',
      voiceCode: typeof first.voiceCode === 'string' ? first.voiceCode : '',
    };
  };
  return pickFirst(config.voiceConfiguration) ?? pickFirst(config.resources) ?? null;
}

/**
 * 从运行时配置中提取点位分组（application.pointGroup），结构与 device.point_group 的 payload.pointGroup 相同。
 * 支持：配置对象本身 / 包在 data 里 / 包在 WS 消息 payload（或 payload.config）里。
 * 返回 undefined 表示消息里没有点位信息（不应覆盖现有数据）；返回 null 表示应用未绑定点位分组。
 * 点位结构不合法时抛出异常。
 */
export function extractPointGroup(source: unknown): PointGroup | null | undefined {
  const candidates: unknown[] = [];
  if (isRecord(source)) {
    candidates.push(source, source.data, source.config);
    if (isRecord(source.payload)) candidates.push(source.payload, source.payload.config, source.payload.data);
  }
  const config = candidates.find(
    (c): c is Record<string, unknown> => isRecord(c) && isRecord(c.application) && 'pointGroup' in c.application,
  );
  if (!config) return undefined;
  const application = config.application as Record<string, unknown>;
  if (application.pointGroup === null) return null;
  return parsePointGroup({ type: 'device.point_group', payload: { pointGroup: application.pointGroup } }).pointGroup;
}

/** 运行时配置推送里的变更原因（如 pointGroupChanged），没有时返回空字符串 */
export function runtimeConfigAction(message: unknown): string {
  if (!isRecord(message)) return '';
  if (typeof message.action === 'string') return message.action;
  if (isRecord(message.payload) && typeof message.payload.action === 'string') return message.payload.action;
  return '';
}


