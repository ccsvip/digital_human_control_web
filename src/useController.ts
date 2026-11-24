import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BUTTON_KEYS,
  buildAsrDeviceStatusUrl,
  buildDeviceResourcesUrl,
  buildVoiceChatUrl,
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
  extractDeviceResources,
  extractDeviceVoice,
  extractRuntimeDevice,
  extractPointGroup,
  isErrorResponse,
  isVoiceBoundMessage,
  parseAsrDeviceStatus,
  parseAsrTranscript,
  parseFlowSnapshot,
  parsePointGroup,
  parseTaskModes,
  parseTtsOptions,
  parseVoiceChatResult,
  readAsrError,
  readCloudError,
  runtimeConfigAction,
} from './protocol';
import { describeMicError, startPcmCapture } from './audioCapture';
import type { PcmCapture } from './audioCapture';
import type {
  ActionName,
  AsrDeviceStatus,
  DeviceResources,
  ActionParams,
  ButtonKey,
  ConnectionConfig,
  DeviceAction,
  DeviceVoiceInfo,
  FlowSnapshot,
  PointGroup,
  RuntimeDeviceInfo,
  TaskModes,
  VoiceChatResult,
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

const SERVER_HISTORY_KEY = 'digital-human-controller.server-history.v1';
const SERVER_HISTORY_LIMIT = 10;

/** 服务器地址历史记录（服务器地址 + 端口作为一条记录，连接成功后自动记录） */
export interface ServerHistoryEntry {
  server: string;
  port: string;
  /** 备注名称，可选 */
  name: string;
  lastUsedAt: string;
}

export const serverHistoryKey = (server: string, port: string) => `${server.trim().replace(/\/+$/, '')}|${port.trim()}`;

function loadServerHistory(): ServerHistoryEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SERVER_HISTORY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item): item is ServerHistoryEntry => typeof item?.server === 'string' && item.server.trim() !== '')
      .map((item) => ({
        server: item.server.trim(),
        port: typeof item.port === 'string' ? item.port.trim() : String(item.port ?? ''),
        name: typeof item.name === 'string' ? item.name : '',
        lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : '',
      }))
      .slice(0, SERVER_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveServerHistory(list: ServerHistoryEntry[]) {
  try {
    localStorage.setItem(SERVER_HISTORY_KEY, JSON.stringify(list));
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

/** 问答测试的一轮记录 */
export interface ChatTestTurn {
  id: string;
  question: string;
  result: VoiceChatResult | null;
  error: string | null;
  pending: boolean;
  timestamp: string;
}

async function readJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 语音输入：idle 空闲 / starting 等待 asr.ready / recording 录音中 / finishing 已结束录音，等待识别结果 */
export type AsrPhase = 'idle' | 'starting' | 'recording' | 'finishing';
/** 语音输入的目标输入框 */
export type AsrTarget = 'broadcast' | 'question';

export interface AsrCallbacks {
  onResult: (text: string) => void;
  onError: (message: string) => void;
}

interface AsrSession {
  requestId: string;
  target: AsrTarget;
  ready: boolean;
  finishRequested: boolean;
  finishSent: boolean;
  queue: ArrayBuffer[];
  capture: PcmCapture | null;
  committed: string[];
  partial: string;
  timer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  callbacks: AsrCallbacks;
}

const ASR_READY_TIMEOUT = 8_000;
const ASR_RESULT_TIMEOUT = 15_000;
const ASR_MAX_DURATION = 60_000;
const ASR_DONE_TYPES = /^asr\.(done|complete|completed|finished|final|session\.(done|complete|completed))$/;

function asrCombinedText(session: AsrSession): string {
  return `${session.committed.join('')}${session.partial}`.trim();
}

function sendQueuedAudio(socket: WebSocket | null, session: AsrSession) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  for (const chunk of session.queue) socket.send(chunk);
  session.queue = [];
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
  const [serverHistory, setServerHistory] = useState<ServerHistoryEntry[]>(loadServerHistory);
  const [asrStatus, setAsrStatus] = useState<AsrDeviceStatus | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);
  const [asrLoading, setAsrLoading] = useState(false);
  const [deviceResources, setDeviceResources] = useState<DeviceResources | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [chatTurns, setChatTurns] = useState<ChatTestTurn[]>([]);
  const [chatSending, setChatSending] = useState(false);
  const chatSessionIdRef = useRef('');
  const [asrPhase, setAsrPhase] = useState<AsrPhase>('idle');
  const [asrTarget, setAsrTarget] = useState<AsrTarget | null>(null);
  const [asrText, setAsrText] = useState('');
  const asrRef = useRef<AsrSession | null>(null);
  const chatCounterRef = useRef(0);

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
  /** 当前连接使用的服务器地址与端口（连接成功后写入服务器历史） */
  const activeServerRef = useRef({ server: '', port: '' });

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

  const updateServerHistory = useCallback((updater: (list: ServerHistoryEntry[]) => ServerHistoryEntry[]) => {
    setServerHistory((current) => {
      const next = updater(current).slice(0, SERVER_HISTORY_LIMIT);
      saveServerHistory(next);
      return next;
    });
  }, []);

  /** 记录 / 置顶一个服务器地址 + 端口，保留已有备注 */
  const rememberServer = useCallback(
    (server: string, port: string, touch = true) => {
      const s = server.trim().replace(/\/+$/, '');
      const p = port.trim();
      if (!s) return;
      const key = serverHistoryKey(s, p);
      updateServerHistory((list) => {
        const existing = list.find((entry) => serverHistoryKey(entry.server, entry.port) === key);
        const entry: ServerHistoryEntry = {
          server: s,
          port: p,
          name: existing?.name ?? '',
          lastUsedAt: touch ? new Date().toISOString() : existing?.lastUsedAt ?? '',
        };
        return [entry, ...list.filter((item) => serverHistoryKey(item.server, item.port) !== key)];
      });
    },
    [updateServerHistory],
  );

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
      const resources = extractDeviceResources(data);
      if (resources) setDeviceResources(resources);
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

  // ===================== 语音输入（云端流式 ASR） =====================

  const sendAsrCommand = useCallback(
    (type: string, session: AsrSession, id?: string) => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      const message = {
        type,
        id: id ?? `${session.requestId}-${type.split('.').pop()}`,
        payload: { deviceCode: configRef.current.deviceCode.trim(), requestId: session.requestId, traceId: '' },
      };
      const raw = JSON.stringify(message);
      socket.send(raw);
      appendLog('outgoing', type, raw);
      return true;
    },
    [appendLog],
  );

  /** 结束当前语音会话；outcome 为 null 表示静默取消 */
  const endAsrSession = useCallback((outcome: { text?: string; error?: string } | null) => {
    const session = asrRef.current;
    if (!session) return;
    asrRef.current = null;
    if (session.timer) clearTimeout(session.timer);
    if (session.maxTimer) clearTimeout(session.maxTimer);
    session.capture?.stop();
    setAsrPhase('idle');
    setAsrTarget(null);
    setAsrText('');
    if (!outcome) return;
    if (outcome.error) session.callbacks.onError(outcome.error);
    else if (outcome.text) session.callbacks.onResult(outcome.text);
    else session.callbacks.onError('没有识别到语音内容');
  }, []);

  const sendAsrFinish = useCallback(
    (session: AsrSession) => {
      if (session.finishSent) return;
      sendQueuedAudio(wsRef.current, session);
      session.finishSent = true;
      sendAsrCommand('asr.session.finish', session);
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        if (asrRef.current !== session) return;
        const text = asrCombinedText(session);
        endAsrSession(text ? { text } : { error: '识别超时，未收到识别结果' });
      }, ASR_RESULT_TIMEOUT);
    },
    [endAsrSession, sendAsrCommand],
  );

  /** 说完了：停止录音并提交，等待识别结果 */
  const stopAsr = useCallback(() => {
    const session = asrRef.current;
    if (!session || session.finishRequested) return;
    session.finishRequested = true;
    session.capture?.stop(); // 先把剩余音频交出去
    setAsrPhase('finishing');
    if (session.ready) sendAsrFinish(session);
  }, [sendAsrFinish]);

  /** 取消语音输入，不使用识别结果 */
  const cancelAsr = useCallback(() => {
    const session = asrRef.current;
    if (!session) return;
    sendAsrCommand('asr.session.cancel', session);
    endAsrSession(null);
  }, [endAsrSession, sendAsrCommand]);

  /**
   * 开始语音输入：先打开麦克风，再发 asr.session.start；收到 asr.ready 前的音频先缓存。
   * 结果和错误都通过 callbacks 返回，不抛异常。
   */
  const startAsr = useCallback(
    async (target: AsrTarget, callbacks: AsrCallbacks) => {
      if (asrRef.current) {
        callbacks.onError('已有语音输入正在进行');
        return;
      }
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        callbacks.onError('WebSocket 尚未连接');
        return;
      }
      if (!configRef.current.deviceCode.trim()) {
        callbacks.onError('设备号不能为空');
        return;
      }
      const session: AsrSession = {
        requestId: `web-asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        target,
        ready: false,
        finishRequested: false,
        finishSent: false,
        queue: [],
        capture: null,
        committed: [],
        partial: '',
        timer: null,
        maxTimer: null,
        callbacks,
      };
      asrRef.current = session;
      setAsrTarget(target);
      setAsrText('');
      setAsrPhase('starting');

      let capture: PcmCapture;
      try {
        capture = await startPcmCapture((chunk) => {
          if (asrRef.current !== session || session.finishSent) return;
          const ws = wsRef.current;
          if (session.ready && ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
          else session.queue.push(chunk);
        });
      } catch (reason) {
        if (asrRef.current === session) endAsrSession({ error: describeMicError(reason) });
        return;
      }
      if (asrRef.current !== session) {
        capture.stop();
        return;
      }
      session.capture = capture;
      if (!sendAsrCommand('asr.session.start', session, session.requestId)) {
        endAsrSession({ error: 'WebSocket 已断开' });
        return;
      }
      session.timer = setTimeout(() => {
        if (asrRef.current !== session || session.ready) return;
        sendAsrCommand('asr.session.cancel', session);
        endAsrSession({ error: `语音识别服务未就绪（${ASR_READY_TIMEOUT / 1000} 秒超时）` });
      }, ASR_READY_TIMEOUT);
      session.maxTimer = setTimeout(() => {
        if (asrRef.current === session) stopAsr();
      }, ASR_MAX_DURATION);
    },
    [endAsrSession, sendAsrCommand, stopAsr],
  );

  /** 处理 asr.* 消息（同一连接上同一时间只有一个语音会话） */
  const handleAsrMessage = useCallback(
    (type: string, message: unknown) => {
      const session = asrRef.current;
      if (!session) return;
      if (type === 'asr.ready') {
        if (session.ready) return;
        session.ready = true;
        if (session.timer) {
          clearTimeout(session.timer);
          session.timer = null;
        }
        sendQueuedAudio(wsRef.current, session);
        if (session.finishRequested) sendAsrFinish(session);
        else setAsrPhase('recording');
        return;
      }
      if (type === 'asr.transcript') {
        const transcript = parseAsrTranscript(message);
        if (!transcript) return;
        if (transcript.isFinal === true) {
          session.committed.push(transcript.text);
          session.partial = '';
        } else {
          session.partial = transcript.text;
        }
        setAsrText(asrCombinedText(session));
        return;
      }
      if (type === 'asr.error') {
        endAsrSession({ error: readAsrError(message) || '语音识别失败' });
        return;
      }
      if (ASR_DONE_TYPES.test(type)) {
        let text = asrCombinedText(session);
        if (!text) text = parseAsrTranscript(message)?.text.trim() ?? '';
        endAsrSession({ text });
      }
    },
    [endAsrSession, sendAsrFinish],
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
    setAsrStatus(null);
    setAsrError(null);
    setAsrLoading(false);
    setDeviceResources(null);
    setResourcesLoading(false);
    setChatTurns([]);
    setChatSending(false);
    chatSessionIdRef.current = '';
    if (asrRef.current) endAsrSession({ error: '连接已断开，语音输入已取消' });
    clearVoiceBindTimer();
  }, [clearQueryTimer, clearVoiceBindTimer, endAsrSession]);

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
      if (action === 'playText' && !params.text?.trim()) {
        throw new Error('播报内容不能为空');
      }
      if (action === 'navigateToPoint') {
        if (!currentSnapshot?.deviceInfo.robotConnected) throw new Error('机器人尚未连接');
        if (!params.point?.trim() || !params.pointName?.trim()) {
          throw new Error('点位值和点位名称均不能为空');
        }
      }

      const normalizedParams: ActionParams = { ...params };
      if (action === 'textQuestion' || action === 'playText') normalizedParams.text = params.text?.trim();
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

  /** 语音识别状态（GET /api/v1/ai-models/asr/device-status/，只读） */
  const fetchAsrStatus = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig.deviceCode.trim()) return;
    setAsrLoading(true);
    try {
      const resp = await fetch(buildAsrDeviceStatusUrl(currentConfig), {
        headers: { 'X-Device-Code': currentConfig.deviceCode },
      });
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(readCloudError(data) || `HTTP ${resp.status}`);
      setAsrStatus(parseAsrDeviceStatus(data));
      setAsrError(null);
    } catch (reason) {
      const msg = reason instanceof Error ? reason.message : '未知错误';
      setAsrStatus(null);
      setAsrError(msg);
      appendLog('system', 'asr_status_error', `读取语音识别状态失败：${msg}`);
    } finally {
      setAsrLoading(false);
    }
  }, [appendLog]);

  /** 设备资源（POST /api/v1/device-runtime/resources/，resourceType=application，只读） */
  const fetchResources = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig.deviceCode.trim()) return;
    setResourcesLoading(true);
    try {
      const resp = await fetch(buildDeviceResourcesUrl(currentConfig), {
        method: 'POST',
        headers: { 'X-Device-Code': currentConfig.deviceCode, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceType: 'application' }),
      });
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(readCloudError(data) || `HTTP ${resp.status}`);
      const resources = extractDeviceResources(data);
      if (!resources) throw new Error('资源列表格式无法识别');
      setDeviceResources(resources);
    } catch (reason) {
      appendLog('system', 'resources_error', `读取设备资源失败：${reason instanceof Error ? reason.message : '未知错误'}`);
      throw reason;
    } finally {
      setResourcesLoading(false);
    }
  }, [appendLog]);

  /**
   * 问答测试（POST /api/v1/device/voice-chat/）。
   * 注意：会写入该设备的对话记录；同一会话内多轮回传 sessionId。
   */
  const sendChatTest = useCallback(
    async (text: string) => {
      const currentConfig = configRef.current;
      const question = text.trim();
      if (!currentConfig.deviceCode.trim()) throw new Error('设备号不能为空');
      if (!question) throw new Error('问题内容不能为空');
      chatCounterRef.current += 1;
      const turnId = `${Date.now()}-${chatCounterRef.current}`;
      setChatTurns((current) => [
        ...current,
        { id: turnId, question, result: null, error: null, pending: true, timestamp: new Date().toISOString() },
      ]);
      setChatSending(true);
      const body: Record<string, unknown> = { text: question };
      if (chatSessionIdRef.current) body.sessionId = chatSessionIdRef.current;
      const raw = JSON.stringify(body);
      appendLog('outgoing', 'http.voice_chat', raw);
      try {
        const resp = await fetch(buildVoiceChatUrl(currentConfig), {
          method: 'POST',
          headers: { 'X-Device-Code': currentConfig.deviceCode, 'Content-Type': 'application/json' },
          body: raw,
        });
        const data = await readJson(resp);
        appendLog('incoming', 'http.voice_chat', typeof data === 'string' ? data : JSON.stringify(data));
        if (!resp.ok) throw new Error(readCloudError(data) || `HTTP ${resp.status}`);
        const result = parseVoiceChatResult(data);
        if (result.sessionId) chatSessionIdRef.current = result.sessionId;
        setChatTurns((current) => current.map((t) => (t.id === turnId ? { ...t, result, pending: false } : t)));
        return result;
      } catch (reason) {
        const msg = reason instanceof Error ? reason.message : '问答失败';
        setChatTurns((current) => current.map((t) => (t.id === turnId ? { ...t, error: msg, pending: false } : t)));
        throw reason;
      } finally {
        setChatSending(false);
      }
    },
    [appendLog],
  );

  const resetChatTest = useCallback(() => {
    chatSessionIdRef.current = '';
    setChatTurns([]);
  }, []);

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
      activeServerRef.current = { server: configRef.current.server, port: configRef.current.port };
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
        rememberServer(activeServerRef.current.server, activeServerRef.current.port);
        requestState();
        fetchPoints();
        fetchTaskModes();
        fetchVoices();
        void fetchAsrStatus();
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
        // 识别中间结果很多，不记入实时报文，避免挤掉其他报文
        if (type !== 'asr.transcript') appendLog('incoming', type, raw);

        if (type.startsWith('asr.')) {
          handleAsrMessage(type, message);
          return;
        }

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
          const pushedResources = extractDeviceResources(message);
          if (pushedResources) setDeviceResources(pushedResources);
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
          if (asrRef.current && typeof err.id === 'string' && err.id.startsWith(asrRef.current.requestId)) {
            endAsrSession({ error: `${err.error?.message || '语音识别失败'}${err.error?.code ? `（${err.error.code}）` : ''}` });
            return;
          }
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
    [appendLog, applyBoundVoice, applyDeviceVoice, applyRuntimeDevice, applyRuntimePoints, clearRealtime, clearQueryTimer, clearVoiceBindTimer, fetchAsrStatus, fetchDeviceVoice, fetchPoints, fetchTaskModes, fetchVoices, endAsrSession, handleAsrMessage, rememberDevice, rememberServer, requestState],
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
      asrRef.current?.capture?.stop();
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
    serverHistory,
    asrStatus,
    asrError,
    asrLoading,
    deviceResources,
    resourcesLoading,
    chatTurns,
    chatSending,
    fetchAsrStatus,
    fetchResources,
    sendChatTest,
    resetChatTest,
    asrPhase,
    asrTarget,
    asrText,
    startAsr,
    stopAsr,
    cancelAsr,
    removeDeviceHistory: (code: string) => updateDeviceHistory((list) => list.filter((entry) => entry.code !== code)),
    clearDeviceHistory: () => updateDeviceHistory(() => []),
    saveServerToHistory: (server: string, port: string) => rememberServer(server, port, false),
    renameServerHistory: (server: string, port: string, name: string) =>
      updateServerHistory((list) =>
        list.map((entry) =>
          serverHistoryKey(entry.server, entry.port) === serverHistoryKey(server, port) ? { ...entry, name: name.trim() } : entry,
        ),
      ),
    removeServerHistory: (server: string, port: string) =>
      updateServerHistory((list) => list.filter((entry) => serverHistoryKey(entry.server, entry.port) !== serverHistoryKey(server, port))),
    clearServerHistory: () => updateServerHistory(() => []),
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
