import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  BatteryCharging,
  BatteryMedium,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  FileJson,
  Headphones,
  Info,
  ListTree,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  Mic,
  Navigation,
  Pause,
  Play,
  Power,
  RefreshCw,
  Send,
  Server,
  Settings2,
  ShieldAlert,
  SkipForward,
  Square,
  Terminal,
  Trash2,
  Unplug,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  buildRoutePoints,
  buildWebSocketUrl,
  getCurrentTasks,
  statusLabel,
  taskDisplayName,
  taskTypeLabel,
} from './protocol';
import type { ActionName, ActionParams, ButtonKey, ConnectionConfig, RoutePoint } from './protocol';
import { useController } from './useController';
import type { LogDirection } from './useController';

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  action: ActionName;
  params?: ActionParams;
}

type ModalState = { kind: 'confirm'; data: ConfirmState } | { kind: 'points' } | null;

const CONTROL_GROUPS: {
  title: string;
  description: string;
  actions: { key: ButtonKey; label: string; icon: LucideIcon; tone?: 'danger' | 'warning' }[];
}[] = [
  {
    title: '任务流程',
    description: '控制当前讲解与任务节奏',
    actions: [
      { key: 'pauseTask', label: '暂停任务', icon: Pause },
      { key: 'resumeTask', label: '继续任务', icon: Play },
      { key: 'skipCurrentTask', label: '跳过当前', icon: SkipForward },
      { key: 'endTask', label: '结束流程', icon: Square, tone: 'warning' },
    ],
  },
  {
    title: '对话与语音',
    description: '管理对话、播报和录音',
    actions: [
      { key: 'startDialogue', label: '开始对话', icon: MessageSquareText },
      { key: 'interruptDialogue', label: '打断对话', icon: Zap },
      { key: 'endDialogue', label: '结束对话', icon: CircleStop },
      { key: 'endRecording', label: '结束录音', icon: Mic },
    ],
  },
  {
    title: '机器人',
    description: '导航与整机操作',
    actions: [
      { key: 'stopNavigation', label: '停止导航', icon: Navigation, tone: 'warning' },
      { key: 'shutdownRobot', label: '机器人关机', icon: Power, tone: 'danger' },
    ],
  },
];

const CONNECTION_LABELS = {
  disconnected: '未连接',
  connecting: '正在连接',
  reconnecting: '等待重连',
  connected: '服务已连接',
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function prettyRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Modal({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal-panel ${wide ? 'modal-panel--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭对话框">
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Icon size={24} strokeWidth={1.6} /></span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function App() {
  const controller = useController();
  const {
    config,
    setConfig,
    status,
    snapshot,
    screenOnline,
    canControl,
    error,
    logs,
    activeUrl,
    configDirty,
    isQuerying,
    lastReceivedAt,
  } = controller;
  const [question, setQuestion] = useState('');
  const [point, setPoint] = useState('');
  const [pointName, setPointName] = useState('');
  const [showDeviceCode, setShowDeviceCode] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | LogDirection>('all');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const routePoints = useMemo(() => buildRoutePoints(snapshot, canControl), [snapshot, canControl]);
  const { task, innerTask } = getCurrentTasks(snapshot);
  const socketPreview = useMemo(() => {
    try {
      return buildWebSocketUrl(config);
    } catch {
      return '等待有效的服务器配置';
    }
  }, [config]);
  const filteredLogs = logs.filter((entry) => logFilter === 'all' || entry.direction === logFilter);
  const isActive = status !== 'disconnected';

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const notify = (message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ message, tone });
  };

  const updateConfig = (key: keyof ConnectionConfig, value: string) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const execute = (action: ActionName, params: ActionParams = {}) => {
    try {
      controller.sendAction(action, params);
      setModal(null);
      if (action === 'textQuestion') setQuestion('');
      notify('指令已发送，等待设备状态更新');
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : '指令发送失败', 'error');
      return false;
    }
  };

  const requestAction = (key: ButtonKey) => {
    const confirmations: Partial<Record<ButtonKey, ConfirmState>> = {
      endTask: {
        title: '结束当前任务流程？',
        description: '当前任务及其后续执行将被结束，设备会以新的状态快照确认结果。',
        confirmLabel: '结束流程',
        action: 'endTask',
        tone: 'danger',
      },
      stopNavigation: {
        title: '停止当前导航？',
        description: '导航将停止并清理相关任务，请确认机器人当前可以安全停下。',
        confirmLabel: '停止导航',
        action: 'stopNavigation',
        tone: 'danger',
      },
      shutdownRobot: {
        title: '确认将机器人关机？',
        description: '整机关机后需要现场重新启动。请确保机器人处于安全环境，且没有正在进行的必要任务。',
        confirmLabel: '确认关机',
        action: 'shutdownRobot',
        tone: 'danger',
      },
    };
    const confirmation = confirmations[key];
    if (confirmation) setModal({ kind: 'confirm', data: confirmation });
    else execute(key);
  };

  const requestJump = (routePoint: RoutePoint) => {
    if (!routePoint.canNavigate) return;
    setModal({
      kind: 'confirm',
      data: {
        title: `跳转到“${routePoint.name}”？`,
        description: `将结束当前执行，从主任务 ${routePoint.rootIndex + 1}（步骤 ${routePoint.stepId}）重新派发后续任务。`,
        confirmLabel: '确认跳转',
        action: 'jumpToNavigationStep',
        params: { stepId: routePoint.stepId },
      },
    });
  };

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    execute('textQuestion', { text: question });
  };

  const submitDirectNavigation = (event: FormEvent) => {
    event.preventDefault();
    if (!point.trim() || !pointName.trim() || !canControl) return;
    setModal({
      kind: 'confirm',
      data: {
        title: `导航到“${pointName.trim()}”？`,
        description: `将使用点位值 ${point.trim()} 发起独立导航，不改变当前任务树中的步骤索引。`,
        confirmLabel: '开始导航',
        action: 'navigateToPoint',
        params: { point, pointName },
      },
    });
  };

  const copyDeviceCode = async () => {
    try {
      await navigator.clipboard.writeText(config.deviceCode);
      notify('设备号已复制');
    } catch {
      notify('复制失败，请手动选择设备号', 'error');
    }
  };

  const routeWindow = useMemo(() => {
    const capacity = 6;
    if (routePoints.length <= capacity) return routePoints;
    const activeIndex = routePoints.findIndex((item) => item.progress === 'active');
    const pendingIndex = routePoints.findIndex((item) => item.progress === 'pending');
    const focus = activeIndex >= 0 ? activeIndex : pendingIndex >= 0 ? pendingIndex : routePoints.length - 1;
    const start = Math.max(0, Math.min(focus - 2, routePoints.length - capacity));
    return routePoints.slice(start, start + capacity);
  }, [routePoints]);

  const deviceStatus = screenOnline === true ? '在线' : screenOnline === false ? '离线' : '未知';
  const flowName = snapshot ? (snapshot.command?.name ?? '无任务流程') : '等待设备状态';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <div>
            <strong>数字人控制台</strong>
            <span>DIGITAL HUMAN / OPS</span>
          </div>
        </div>

        <div className="sidebar-section connection-section">
          <div className="sidebar-heading">
            <span><Settings2 size={16} />连接配置</span>
            <span className={`connection-dot connection-dot--${status}`} title={CONNECTION_LABELS[status]} />
          </div>

          <label className="field-label" htmlFor="server">服务器地址</label>
          <div className="dark-input-wrap">
            <Server size={16} />
            <input
              id="server"
              value={config.server}
              onChange={(event) => updateConfig('server', event.target.value)}
              placeholder="http://192.168.3.248"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <label className="field-label" htmlFor="port">端口</label>
          <div className="dark-input-wrap">
            <Unplug size={16} />
            <input
              id="port"
              value={config.port}
              onChange={(event) => updateConfig('port', event.target.value)}
              inputMode="numeric"
              placeholder="8880"
              autoComplete="off"
            />
          </div>

          <label className="field-label" htmlFor="deviceCode">设备号</label>
          <div className="dark-input-wrap dark-input-wrap--code">
            <Bot size={16} />
            <input
              id="deviceCode"
              type={showDeviceCode ? 'text' : 'password'}
              value={config.deviceCode}
              onChange={(event) => updateConfig('deviceCode', event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowDeviceCode((visible) => !visible)}
              aria-label={showDeviceCode ? '隐藏设备号' : '显示设备号'}
            >
              {showDeviceCode ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button type="button" onClick={copyDeviceCode} aria-label="复制设备号"><Copy size={15} /></button>
          </div>

          <div className="socket-preview">
            <span>WebSocket 端点</span>
            <code title={socketPreview}>{socketPreview}</code>
          </div>

          {configDirty && isActive && (
            <p className="config-notice"><Info size={14} />配置已修改，重连后生效。</p>
          )}

          <div className="connection-actions">
            {(!isActive || configDirty) && (
              <button
                className="button button--accent button--full"
                type="button"
                onClick={() => controller.connect()}
              >
                <Wifi size={16} />{configDirty && isActive ? '保存并重连' : '连接设备'}
              </button>
            )}
            {isActive && (
              <button className="button button--dark button--full" type="button" onClick={controller.disconnect}>
                <Unplug size={16} />{status === 'connected' && !configDirty ? '断开连接' : '取消连接'}
              </button>
            )}
          </div>
        </div>

        <div className="sidebar-status">
          <div className="sidebar-status__row">
            <span>服务通道</span>
            <strong className={`text-status text-status--${status}`}>{CONNECTION_LABELS[status]}</strong>
          </div>
          <div className="sidebar-status__row">
            <span>设备状态</span>
            <strong>{deviceStatus}</strong>
          </div>
          <div className="sidebar-status__row">
            <span>最近快照</span>
            <strong>{formatTime(lastReceivedAt)}</strong>
          </div>
        </div>

        <div className="sidebar-footnote">
          <ShieldAlert size={15} />
          <p>控制动作不做本地成功预判，以设备最新完整快照为准。</p>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar-kicker">OPERATIONS CONSOLE</span>
            <h1>任务与设备控制</h1>
          </div>
          <div className="topbar-actions">
            <span className="protocol-badge"><FileJson size={14} />协议 v1.23</span>
            <span className={`service-badge service-badge--${status}`}>
              {status === 'connecting' || status === 'reconnecting' ? (
                <LoaderCircle size={14} className="spin" />
              ) : status === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />}
              {CONNECTION_LABELS[status]}
            </span>
            <button
              className="button button--light button--compact"
              type="button"
              onClick={controller.requestState}
              disabled={status !== 'connected' || isQuerying}
              title={status === 'connected' ? '获取最新完整状态' : '连接后可刷新状态'}
            >
              <RefreshCw size={15} className={isQuerying ? 'spin' : ''} />
              {isQuerying ? '获取中' : '刷新状态'}
            </button>
          </div>
        </header>

        <main className="main-content">
          {error && (
            <div className="error-banner" role="alert">
              <Info size={18} />
              <span>{error}</span>
              <button type="button" onClick={controller.clearError} aria-label="关闭错误提示"><X size={17} /></button>
            </div>
          )}

          <section className="device-banner" aria-labelledby="device-name">
            <div className="device-identity">
              <div className="device-avatar"><Bot size={30} strokeWidth={1.5} /></div>
              <div>
                <div className="device-eyebrow">
                  <span className={`live-dot ${screenOnline === true ? 'live-dot--online' : ''}`} />
                  设备 {deviceStatus}
                </div>
                <h2 id="device-name">{snapshot?.deviceInfo.deviceName || '尚未获取设备信息'}</h2>
                <p>{snapshot ? '设备完整状态已同步' : '连接服务器后，将在此展示数字人与机器人状态'}</p>
              </div>
            </div>
            <div className="device-metrics">
              <div className="device-metric">
                <span><Activity size={15} />机器人</span>
                <strong>{snapshot ? (snapshot.deviceInfo.robotConnected ? '已连接' : '未连接') : '—'}</strong>
                <small className={snapshot && !snapshot.deviceInfo.robotNormal ? 'metric-warning' : ''}>
                  {snapshot ? (snapshot.deviceInfo.robotNormal ? '运行正常' : snapshot.deviceInfo.robotErrorMessage || '状态异常') : '等待状态'}
                </small>
              </div>
              <div className="device-metric">
                <span><BatteryMedium size={15} />电池电量</span>
                <strong>{snapshot?.deviceInfo.robotBatteryPercent ?? '—'}{snapshot?.deviceInfo.robotBatteryPercent != null && '%'}</strong>
                <small>{snapshot?.deviceInfo.robotCharging ? <><BatteryCharging size={12} />正在充电</> : snapshot ? '未在充电' : '等待状态'}</small>
              </div>
              <div className="device-metric">
                <span><Navigation size={15} />机器人 IP</span>
                <strong className="metric-code">{snapshot?.deviceInfo.robotIp || '—'}</strong>
                <small>{snapshot?.deviceInfo.robotConnected ? '网络已关联' : '等待连接'}</small>
              </div>
            </div>
          </section>

          <div className="dashboard-grid">
            <div className="primary-column">
              <section className="panel current-task-panel" aria-labelledby="current-task-title">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">CURRENT TASK</span>
                    <h2 id="current-task-title">当前任务</h2>
                  </div>
                  {snapshot && (
                    <span className={`status-chip status-chip--${snapshot.taskState.status.toLowerCase()}`}>
                      {statusLabel(snapshot.taskState.status)}
                    </span>
                  )}
                </div>

                {snapshot && task ? (
                  <div className="task-detail">
                    <div className="task-sequence">
                      <span>主任务</span>
                      <strong>{String(snapshot.taskState.taskIndex + 1).padStart(2, '0')}</strong>
                      <small>/ {String(snapshot.command?.tasks.length ?? 0).padStart(2, '0')}</small>
                    </div>
                    <div className="task-copy">
                      <span className="task-kind">{taskTypeLabel(task)}</span>
                      <h3 title={taskDisplayName(task)}>{taskDisplayName(task)}</h3>
                      <p>{statusLabel(snapshot.taskState.status)}</p>
                    </div>
                    {innerTask && (
                      <div className="inner-task">
                        <span className="inner-task__icon"><Headphones size={18} /></span>
                        <div>
                          <span>子任务 {snapshot.taskState.innerTaskIndex + 1} · {taskTypeLabel(innerTask)}</span>
                          <strong title={taskDisplayName(innerTask)}>{taskDisplayName(innerTask)}</strong>
                        </div>
                        <small>{statusLabel(snapshot.taskState.innerTaskStatus)}</small>
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    icon={ListTree}
                    title={snapshot ? '当前任务：无' : '正在等待任务状态'}
                    description={snapshot ? '设备当前处于空闲状态，可以发起对话或独立导航。' : '连接成功后会自动发送 getState，获取当前主任务和子任务。'}
                  />
                )}
              </section>

              <section className="panel route-panel" aria-labelledby="route-title">
                <div className="panel-heading route-heading">
                  <div>
                    <span className="eyebrow">ROUTE PREVIEW</span>
                    <h2 id="route-title">{flowName}</h2>
                  </div>
                  <div className="route-heading__meta">
                    <span>{routePoints.length} 个导航点</span>
                    {routePoints.length > 0 && (
                      <button className="text-button" type="button" onClick={() => setModal({ kind: 'points' })}>
                        全部点位 <ChevronRight size={15} />
                      </button>
                    )}
                  </div>
                </div>

                {routePoints.length ? (
                  <>
                    <ol className="route-track">
                      {routeWindow.map((routePoint) => {
                        const originalIndex = routePoints.findIndex((item) => item.key === routePoint.key);
                        return (
                          <li
                            className={`route-stop route-stop--${routePoint.progress}`}
                            key={routePoint.key}
                          >
                            <button
                              type="button"
                              className="route-stop__button"
                              disabled={!routePoint.canNavigate}
                              onClick={() => requestJump(routePoint)}
                              aria-label={`${routePoint.name}，${routePoint.progress === 'active' ? '当前任务' : routePoint.progress === 'completed' ? '位置已完成' : '待执行'}${routePoint.canNavigate ? '，点击跳转' : ''}`}
                              title={routePoint.canNavigate ? `跳转到 ${routePoint.name}` : routePoint.name}
                            >
                              <span className="route-node">
                                {routePoint.progress === 'completed' ? <Check size={18} strokeWidth={2.5} /> : originalIndex + 1}
                              </span>
                              <span className="route-stop__name">{routePoint.name}</span>
                              <span className="route-stop__status">
                                {routePoint.progress === 'active' ? '当前位置' : routePoint.progress === 'completed' ? '前序位置' : '待执行'}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                    <div className="route-legend">
                      <span><i className="legend-dot legend-dot--completed" />前序</span>
                      <span><i className="legend-dot legend-dot--active" />当前</span>
                      <span><i className="legend-dot" />待执行</span>
                      <small>点击可用点位可跳转 · 暂停时需先继续任务</small>
                    </div>
                  </>
                ) : (
                  <EmptyState
                    icon={MapPin}
                    title={snapshot ? '暂无可显示轨迹' : '轨迹等待同步'}
                    description={snapshot?.command ? '任务树中没有满足显示条件的根导航任务。' : '轨迹仅展示流程中的可见根导航任务，不代表机器人实际运动路径。'}
                  />
                )}
              </section>
            </div>

            <div className="control-column">
              <section className="panel controls-panel" aria-labelledby="controls-title">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">DEVICE ACTIONS</span>
                    <h2 id="controls-title">控制动作</h2>
                  </div>
                  <span className={`availability-dot ${canControl ? 'availability-dot--ready' : ''}`}>
                    {canControl ? '可控制' : '已锁定'}
                  </span>
                </div>

                <div className="control-groups">
                  {CONTROL_GROUPS.map((group) => (
                    <div className="control-group" key={group.title}>
                      <div className="control-group__heading">
                        <strong>{group.title}</strong>
                        <span>{group.description}</span>
                      </div>
                      <div className="control-grid">
                        {group.actions.map(({ key, label, icon: Icon, tone }) => {
                          const enabled = Boolean(canControl && snapshot?.buttons[key]);
                          return (
                            <button
                              className={`control-button ${tone ? `control-button--${tone}` : ''}`}
                              type="button"
                              key={key}
                              disabled={!enabled}
                              onClick={() => requestAction(key)}
                              title={!canControl ? '等待可控制的设备快照' : !snapshot?.buttons[key] ? '当前设备状态不允许此操作' : label}
                            >
                              <Icon size={17} strokeWidth={1.8} />
                              <span>{label}</span>
                              <ArrowRight size={13} className="control-button__arrow" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="panel question-panel" aria-labelledby="question-title">
                <div className="compact-heading">
                  <span className="compact-heading__icon"><MessageSquareText size={18} /></span>
                  <div><h2 id="question-title">文本提问</h2><p>按正常问答流程处理</p></div>
                </div>
                <form onSubmit={submitQuestion}>
                  <label className="sr-only" htmlFor="question">输入向数字人提出的问题</label>
                  <textarea
                    id="question"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        if (canControl && question.trim()) execute('textQuestion', { text: question });
                      }
                    }}
                    placeholder="例如：请介绍一下序厅的主要内容。"
                    maxLength={500}
                    rows={3}
                  />
                  <div className="form-footer">
                    <span>Ctrl + Enter 发送 · {question.length}/500</span>
                    <button className="button button--primary button--compact" type="submit" disabled={!canControl || !question.trim()}>
                      <Send size={14} />发送
                    </button>
                  </div>
                </form>
              </section>

              <section className="panel direct-panel" aria-labelledby="direct-title">
                <div className="compact-heading">
                  <span className="compact-heading__icon"><MapPin size={18} /></span>
                  <div><h2 id="direct-title">直达导航</h2><p>独立点位导航，不改变任务索引</p></div>
                </div>
                <form onSubmit={submitDirectNavigation}>
                  <div className="direct-fields">
                    <div>
                      <label htmlFor="point">点位值</label>
                      <input id="point" value={point} onChange={(event) => setPoint(event.target.value)} placeholder="例如 cdz" autoComplete="off" />
                    </div>
                    <div>
                      <label htmlFor="pointName">点位名称</label>
                      <input id="pointName" value={pointName} onChange={(event) => setPointName(event.target.value)} placeholder="例如 会议室" />
                    </div>
                  </div>
                  <button
                    className="button button--outline button--full"
                    type="submit"
                    disabled={!canControl || !snapshot?.deviceInfo.robotConnected || !point.trim() || !pointName.trim()}
                  >
                    <Navigation size={15} />导航到此点位
                  </button>
                </form>
              </section>
            </div>
          </div>

          <section className="panel logs-panel" aria-labelledby="logs-title">
            <div className="logs-heading">
              <div className="compact-heading">
                <span className="compact-heading__icon"><Terminal size={18} /></span>
                <div><h2 id="logs-title">实时报文</h2><p>保留最近 50 条，点击展开原始 JSON</p></div>
              </div>
              <div className="logs-tools">
                <div className="log-filters" aria-label="报文筛选">
                  {([
                    ['all', '全部'],
                    ['incoming', '接收'],
                    ['outgoing', '发送'],
                    ['system', '系统'],
                  ] as const).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={logFilter === value ? 'is-active' : ''}
                      onClick={() => setLogFilter(value)}
                      aria-pressed={logFilter === value}
                    >{label}</button>
                  ))}
                </div>
                <button className="icon-button" type="button" onClick={controller.clearLogs} disabled={!logs.length} aria-label="清空报文" title="清空报文">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            {filteredLogs.length ? (
              <div className="log-list">
                {filteredLogs.map((entry) => {
                  const expanded = expandedLog === entry.id;
                  return (
                    <div className={`log-entry ${expanded ? 'log-entry--expanded' : ''}`} key={entry.id}>
                      <button
                        type="button"
                        className="log-entry__summary"
                        onClick={() => setExpandedLog(expanded ? null : entry.id)}
                        aria-expanded={expanded}
                      >
                        <span className={`log-direction log-direction--${entry.direction}`}>
                          {entry.direction === 'incoming' ? '接收' : entry.direction === 'outgoing' ? '发送' : '系统'}
                        </span>
                        <code>{entry.type}</code>
                        <span className="log-preview">{entry.raw}</span>
                        <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
                        <ChevronDown size={15} className={expanded ? 'rotate-180' : ''} />
                      </button>
                      {expanded && <pre>{prettyRaw(entry.raw)}</pre>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="logs-empty"><Clock3 size={17} />{logs.length ? '当前筛选下没有报文' : '连接后可在这里核对发送与接收的原始消息'}</div>
            )}
          </section>

          <footer className="workspace-footer">
            <span><Ellipsis size={14} />{activeUrl || socketPreview}</span>
            <span>WebSocket / JSON · 完整快照驱动</span>
          </footer>
        </main>
      </div>

      {modal?.kind === 'confirm' && (
        <Modal title={modal.data.title} eyebrow="ACTION CONFIRMATION" onClose={() => setModal(null)}>
          <div className={`confirm-symbol ${modal.data.tone === 'danger' ? 'confirm-symbol--danger' : ''}`}>
            {modal.data.tone === 'danger' ? <ShieldAlert size={24} /> : <Navigation size={24} />}
          </div>
          <p className="confirm-description">{modal.data.description}</p>
          <div className="confirm-note"><Info size={15} />确认时会再次按最新设备状态校验，不会重发断线前的动作。</div>
          <div className="modal-actions">
            <button className="button button--light" type="button" onClick={() => setModal(null)}>取消</button>
            <button
              className={`button ${modal.data.tone === 'danger' ? 'button--danger' : 'button--primary'}`}
              type="button"
              onClick={() => execute(modal.data.action, modal.data.params)}
            >
              {modal.data.confirmLabel}<ArrowRight size={15} />
            </button>
          </div>
        </Modal>
      )}

      {modal?.kind === 'points' && (
        <Modal title={flowName} eyebrow={`ALL ROUTE POINTS / ${routePoints.length}`} onClose={() => setModal(null)} wide>
          <p className="modal-intro">轨迹顺序与原始根任务数组一致；序号对应可见轨迹点，跳转使用节点的 step_id。</p>
          <div className="all-points-list">
            {routePoints.map((routePoint, index) => (
              <div className="all-point" key={routePoint.key}>
                <span className={`all-point__node all-point__node--${routePoint.progress}`}>
                  {routePoint.progress === 'completed' ? <Check size={16} /> : index + 1}
                </span>
                <div className="all-point__copy">
                  <strong>{routePoint.name}</strong>
                  <span>主任务 {routePoint.rootIndex + 1} · step_id {routePoint.stepId}</span>
                </div>
                <span className="all-point__status">
                  {routePoint.progress === 'active' ? '当前位置' : routePoint.progress === 'completed' ? '前序位置' : '待执行'}
                </span>
                <button
                  className="button button--light button--compact"
                  type="button"
                  disabled={!routePoint.canNavigate}
                  onClick={() => requestJump(routePoint)}
                >
                  跳转<ChevronRight size={14} />
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {toast && (
        <div className={`toast toast--${toast.tone}`} role="status">
          {toast.tone === 'success' ? <CheckCircle2 size={18} /> : <Info size={18} />}
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="关闭提示"><X size={15} /></button>
        </div>
      )}
    </div>
  );
}

export default App;
