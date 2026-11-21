import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BUTTON_KEYS,
  buildRoutePoints,
  buildTtsOptionsUrl,
  buildTtsRuntimeUrl,
  buildWebSocketUrl,
  createDeviceAction,
  createPointGroupRequest,
  createTaskModeRequest,
  createVoiceBindRequest,
  isErrorResponse,
  isVoiceBoundMessage,
  parseFlowSnapshot,
  parsePointGroup,
  parseTaskModes,
  parseTtsOptions,
} from './protocol';
import type {
  ActionName,
  ActionParams,
  ButtonKey,
  ConnectionConfig,
  DeviceAction,
  FlowSnapshot,
  PointGroup,
  TaskModes,
  VoiceTone,
} from './protocol';

export const DEFAULT_CONFIG: ConnectionConfig = {
  server: 'http://192.168.3.248',
  port: '8880',
  deviceCode: '607d8074a632bd819b5a8f99ea714afeefd2d988ad82760350268fa30de42a33',
};

const STORAGE_KEY = 'digital-human-controller.config.v1';

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
  const voiceTonesRef = useRef<VoiceTone[]>([]);

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

  const clearQueryTimer = useCallback(() => {
    if (queryTimerRef.current) clearTimeout(queryTimerRef.current);
    queryTimerRef.current = null;
  }, []);

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
  }, [clearQueryTimer]);

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
      if (result.defaultVoiceId != null) {
        const found = result.voices.find((v) => v.id === result.defaultVoiceId);
        if (found) setCurrentVoice(found);
      } else if (result.voices.length > 0) {
        setCurrentVoice(result.voices[0]);
      }
    } catch (reason) {
      appendLog('system', 'voice_options_error', reason instanceof Error ? reason.message : '获取音色列表失败');
    } finally {
      setVoiceLoading(false);
    }
  }, [appendLog]);

  const bindVoice = useCallback(
    (voice: VoiceTone) => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket 尚未连接');
      const currentConfig = configRef.current;
      if (!currentConfig.deviceCode.trim()) throw new Error('设备号不能为空');
      try {
        const req = createVoiceBindRequest(currentConfig.deviceCode, voice);
        voiceBindReqIdRef.current = req.id;
        setVoiceBinding(true);
        const raw = JSON.stringify(req);
        socket.send(raw);
        appendLog('outgoing', 'device.voice.bind', raw);
      } catch (reason) {
        setVoiceBinding(false);
        throw reason;
      }
    },
    [appendLog],
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
        requestState();
        fetchPoints();
        fetchTaskModes();
        fetchVoices();
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

        if (isVoiceBoundMessage(message)) {
          const boundVoice = message.payload.voice;
          const matched = voiceTonesRef.current.find((v) => v.id === boundVoice.id) ?? null;
          setCurrentVoice(matched ?? { id: boundVoice.id, displayName: boundVoice.name, voiceCode: boundVoice.voiceCode, audioUrl: '', iconUrl: '', speechRate: 1, pitchRate: 1, volume: 50, customTestText: '', gender: '', isDefault: false });
          setVoiceBinding(false);
          voiceBindReqIdRef.current = null;
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
            setVoiceBinding(false);
            voiceBindReqIdRef.current = null;
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
    [appendLog, clearRealtime, clearQueryTimer, fetchPoints, fetchTaskModes, fetchVoices, requestState],
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
