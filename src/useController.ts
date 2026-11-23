import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BUTTON_KEYS,
  buildDeviceRuntimeConfigUrl,
  buildRoutePoints,
  buildTtsOptionsUrl,
  buildTtsRuntimeUrl,
  buildWebSocketUrl,
  createDeviceAction,
  createPointGroupRequest,
  createRuntimeConfigSubscribeRequest,
  createTaskModeRequest,
  createVoiceBindRequest,
  extractDeviceVoice,
  extractRuntimeDevice,
  extractPointGroup,
  isErrorResponse,
  isVoiceBoundMessage,
  parseFlowSnapshot,
  parsePointGroup,
  parseTaskModes,
  parseTtsOptions,
  runtimeConfigAction,
} from './protocol';
import type {
  ActionName,
  ActionParams,
  ButtonKey,
  ConnectionConfig,
  DeviceAction,
  DeviceVoiceInfo,
  FlowSnapshot,
  PointGroup,
  RuntimeDeviceInfo,
  TaskModes,
  VoiceTone,
} from './protocol';

export const DEFAULT_CONFIG: ConnectionConfig = {
  server: 'http://192.168.3.248',
  port: '8880',
  deviceCode: '607d8074a632bd819b5a8f99ea714afeefd2d988ad82760350268fa30de42a33',
};

const STORAGE_KEY = 'digital-human-controller.config.v1';
const VOICE_BIND_TIMEOUT = 8_000;
const HISTORY_KEY = 'digital-human-controller.device-history.v1';
const HISTORY_LIMIT = 10;

/** 设备号历史记录（连接成功后记录，设备名称来自运行时配置 device.name） */
export interface DeviceHistoryEntry {
  code: string;
  name: string;
  lastUsedAt: string;
}

function loadDeviceHistory(): DeviceHistoryEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item): item is DeviceHistoryEntry => typeof item?.code === 'string' && item.code.trim() !== '')
      .map((item) => ({
        code: item.code.trim(),
        name: typeof item.name === 'string' ? item.name : '',
        lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : '',
      }))
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveDeviceHistory(list: DeviceHistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 浏览器不允许存储时忽略，仅影响历史记录
  }
}

function sameVoiceId(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';
export type LogDirection = 'incoming' | 'outgoing' | 'system';

export interface LogEntry {
  id: string;
  direction: LogDirection;
  type: string;
  raw: string;
  timestamp: string;
}

function loadConfig(): ConnectionConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ConnectionConfig> | null;
    return {
      server: typeof saved?.server === 'string' ? saved.server : DEFAULT_CONFIG.server,
      port: typeof saved?.port === 'string' ? saved.port : DEFAULT_CONFIG.port,
      deviceCode: typeof saved?.deviceCode === 'string' ? saved.deviceCode : DEFAULT_CONFIG.deviceCode,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function messageType(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return 'unknown';
}

export function useController() {
  const [config, setConfig] = useState<ConnectionConfig>(loadConfig);
  const [activeConfig, setActiveConfig] = useState<ConnectionConfig | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [activeUrl, setActiveUrl] = useState('');
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null);
  const [screenOnline, setScreenOnline] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isQuerying, setIsQuerying] = useState(false);
  const [lastReceivedAt, setLastReceivedAt] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pointGroup, setPointGroup] = useState<PointGroup | null>(null);
  const [taskModes, setTaskModes] = useState<TaskModes | null>(null);
  const [pointGroupLoading, setPointGroupLoading] = useState(false);
  const [taskModesLoading, setTaskModesLoading] = useState(false);
  const [voiceTones, setVoiceTones] = useState<VoiceTone[]>([]);
  const [currentVoice, setCurrentVoice] = useState<VoiceTone | null>(null);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceBinding, setVoiceBinding] = useState(false);
  const [voicePreviewing, setVoicePreviewing] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [runtimeDevice, setRuntimeDevice] = useState<RuntimeDeviceInfo | null>(null);
  const [deviceHistory, setDeviceHistory] = useState<DeviceHistoryEntry[]>(loadDeviceHistory);

  const wsRef = useRef<WebSocket | null>(null);
  const configRef = useRef(config);
  const snapshotRef = useRef(snapshot);
  const screenOnlineRef = useRef(screenOnline);
  const shouldReconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectRef = useRef<(isReconnect?: boolean) => void>(() => undefined);
  const logCounterRef = useRef(0);
  const pointGroupReqIdRef = useRef<string | null>(null);
  const taskModesReqIdRef = useRef<string | null>(null);
  const voiceBindReqIdRef = useRef<string | null>(null);
  const voiceBindPendingRef = useRef<VoiceTone | null>(null);
  const voiceBindTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceTonesRef = useRef<VoiceTone[]>([]);
  /** 服务端运行时配置里的设备当前音色（唯一可信来源） */
  const deviceVoiceRef = useRef<DeviceVoiceInfo | null>(null);
  /** 当前连接使用的设备号（用于把设备名称写回历史记录） */
  const activeDeviceCodeRef = useRef('');

  configRef.current = config;
  snapshotRef.current = snapshot;
  screenOnlineRef.current = screenOnline;
  voiceTonesRef.current = voiceTones;

  const appendLog = useCallback((direction: LogDirection, type: string, raw: string) => {
    logCounterRef.current += 1;
    const entry: LogEntry = {
      id: `${Date.now()}-${logCounterRef.current}`,
      direction,
      type,
      raw,
      timestamp: new Date().toISOString(),
    };
    setLogs((current) => [entry, ...current].slice(0, 50));
  }, []);

  const updateDeviceHistory = useCallback((updater: (list: DeviceHistoryEntry[]) => DeviceHistoryEntry[]) => {
    setDeviceHistory((current) => {
      const next = updater(current).slice(0, HISTORY_LIMIT);
      saveDeviceHistory(next);
      return next;
    });
  }, []);

  /** 记录 / 置顶一个设备号，保留已知的设备名称 */
  const rememberDevice = useCallback(
    (code: string, name?: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      updateDeviceHistory((list) => {
        const existing = list.find((entry) => entry.code === trimmed);
        const entry: DeviceHistoryEntry = {
          code: trimmed,
          name: name?.trim() || existing?.name || '',
          lastUsedAt: new Date().toISOString(),
        };
        return [entry, ...list.filter((item) => item.code !== trimmed)];
      });
    },
    [updateDeviceHistory],
  );

  /** 从运行时配置中读取设备名称等信息，并同步到历史记录 */
  const applyRuntimeDevice = useCallback(
    (source: unknown, code: string = activeDeviceCodeRef.current) => {
      const info = extractRuntimeDevice(source);
      if (!info) return;
      setRuntimeDevice(info);
      const trimmed = code.trim();
      if (info.name && trimmed) {
        updateDeviceHistory((list) =>
          list.map((entry) => (entry.code === trimmed && entry.name !== info.name ? { ...entry, name: info.name } : entry)),
        );
      }
    },
    [updateDeviceHistory],
  );

  const clearQueryTimer = useCallback(() => {
    if (queryTimerRef.current) clearTimeout(queryTimerRef.current);
    queryTimerRef.current = null;
  }, []);

  const clearVoiceBindTimer = useCallback(() => {
    if (voiceBindTimerRef.current) clearTimeout(voiceBindTimerRef.current);
    voiceBindTimerRef.current = null;
  }, []);

  /** 把服务端返回的设备当前音色映射到音色列表里的条目 */
  const applyDeviceVoice = useCallback((info: DeviceVoiceInfo | null) => {
    deviceVoiceRef.current = info;
    if (!info) return;
    const matched =
      voiceTonesRef.current.find((v) => sameVoiceId(v.id, info.id)) ??
      (info.voiceCode ? voiceTonesRef.current.find((v) => v.voiceCode === info.voiceCode) : undefined);
    setCurrentVoice(
      matched ?? {
        id: info.id,
        displayName: info.name || info.voiceCode || `音色 ${info.id}`,
        voiceCode: info.voiceCode,
        audioUrl: '',
        iconUrl: '',
        speechRate: 1,
        pitchRate: 1,
        volume: 50,
        customTestText: '',
        gender: '',
        isDefault: false,
      },
    );
  }, []);

  /**
   * 用运行时配置里的 application.pointGroup 更新直达导航点位。
   * 返回 true 表示消息里带有点位信息并已应用。
   */
  const applyRuntimePoints = useCallback(
    (source: unknown): boolean => {
      try {
        const group = extractPointGroup(source);
        if (group === undefined) return false;
        setPointGroup(group);
        setPointGroupLoading(false);
        return true;
      } catch (reason) {
        appendLog('system', 'point_group_parse_error', `运行时配置中的点位分组解析失败：${reason instanceof Error ? reason.message : '未知错误'}`);
        return false;
      }
    },
    [appendLog],
  );

  /** 拉取设备运行时配置，读取设备当前音色（GET /api/v1/device-runtime/config/） */
  const fetchDeviceVoice = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig.deviceCode.trim()) return;
    try {
      const resp = await fetch(buildDeviceRuntimeConfigUrl(currentConfig), {
        headers: { 'X-Device-Code': currentConfig.deviceCode },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: unknown = await resp.json();
      const info = extractDeviceVoice(data);
      if (info === undefined) {
        const msg = (data as { message?: unknown })?.message;
        throw new Error(typeof msg === 'string' && msg ? msg : '运行时配置格式无法识别');
      }
      applyDeviceVoice(info);
      applyRuntimeDevice(data, currentConfig.deviceCode);
      applyRuntimePoints(data);
    } catch (reason) {
      appendLog('system', 'runtime_config_error', `读取设备当前音色失败：${reason instanceof Error ? reason.message : '未知错误'}`);
    }
  }, [appendLog, applyDeviceVoice, applyRuntimeDevice, applyRuntimePoints]);

  /** 绑定成功：先乐观更新当前音色、结束 loading，再从服务端确认 */
  const applyBoundVoice = useCallback(
    (bound: { id: unknown; name?: unknown; voiceCode?: unknown } | null) => {
      const pending = voiceBindPendingRef.current;
      const targetId = bound?.id ?? pending?.id;
      const matched =
        voiceTonesRef.current.find((v) => sameVoiceId(v.id, targetId)) ??
        (pending && sameVoiceId(pending.id, targetId) ? pending : null);
      const fallback: VoiceTone | null =
        bound && Number.isFinite(Number(bound.id))
          ? { id: Number(bound.id), displayName: typeof bound.name === 'string' ? bound.name : '', voiceCode: typeof bound.voiceCode === 'string' ? bound.voiceCode : '', audioUrl: '', iconUrl: '', speechRate: 1, pitchRate: 1, volume: 50, customTestText: '', gender: '', isDefault: false }
          : null;
      const next = matched ?? fallback ?? pending;
      if (next) setCurrentVoice(next);
      clearVoiceBindTimer();
      setVoiceBinding(false);
      voiceBindReqIdRef.current = null;
      voiceBindPendingRef.current = null;
      // 以服务端运行时配置为准做一次确认（稍等片刻让后端落库）
      setTimeout(() => {
        void fetchDeviceVoice();
      }, 600);
    },
    [clearVoiceBindTimer, fetchDeviceVoice],
  );

  const clearRealtime = useCallback(() => {
    clearQueryTimer();
    setIsQuerying(false);
    setSnapshot(null);
    setScreenOnline(null);
    setLastReceivedAt(null);
    setPointGroup(null);
    setTaskModes(null);
    setPointGroupLoading(false);
    setTaskModesLoading(false);
    pointGroupReqIdRef.current = null;
    taskModesReqIdRef.current = null;
    setVoiceTones([]);
    setCurrentVoice(null);
    setVoiceLoading(false);
    setVoiceBinding(false);
    setVoicePreviewing(false);
    setPreviewText(null);
    voiceBindReqIdRef.current = null;
    voiceBindPendingRef.current = null;
    deviceVoiceRef.current = null;
    setRuntimeDevice(null);
    clearVoiceBindTimer();
  }, [clearQueryTimer, clearVoiceBindTimer]);

  const sendAction = useCallback(
    (action: ActionName, params: ActionParams = {}): DeviceAction => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket 尚未连接');
      const currentConfig = configRef.current;
      if (!currentConfig.deviceCode.trim()) throw new Error('设备号不能为空');

      const currentSnapshot = snapshotRef.current;
      if (action !== 'getState') {
        if (!currentSnapshot || screenOnlineRef.current !== true) {
          throw new Error('设备不在可控制状态，请等待最新状态快照');
        }
        if (BUTTON_KEYS.includes(action as ButtonKey) && !currentSnapshot.buttons[action as ButtonKey]) {
          throw new Error('最新设备状态已禁止此操作');
        }
      }

      if (action === 'jumpToNavigationStep') {
        const target = buildRoutePoints(currentSnapshot, true).find(
          (point) => point.stepId === params.stepId && point.canNavigate,
        );
        if (!target) throw new Error('目标点位已变化或当前不允许跳转，请刷新后重试');
      }
      if (action === 'textQuestion' && !params.text?.trim()) {
        throw new Error('问题内容不能为空');
      }
      if (action === 'navigateToPoint') {
        if (!currentSnapshot?.deviceInfo.robotConnected) throw new Error('机器人尚未连接');
        if (!params.point?.trim() || !params.pointName?.trim()) {
          throw new Error('点位值和点位名称均不能为空');
        }
      }

      const normalizedParams: ActionParams = { ...params };
      if (action === 'textQuestion') normalizedParams.text = params.text?.trim();
      if (action === 'navigateToPoint') {
        normalizedParams.point = params.point?.trim();
        normalizedParams.pointName = params.pointName?.trim();
      }
      const message = createDeviceAction(currentConfig.deviceCode, action, normalizedParams);
      const raw = JSON.stringify(message);
      socket.send(raw);
      appendLog('outgoing', action, raw);
      return message;
    },
    [appendLog],
  );

  const fetchPoints = useCallback(() => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const currentConfig = configRef.current;
    if (!currentConfig.deviceCode.trim()) return;
    try {
      const req = createPointGroupRequest(currentConfig.deviceCode);
      pointGroupReqIdRef.current = req.id;
      setPointGroupLoading(true);
      const raw = JSON.stringify(req);
      socket.send(raw);
      appendLog('outgoing', 'device.point_group.get', raw);
    } catch (reason) {
      setPointGroupLoading(false);
      appendLog('system', 'point_group_send_error', reason instanceof Error ? reason.message : '点位分组请求发送失败');
    }
  }, [appendLog]);

  const fetchVoices = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig.deviceCode.trim()) return;
    setVoiceLoading(true);
    try {
      const url = buildTtsOptionsUrl(currentConfig);
      const resp = await fetch(url, { headers: { 'X-Device-Code': currentConfig.deviceCode } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const result = parseTtsOptions(data);
      setVoiceTones(result.voices);
      voiceTonesRef.current = result.voices;
      // 当前音色以设备运行时配置为准；defaultVoiceId 只是系统默认音色，不代表设备当前音色
      const deviceVoice = deviceVoiceRef.current;
      if (deviceVoice) {
        const matched = result.voices.find((v) => sameVoiceId(v.id, deviceVoice.id));
        if (matched) setCurrentVoice(matched);
      } else {
        setCurrentVoice((current) => {
          if (current) return result.voices.find((v) => sameVoiceId(v.id, current.id)) ?? current;
          // 运行时配置尚未返回时的临时占位，稍后会被设备真实音色覆盖
          return (
            (result.defaultVoiceId != null
              ? result.voices.find((v) => sameVoiceId(v.id, result.defaultVoiceId))
              : undefined) ?? null
          );
        });
      }
      // 每次刷新音色列表都向服务端确认一次设备当前音色
      void fetchDeviceVoice();
    } catch (reason) {
      appendLog('system', 'voice_options_error', reason instanceof Error ? reason.message : '获取音色列表失败');
    } finally {
      setVoiceLoading(false);
    }
  }, [appendLog, fetchDeviceVoice]);

  const bindVoice = useCallback(
    (voice: VoiceTone) => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket 尚未连接');
      const currentConfig = configRef.current;
      if (!currentConfig.deviceCode.trim()) throw new Error('设备号不能为空');
      try {
        const req = createVoiceBindRequest(currentConfig.deviceCode, voice);
        voiceBindReqIdRef.current = req.id;
        voiceBindPendingRef.current = voice;
        setVoiceBinding(true);
        const raw = JSON.stringify(req);
        socket.send(raw);
        appendLog('outgoing', 'device.voice.bind', raw);
        clearVoiceBindTimer();
        voiceBindTimerRef.current = setTimeout(() => {
          voiceBindTimerRef.current = null;
          if (voiceBindReqIdRef.current !== req.id) return;
          // 没有收到错误回执：设备通常已切换成功，按已绑定处理
          appendLog('system', 'voice_bind_no_ack', `${VOICE_BIND_TIMEOUT / 1000} 秒内未收到音色绑定回执，按已绑定"${voice.displayName}"处理`);
          applyBoundVoice(null);
        }, VOICE_BIND_TIMEOUT);
      } catch (reason) {
        setVoiceBinding(false);
        voiceBindReqIdRef.current = null;
        voiceBindPendingRef.current = null;
        throw reason;
      }
    },
    [appendLog, applyBoundVoice, clearVoiceBindTimer],
  );

  const previewVoice = useCallback(
    async (voice: VoiceTone, text?: string) => {
      const currentConfig = configRef.current;
      if (!currentConfig.deviceCode.trim()) throw new Error('设备号不能为空');
      const sampleText = text?.trim() || voice.customTestText || '你好，这是一段音色试听。';
      setVoicePreviewing(true);
      setPreviewText(sampleText);
      try {
        const url = buildTtsRuntimeUrl(currentConfig);
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'X-Device-Code': currentConfig.deviceCode,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: sampleText, voiceId: voice.id, wrapWav: true }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          setVoicePreviewing(false);
          setPreviewText(null);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          setVoicePreviewing(false);
          setPreviewText(null);
        };
        await audio.play();
      } catch (reason) {
        setVoicePreviewing(false);
        setPreviewText(null);
        throw reason;
      }
    },
    [],
  );

  const fetchTaskModes = useCallback(() => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const currentConfig = configRef.current;
    if (!currentConfig.deviceCode.trim()) return;
    try {
      const req = createTaskModeRequest(currentConfig.deviceCode, `web-tm-${Date.now().toString(36)}`);
      taskModesReqIdRef.current = req.id;
      setTaskModesLoading(true);
      const raw = JSON.stringify(req);
      socket.send(raw);
      appendLog('outgoing', 'device.task_mode.get', raw);
    } catch (reason) {
      setTaskModesLoading(false);
      appendLog('system', 'task_mode_send_error', reason instanceof Error ? reason.message : '任务模式请求发送失败');
    }
  }, [appendLog]);

  const requestState = useCallback(() => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('请先连接服务器');
      return;
    }
    clearQueryTimer();
    try {
      sendAction('getState');
      setIsQuerying(true);
      setError(null);
      queryTimerRef.current = setTimeout(() => {
        queryTimerRef.current = null;
        setIsQuerying(false);
        setSnapshot(null);
        setScreenOnline(null);
        setLastReceivedAt(null);
        setError('状态查询超时（15 秒），请重试');
        appendLog('system', 'query_timeout', 'getState 查询超过 15 秒未收到有效状态');
      }, 15_000);
    } catch (reason) {
      setIsQuerying(false);
      setError(reason instanceof Error ? reason.message : '状态查询失败');
    }
  }, [appendLog, clearQueryTimer, sendAction]);

  const connect = useCallback(
    (isReconnect = false) => {
      let url: string;
      try {
        url = buildWebSocketUrl(configRef.current);
        if (!configRef.current.deviceCode.trim()) throw new Error('请输入设备号');
      } catch (reason) {
        shouldReconnectRef.current = false;
        setStatus('disconnected');
        setError(reason instanceof Error ? reason.message : '连接配置无效');
        return;
      }

      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      shouldReconnectRef.current = true;
      clearRealtime();
      setError(null);
      setStatus(isReconnect ? 'reconnecting' : 'connecting');
      setActiveUrl(url);
      setActiveConfig({ ...configRef.current });
      activeDeviceCodeRef.current = configRef.current.deviceCode.trim();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(configRef.current));
      } catch {
        appendLog('system', 'storage_warning', '浏览器未允许保存连接配置，本次连接仍可继续');
      }

      const previous = wsRef.current;
      if (previous) {
        previous.onopen = null;
        previous.onmessage = null;
        previous.onerror = null;
        previous.onclose = null;
        previous.close();
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        shouldReconnectRef.current = false;
        setStatus('disconnected');
        setError('无法创建 WebSocket 连接，请检查地址和浏览器安全策略');
        return;
      }
      wsRef.current = socket;
      appendLog('system', isReconnect ? 'reconnecting' : 'connecting', url);

      socket.onopen = () => {
        if (wsRef.current !== socket) return;
        setStatus('connected');
        setError(null);
        appendLog('system', 'connected', `已连接 ${url}`);
        rememberDevice(activeDeviceCodeRef.current);
        requestState();
        fetchPoints();
        fetchTaskModes();
        fetchVoices();
        // 订阅运行时配置：音色等配置变更时云端会推送完整配置
        try {
          const sub = createRuntimeConfigSubscribeRequest(configRef.current.deviceCode);
          const raw = JSON.stringify(sub);
          socket.send(raw);
          appendLog('outgoing', sub.type, raw);
        } catch (reason) {
          appendLog('system', 'runtime_config_subscribe_error', reason instanceof Error ? reason.message : '订阅运行时配置失败');
        }
      };

      socket.onmessage = (event) => {
        if (wsRef.current !== socket) return;
        if (typeof event.data !== 'string') {
          appendLog('system', 'ignored_message', '忽略非文本 WebSocket 消息');
          return;
        }
        const raw = event.data;
        let message: unknown;
        try {
          message = JSON.parse(raw);
        } catch {
          appendLog('incoming', 'invalid_json', raw);
          setError('收到无法解析的 JSON 消息');
          return;
        }
        const type = messageType(message);
        appendLog('incoming', type, raw);

        if (type === 'device.task_flow.state') {
          try {
            const nextSnapshot = parseFlowSnapshot(message);
            clearQueryTimer();
            setIsQuerying(false);
            setSnapshot(nextSnapshot);
            setScreenOnline(true);
            setLastReceivedAt(new Date().toISOString());
            setError(null);
          } catch (reason) {
            clearQueryTimer();
            setIsQuerying(false);
            setSnapshot(null);
            setScreenOnline(null);
            setLastReceivedAt(null);
            setError(`状态快照无效：${reason instanceof Error ? reason.message : '未知解析错误'}`);
          }
          return;
        }

        if (type === 'device.point_group') {
          try {
            const result = parsePointGroup(message);
            if (result.pointGroup) {
              setPointGroup(result.pointGroup);
            } else {
              setPointGroup(null);
            }
          } catch (reason) {
            appendLog('system', 'point_group_parse_error', reason instanceof Error ? reason.message : '点位分组解析失败');
          }
          setPointGroupLoading(false);
          pointGroupReqIdRef.current = null;
          return;
        }

        if (type === 'device.task_mode') {
          try {
            const result = parseTaskModes(message);
            setTaskModes(result.modes);
          } catch (reason) {
            appendLog('system', 'task_mode_parse_error', reason instanceof Error ? reason.message : '任务模式解析失败');
          }
          setTaskModesLoading(false);
          taskModesReqIdRef.current = null;
          return;
        }

        // 运行时配置推送（订阅回执或配置变更后的完整配置）：同步设备当前音色和直达导航点位
        if (type.startsWith('device.runtime_config') || type.endsWith('.changed')) {
          applyRuntimeDevice(message);
          const info = extractDeviceVoice(message);
          if (info !== undefined) {
            applyDeviceVoice(info);
          } else if (type.endsWith('.changed') && type.includes('voice')) {
            void fetchDeviceVoice();
          }
          const pointsApplied = applyRuntimePoints(message);
          if (pointsApplied) {
            if (runtimeConfigAction(message) === 'pointGroupChanged') {
              appendLog('system', 'point_group_synced', '点位分组已变更，已按运行时配置推送自动刷新');
            }
          } else if (type === 'device.point_group.changed' || runtimeConfigAction(message) === 'pointGroupChanged') {
            // 推送里没带点位内容时，主动重新读取一次
            fetchPoints();
          }
          if (type !== 'device.voice.bound') return;
        }

        // 音色绑定回执：标准 device.voice.bound，或与本次绑定请求 id 相同的非错误消息
        const rawMsg = message as { id?: unknown; payload?: { voice?: unknown } };
        const isBindAck =
          isVoiceBoundMessage(message) ||
          (voiceBindReqIdRef.current !== null &&
            rawMsg.id === voiceBindReqIdRef.current &&
            !isErrorResponse(message) &&
            type !== 'device.task_flow.state');
        if (isBindAck) {
          const voice = rawMsg.payload?.voice;
          applyBoundVoice(
            voice && typeof voice === 'object'
              ? (voice as { id: unknown; name?: unknown; voiceCode?: unknown })
              : null,
          );
          return;
        }

        if (isErrorResponse(message)) {
          const err = message as { type: 'error'; id: string | null; error: { code: string; message: string } };
          if (err.id === pointGroupReqIdRef.current) {
            setPointGroupLoading(false);
            pointGroupReqIdRef.current = null;
            appendLog('system', 'point_group_error', `点位分组请求失败: ${err.error.message} (code: ${err.error.code})`);
          } else if (err.id === taskModesReqIdRef.current) {
            setTaskModesLoading(false);
            taskModesReqIdRef.current = null;
            appendLog('system', 'task_mode_error', `任务模式请求失败: ${err.error.message} (code: ${err.error.code})`);
          } else if (err.id === voiceBindReqIdRef.current) {
            clearVoiceBindTimer();
            setVoiceBinding(false);
            voiceBindReqIdRef.current = null;
            voiceBindPendingRef.current = null;
            setError(`音色绑定失败：${err.error.message}`);
            appendLog('system', 'voice_bind_error', `音色绑定失败: ${err.error.message} (code: ${err.error.code})`);
          }
          return;
        }

        if (type === 'screen_offline') {
          clearQueryTimer();
          setIsQuerying(false);
          setSnapshot(null);
          setScreenOnline(false);
          setLastReceivedAt(null);
          setError('设备已离线，控制动作已禁用');
        } else if (type === 'screen_online') {
          setScreenOnline((current) => (snapshotRef.current ? true : current));
          requestState();
        }
      };

      socket.onerror = () => {
        if (wsRef.current !== socket) return;
        setError('WebSocket 连接异常，请检查服务器地址、端口及服务状态');
      };

      socket.onclose = (event) => {
        if (wsRef.current !== socket) return;
        wsRef.current = null;
        clearRealtime();
        appendLog('system', 'disconnected', `连接已关闭（code: ${event.code}）`);
        if (shouldReconnectRef.current) {
          setStatus('reconnecting');
          setError('连接已断开，3 秒后自动重连');
          reconnectTimerRef.current = setTimeout(() => connectRef.current(true), 3_000);
        } else {
          setStatus('disconnected');
        }
      };
    },
    [appendLog, applyBoundVoice, applyDeviceVoice, applyRuntimeDevice, applyRuntimePoints, clearRealtime, clearQueryTimer, clearVoiceBindTimer, fetchDeviceVoice, fetchPoints, fetchTaskModes, fetchVoices, rememberDevice, requestState],
  );
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    clearRealtime();
    setError(null);
    setStatus('disconnected');
    setActiveConfig(null);
    const socket = wsRef.current;
    wsRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    appendLog('system', 'disconnected', '用户主动断开连接');
  }, [appendLog, clearRealtime]);

  useEffect(
    () => () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (queryTimerRef.current) clearTimeout(queryTimerRef.current);
      if (voiceBindTimerRef.current) clearTimeout(voiceBindTimerRef.current);
      const socket = wsRef.current;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    },
    [],
  );

  const canControl = status === 'connected' && screenOnline === true && snapshot !== null;
  const configDirty = activeConfig !== null && JSON.stringify(activeConfig) !== JSON.stringify(config);

  return {
    config,
    setConfig,
    configDirty,
    status,
    activeUrl,
    snapshot,
    screenOnline,
    canControl,
    error,
    isQuerying,
    lastReceivedAt,
    logs,
    pointGroup,
    taskModes,
    pointGroupLoading,
    taskModesLoading,
    voiceTones,
    currentVoice,
    voiceLoading,
    voiceBinding,
    voicePreviewing,
    previewText,
    runtimeDevice,
    deviceHistory,
    removeDeviceHistory: (code: string) => updateDeviceHistory((list) => list.filter((entry) => entry.code !== code)),
    clearDeviceHistory: () => updateDeviceHistory(() => []),
    connect,
    disconnect,
    requestState,
    sendAction,
    fetchPoints,
    fetchTaskModes,
    fetchVoices,
    bindVoice,
    previewVoice,
    clearError: () => setError(null),
    clearLogs: () => setLogs([]),
  };
}
