import { useMemo, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Layout,
  List,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Statistic,
  Steps,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  BulbOutlined,
  InfoCircleOutlined,
  SafetyCertificateOutlined,
  AudioOutlined,
  ThunderboltOutlined as BatteryChargingIcon,
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EnvironmentOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FastForwardOutlined,
  HistoryOutlined,
  LinkOutlined,
  LoadingOutlined,
  MessageOutlined,
  NodeIndexOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
  SoundOutlined,
  StopOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ActionName, ButtonKey, PointItem, RoutePoint, VoiceTone } from './protocol';
import type { ActionParams, ConnectionConfig } from './protocol';
import {
  buildRoutePoints,
  buildWebSocketUrl,
  getCurrentTasks,
  statusLabel,
  taskDisplayName,
  taskTypeLabel,
} from './protocol';
import { useController } from './useController';
import type { LogDirection } from './useController';

const { Header, Sider, Content } = Layout;
const { Text, Paragraph, Title } = Typography;

const CONNECTION_LABELS: Record<string, string> = {
  disconnected: '未连接',
  connecting: '正在连接',
  reconnecting: '等待重连',
  connected: '服务已连接',
};

const CONNECTION_COLORS: Record<string, string> = {
  disconnected: 'default',
  connecting: 'processing',
  reconnecting: 'processing',
  connected: 'success',
};

interface ControlItem {
  key: ButtonKey;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  confirmTitle?: string;
  confirmContent?: string;
}

const CONTROL_GROUPS: { title: string; description: string; items: ControlItem[] }[] = [
  {
    title: '任务流程',
    description: '控制当前讲解与任务节奏',
    items: [
      { key: 'pauseTask', label: '暂停任务', icon: <PauseCircleOutlined /> },
      { key: 'resumeTask', label: '继续任务', icon: <PlayCircleOutlined /> },
      { key: 'skipCurrentTask', label: '跳过当前', icon: <FastForwardOutlined /> },
      { key: 'endTask', label: '结束流程', icon: <StopOutlined />, danger: true, confirmTitle: '结束当前任务流程？', confirmContent: '当前任务及其后续执行将被结束，设备会以新的状态快照确认结果。' },
    ],
  },
  {
    title: '对话与语音',
    description: '管理对话、播报和录音',
    items: [
      { key: 'startDialogue', label: '开始对话', icon: <MessageOutlined /> },
      { key: 'interruptDialogue', label: '打断对话', icon: <ThunderboltOutlined /> },
      { key: 'endDialogue', label: '结束对话', icon: <CloseCircleOutlined /> },
      { key: 'endRecording', label: '结束录音', icon: <AudioOutlined /> },
    ],
  },
  {
    title: '机器人',
    description: '导航与整机操作',
    items: [
      { key: 'stopNavigation', label: '停止导航', icon: <EnvironmentOutlined />, danger: true, confirmTitle: '停止当前导航？', confirmContent: '导航将停止并清理相关任务，请确认机器人当前可以安全停下。' },
      { key: 'shutdownRobot', label: '机器人关机', icon: <PoweroffOutlined />, danger: true, confirmTitle: '确认将机器人关机？', confirmContent: '整机关机后需要现场重新启动。请确保机器人处于安全环境，且没有正在进行的必要任务。' },
    ],
  },
];

/** 导航路线在卡片中最多直接显示的点位数 */
const ROUTE_WINDOW = 7;

const MODE_GROUPS: { key: 'explain' | 'guide' | 'unassigned'; label: string; color?: string; icon: ReactNode }[] = [
  { key: 'explain', label: '讲解', color: 'blue', icon: <NodeIndexOutlined /> },
  { key: 'guide', label: '带路', color: 'green', icon: <EnvironmentOutlined /> },
  { key: 'unassigned', label: '未分配', icon: <ThunderboltOutlined /> },
];

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

function statusTagColor(status: string): string {
  const map: Record<string, string> = {
    idle: 'default',
    not_started: 'default',
    preparing: 'processing',
    in_progress: 'processing',
    paused: 'warning',
    task_completed: 'cyan',
    waiting: 'processing',
    completed: 'success',
    skipped: 'default',
  };
  return map[status.toLowerCase()] ?? 'default';
}

function routeProgressColor(progress: string): string {
  if (progress === 'completed') return '#52c41a';
  if (progress === 'active') return '#1677ff';
  return '#d9d9d9';
}

function genderLabel(gender: string): string {
  const g = gender.trim().toLowerCase();
  if (['male', 'm', '男', '男声'].includes(g)) return '男声';
  if (['female', 'f', '女', '女声'].includes(g)) return '女声';
  if (['child', 'kid', '童', '童声'].includes(g)) return '童声';
  return gender.trim();
}

const LOG_DIR_LABELS: Record<LogDirection, string> = {
  incoming: '接收',
  outgoing: '发送',
  system: '系统',
};

const LOG_DIR_COLORS: Record<LogDirection, string> = {
  incoming: 'green',
  outgoing: 'blue',
  system: 'default',
};

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
  } = controller;

  const [question, setQuestion] = useState('');
  const [point, setPoint] = useState('');
  const [pointName, setPointName] = useState('');
  const [showDeviceCode, setShowDeviceCode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pointsModalOpen, setPointsModalOpen] = useState(false);
  const [flowModalOpen, setFlowModalOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | LogDirection>('all');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [lastSeenLogId, setLastSeenLogId] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [voiceKeyword, setVoiceKeyword] = useState('');
  const [voiceGender, setVoiceGender] = useState<string>('all');
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const [bindingId, setBindingId] = useState<number | null>(null);
  const [showHiddenPoints, setShowHiddenPoints] = useState(true);
  const [routeKeyword, setRouteKeyword] = useState('');
  const [routeFilter, setRouteFilter] = useState<'all' | 'pending' | 'completed'>('all');

  const routePoints = useMemo(() => buildRoutePoints(snapshot, canControl), [snapshot, canControl]);
  const { task, innerTask } = getCurrentTasks(snapshot);
  const routeStats = useMemo(() => {
    const done = routePoints.filter((p) => p.progress === 'completed').length;
    const pending = routePoints.length - done; // 含当前点位
    const active = routePoints.some((p) => p.progress === 'active') ? 1 : 0;
    const total = routePoints.length;
    return { done, pending, percent: total ? Math.round(((done + active * 0.5) / total) * 100) : 0 };
  }, [routePoints]);
  // 路线窗口：点位多时只显示当前点位附近的 ROUTE_WINDOW 个
  const routeWindow = useMemo(() => {
    const total = routePoints.length;
    if (total <= ROUTE_WINDOW) return { start: 0, end: total, items: routePoints };
    const activeIdx = routePoints.findIndex((p) => p.progress === 'active');
    const center = activeIdx >= 0 ? activeIdx : routeStats.done;
    const start = Math.min(Math.max(center - 2, 0), total - ROUTE_WINDOW);
    const end = start + ROUTE_WINDOW;
    return { start, end, items: routePoints.slice(start, end) };
  }, [routePoints, routeStats.done]);
  const filteredRoutePoints = useMemo(() => {
    const kw = routeKeyword.trim().toLowerCase();
    return routePoints.filter((p) => {
      if (routeFilter === 'pending' && p.progress === 'completed') return false;
      if (routeFilter === 'completed' && p.progress !== 'completed') return false;
      if (!kw) return true;
      return p.name.toLowerCase().includes(kw) || p.point.toLowerCase().includes(kw);
    });
  }, [routePoints, routeKeyword, routeFilter]);
  const socketPreview = useMemo(() => {
    try {
      return buildWebSocketUrl(config);
    } catch {
      return '等待有效的服务器配置';
    }
  }, [config]);
  const filteredLogs = logs.filter((entry) => logFilter === 'all' || entry.direction === logFilter);
  const isActive = status !== 'disconnected';
  const robotConnected = Boolean(snapshot?.deviceInfo.robotConnected);
  const canNavigate = canControl && robotConnected;

  // 未读报文数（logs 按时间倒序排列）
  const unreadLogs = useMemo(() => {
    if (logDrawerOpen) return 0;
    if (!lastSeenLogId) return logs.length;
    const idx = logs.findIndex((l) => l.id === lastSeenLogId);
    return idx === -1 ? logs.length : idx;
  }, [logs, lastSeenLogId, logDrawerOpen]);

  const voiceGenders = useMemo(() => {
    const set = new Set<string>();
    voiceTones.forEach((v) => {
      const label = v.gender ? genderLabel(v.gender) : '';
      if (label) set.add(label);
    });
    return Array.from(set);
  }, [voiceTones]);

  const filteredVoices = useMemo(() => {
    const kw = voiceKeyword.trim().toLowerCase();
    return voiceTones.filter((v) => {
      if (voiceGender !== 'all' && genderLabel(v.gender || '') !== voiceGender) return false;
      if (!kw) return true;
      return v.displayName.toLowerCase().includes(kw) || v.voiceCode.toLowerCase().includes(kw);
    });
  }, [voiceTones, voiceKeyword, voiceGender]);

  const visiblePoints = useMemo(
    () => (pointGroup?.points ?? []).filter((p) => showHiddenPoints || p.isUiVisible),
    [pointGroup, showHiddenPoints],
  );
  const hiddenPointCount = (pointGroup?.points ?? []).filter((p) => !p.isUiVisible).length;

  const notify = (msg: string, type: 'success' | 'error' = 'success') => {
    messageApi[type](msg);
  };

  const updateConfig = (key: keyof ConnectionConfig, value: string) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const execute = (action: ActionName, params: ActionParams = {}) => {
    try {
      controller.sendAction(action, params);
      if (action === 'textQuestion') setQuestion('');
      notify('指令已发送，等待设备状态更新');
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : '指令发送失败', 'error');
      return false;
    }
  };

  const handleControlClick = (item: ControlItem) => {
    if (item.confirmTitle) {
      Modal.confirm({
        title: item.confirmTitle,
        content: item.confirmContent,
        okText: item.label,
        okType: 'danger',
        cancelText: '取消',
        onOk: () => execute(item.key),
      });
    } else {
      execute(item.key);
    }
  };

  const requestJump = (routePoint: RoutePoint) => {
    if (!routePoint.canNavigate) return;
    Modal.confirm({
      title: `跳转到"${routePoint.name}"？`,
      content: `将结束当前执行，从主任务 ${routePoint.rootIndex + 1}（步骤 ${routePoint.stepId}）重新派发后续任务。`,
      okText: '确认跳转',
      cancelText: '取消',
      onOk: () => execute('jumpToNavigationStep', { stepId: routePoint.stepId }),
    });
  };

  const requestTaskMode = (name: string) => {
    if (!canControl) return;
    Modal.confirm({
      title: `发起任务流程"${name}"？`,
      content: '将通过文本提问方式向设备发送该任务指令，设备会根据当前状态处理。',
      okText: '确认',
      cancelText: '取消',
      onOk: () => execute('textQuestion', { text: name }),
    });
  };

  const submitQuestion = (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    execute('textQuestion', { text: question });
  };

  const navigateDirect = (targetPoint: string, targetPointName: string) => {
    if (!targetPoint || !targetPointName || !canNavigate) return;
    Modal.confirm({
      title: `导航到"${targetPointName}"？`,
      content: `将使用点位值 ${targetPoint} 发起独立导航，不改变当前任务树中的步骤索引。`,
      okText: '开始导航',
      cancelText: '取消',
      onOk: () => execute('navigateToPoint', { point: targetPoint, pointName: targetPointName }),
    });
  };

  const submitDirectNavigation = (e: FormEvent) => {
    e.preventDefault();
    if (!point.trim() || !pointName.trim() || !canNavigate) return;
    navigateDirect(point.trim(), pointName.trim());
  };

  const handlePreview = (vt: VoiceTone) => {
    setPreviewingId(vt.id);
    controller.previewVoice(vt).catch((reason: unknown) => {
      notify(reason instanceof Error ? `试听失败：${reason.message}` : '试听失败', 'error');
    });
  };

  const handleBind = (vt: VoiceTone) => {
    Modal.confirm({
      title: `绑定音色"${vt.displayName}"？`,
      content: '将通过 WebSocket 向设备发送音色绑定指令，设备会使用此音色进行语音合成。',
      okText: '确认绑定',
      cancelText: '取消',
      onOk: () => {
        try {
          setBindingId(vt.id);
          controller.bindVoice(vt);
          notify('音色绑定指令已发送');
        } catch (reason) {
          notify(reason instanceof Error ? reason.message : '音色绑定失败', 'error');
        }
      },
    });
  };

  const openLogDrawer = () => setLogDrawerOpen(true);
  const closeLogDrawer = () => {
    setLogDrawerOpen(false);
    setLastSeenLogId(logs[0]?.id ?? null);
  };

  const maskDeviceCode = (code: string) => (code.length > 14 ? `${code.slice(0, 6)}…${code.slice(-4)}` : code);

  /** 设备名称：优先云端运行时配置 device.name，其次设备状态快照里的 deviceName */
  const deviceName = runtimeDevice?.name || snapshot?.deviceInfo.deviceName || '';
  const currentCode = config.deviceCode.trim();
  const historyName = deviceHistory.find((entry) => entry.code === currentCode)?.name ?? '';
  const inputDeviceName = (!configDirty && runtimeDevice?.name) || historyName;

  const selectHistoryDevice = (code: string) => {
    const entry = deviceHistory.find((item) => item.code === code);
    updateConfig('deviceCode', code);
    setHistoryOpen(false);
    notify(`已选择设备：${entry?.name || maskDeviceCode(code)}`);
  };

  const suggestedQuestions = runtimeDevice?.suggestedQuestions ?? [];

  const askSuggested = (text: string) => {
    if (!canControl) {
      notify('设备不可控制，暂时无法提问', 'error');
      return;
    }
    execute('textQuestion', { text });
  };

  const authorizationText = (() => {
    if (!runtimeDevice) return '—';
    const label = runtimeDevice.authorizationTypeLabel || runtimeDevice.authorizationType || '未知';
    return runtimeDevice.expiresAt ? `${label} · 到期 ${runtimeDevice.expiresAt}` : label;
  })();

  const copyDeviceCode = async () => {
    try {
      await navigator.clipboard.writeText(config.deviceCode);
      notify('设备号已复制');
    } catch {
      notify('复制失败，请手动选择设备号', 'error');
    }
  };

  const deviceStatus = screenOnline === true ? '在线' : screenOnline === false ? '离线' : '未知';
  const flowName = snapshot ? (snapshot.command?.name ?? '无任务流程') : '等待设备状态';
  const battery = snapshot?.deviceInfo.robotBatteryPercent;
  const taskModeTotal = taskModes ? taskModes.guide.length + taskModes.explain.length + taskModes.unassigned.length : 0;

  const navDisabledReason = !canControl
    ? '设备不可控制'
    : !robotConnected
      ? '机器人未连接，暂不可导航'
      : '';

  return (
    <AntApp>
      {contextHolder}
      <Modal
        title={<Space><HistoryOutlined />历史设备号</Space>}
        open={historyOpen}
        onCancel={() => setHistoryOpen(false)}
        width={520}
        footer={
          <Space>
            {deviceHistory.length > 0 && (
              <Popconfirm
                title="清空全部历史设备号？"
                okText="清空"
                cancelText="取消"
                onConfirm={() => {
                  controller.clearDeviceHistory();
                  notify('历史记录已清空');
                }}
              >
                <Button danger>清空历史</Button>
              </Popconfirm>
            )}
            <Button onClick={() => setHistoryOpen(false)}>关闭</Button>
          </Space>
        }
      >
        {deviceHistory.length === 0 ? (
          <Empty description="暂无历史设备号，连接成功后会自动记录" />
        ) : (
          <List
            className="device-history-list"
            dataSource={deviceHistory}
            renderItem={(entry) => {
              const isCurrent = entry.code === currentCode;
              return (
                <List.Item
                  className={`device-history-row${isCurrent ? ' device-history-row--active' : ''}`}
                  onClick={() => selectHistoryDevice(entry.code)}
                  actions={[
                    <Button
                      key="use"
                      type={isCurrent ? 'default' : 'primary'}
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        selectHistoryDevice(entry.code);
                      }}
                    >
                      {isCurrent ? '当前' : '使用'}
                    </Button>,
                    <Popconfirm
                      key="del"
                      title="删除这条记录？"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        controller.removeDeviceHistory(entry.code);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label="删除该历史记录"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={<Avatar icon={<RobotOutlined />} />}
                    title={
                      <Space size={6}>
                        <Text strong>{entry.name || '未命名设备'}</Text>
                        {isCurrent && <Tag color="blue">当前</Tag>}
                      </Space>
                    }
                    description={
                      <Space orientation="vertical" size={0}>
                        <Text type="secondary" copyable={{ text: entry.code, tooltips: ['复制设备号', '已复制'] }} className="device-history-item__code">
                          {maskDeviceCode(entry.code)}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          最近连接：{entry.lastUsedAt ? formatTime(entry.lastUsedAt) : '—'}
                        </Text>
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Modal>
      <Layout className="console-shell">
        {/* 左侧连接配置面板 */}
        <Sider width={300} theme="light" className="console-sidebar">
          <div className="console-sidebar__inner">
            <Space orientation="vertical" size="large" style={{ width: '100%' }}>
              {/* 品牌区域 */}
              <div>
                <Space align="center" size={12}>
                  <div className="brand-mark" aria-hidden="true"><RobotOutlined /></div>
                  <div>
                    <Title level={5} style={{ margin: 0 }}>数字人控制台</Title>
                    <Text className="brand-caption">DIGITAL HUMAN / OPS</Text>
                  </div>
                </Space>
              </div>

              {/* 连接配置 */}
              <div>
                <div style={{ marginBottom: 16 }}>
                  <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space>
                      <ApiOutlined />
                      <Text strong>连接配置</Text>
                    </Space>
                    <Tag color={CONNECTION_COLORS[status]} style={{ margin: 0 }}>
                      {CONNECTION_LABELS[status]}
                    </Tag>
                  </Space>
                </div>

                <Form layout="vertical" size="small">
                  <Form.Item label="服务器地址">
                    <Input
                      prefix={<LinkOutlined />}
                      value={config.server}
                      onChange={(e) => updateConfig('server', e.target.value)}
                      placeholder="http://192.168.3.248"
                      autoComplete="off"
                    />
                  </Form.Item>

                  <Form.Item label="端口">
                    <Input
                      prefix={<ApiOutlined />}
                      value={config.port}
                      onChange={(e) => updateConfig('port', e.target.value)}
                      placeholder="8880"
                      inputMode="numeric"
                      autoComplete="off"
                    />
                  </Form.Item>

                  <Form.Item
                    label="设备号"
                    extra={
                      inputDeviceName ? (
                        <Text type="secondary" style={{ fontSize: 12 }}>设备名称：{inputDeviceName}</Text>
                      ) : undefined
                    }
                  >
                    <Input
                      prefix={<RobotOutlined />}
                      type={showDeviceCode ? 'text' : 'password'}
                      value={config.deviceCode}
                      onChange={(e) => updateConfig('deviceCode', e.target.value)}
                      placeholder="输入设备码"
                      aria-label="设备号"
                      autoComplete="off"
                      suffix={
                        <Space size={2}>
                          <Tooltip title="历史设备号">
                            <Button
                              type="text"
                              size="small"
                              icon={<HistoryOutlined />}
                              aria-label="历史设备号"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setHistoryOpen(true);
                              }}
                            />
                          </Tooltip>
                          <Button
                            type="text"
                            size="small"
                            icon={showDeviceCode ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                            aria-label={showDeviceCode ? '隐藏设备号' : '显示设备号'}
                            onClick={() => setShowDeviceCode((v) => !v)}
                          />
                          <Button
                            type="text"
                            size="small"
                            icon={<CopyOutlined />}
                            aria-label="复制设备号"
                            onClick={copyDeviceCode}
                          />
                        </Space>
                      }
                    />
                  </Form.Item>
                </Form>

                {/* WebSocket 端点预览 */}
                <div className="endpoint-preview">
                  <Text type="secondary">WebSocket 端点</Text>
                  <Paragraph ellipsis={{ tooltip: socketPreview }}>
                    <Text code>{socketPreview}</Text>
                  </Paragraph>
                </div>

                {configDirty && isActive && (
                  <div style={{ marginBottom: 12 }}>
                    <Text type="warning" style={{ fontSize: 12 }}>
                      <WarningOutlined /> 配置已修改，重连后生效。
                    </Text>
                  </div>
                )}

                <Space orientation="vertical" style={{ width: '100%' }}>
                  {(!isActive || configDirty) && (
                    <Button
                      type="primary"
                      block
                      icon={<LinkOutlined />}
                      loading={status === 'connecting'}
                      onClick={() => controller.connect()}
                    >
                      {configDirty && isActive ? '保存并重连' : '连接设备'}
                    </Button>
                  )}
                  {isActive && (
                    <Button
                      block
                      icon={<DisconnectOutlined />}
                      onClick={controller.disconnect}
                    >
                      {status === 'connected' && !configDirty ? '断开连接' : '取消连接'}
                    </Button>
                  )}
                </Space>
              </div>

              {/* 状态摘要 */}
              <div className="connection-summary">
                <Descriptions
                  column={1}
                  size="small"
                  colon={false}
                  styles={{ label: { color: 'rgba(0,0,0,0.45)' } }}
                  items={[
                    {
                      key: 'channel',
                      label: '服务通道',
                      children: <Tag color={CONNECTION_COLORS[status]}>{CONNECTION_LABELS[status]}</Tag>,
                    },
                    {
                      key: 'deviceName',
                      label: '设备名称',
                      children: <Text strong>{deviceName || '—'}</Text>,
                    },
                    {
                      key: 'device',
                      label: '设备状态',
                      children: <Text strong>{deviceStatus}</Text>,
                    },
                    {
                      key: 'snapshot',
                      label: '最近快照',
                      children: <Text strong>{formatTime(lastReceivedAt)}</Text>,
                    },
                  ]}
                />
              </div>

              <div className="sidebar-note">
                <WarningOutlined aria-hidden="true" />
                <Text type="secondary">
                  控制动作不做本地成功预判，以设备最新完整快照为准。
                </Text>
              </div>
            </Space>
          </div>
        </Sider>

        {/* 主内容区 */}
        <div className="console-workspace">
          <Header className="console-header">
            <div className="console-header__title">
              <Text className="eyebrow">OPERATIONS CONSOLE</Text>
              <Title level={3}>任务与设备控制</Title>
              <Text type="secondary">在一个工作台中掌握任务进度与设备状态</Text>
            </div>
            <div className="console-header__actions">
              <span className="protocol-label"><CodeOutlined /> 协议 v1.23</span>
              <span className={`connection-pill connection-pill--${status}`}>
                {status === 'connecting' || status === 'reconnecting' ? <LoadingOutlined /> : <span className="status-dot" />}
                {CONNECTION_LABELS[status]}
              </span>
              <Badge count={unreadLogs} overflowCount={49} size="small" offset={[-4, 4]}>
                <Button icon={<CodeOutlined />} onClick={openLogDrawer}>
                  实时报文
                </Button>
              </Badge>
              <Button
                icon={isQuerying ? <LoadingOutlined /> : <ReloadOutlined />}
                onClick={controller.requestState}
                disabled={status !== 'connected' || isQuerying}
              >
                {isQuerying ? '获取中' : '刷新状态'}
              </Button>
            </div>
          </Header>

          <Content className="console-content">
            {/* 错误提示 */}
            {error && (
              <Alert
                title={error}
                type="error"
                showIcon
                closable
                onClose={controller.clearError}
                style={{ marginBottom: 16 }}
              />
            )}

            {/* 设备信息横幅 */}
            <Card className="device-overview">
              <Row gutter={[24, 20]} align="middle">
                <Col flex="auto">
                  <Space size={16} align="center">
                    <div className="device-overview__icon" aria-hidden="true"><RobotOutlined /></div>
                    <div>
                      <Badge
                        status={screenOnline === true ? 'success' : screenOnline === false ? 'error' : 'default'}
                        text={<Text type="secondary">设备 {deviceStatus}</Text>}
                      />
                      <Title level={4}>
                        {deviceName || '尚未获取设备信息'}
                      </Title>
                      <Text type="secondary">
                        {snapshot ? '设备完整状态已同步' : '连接服务器后，将在此展示数字人与机器人状态'}
                      </Text>
                    </div>
                  </Space>
                </Col>
                <Col flex="none" className="device-metrics">
                  <Row gutter={[28, 16]}>
                    <Col>
                      <Statistic
                        title="机器人"
                        value={snapshot ? (snapshot.deviceInfo.robotConnected ? '已连接' : '未连接') : '—'}
                      />
                      <Text type={snapshot && !snapshot.deviceInfo.robotNormal ? 'danger' : 'secondary'}>
                        {snapshot ? (snapshot.deviceInfo.robotNormal ? '运行正常' : snapshot.deviceInfo.robotErrorMessage || '状态异常') : '等待状态'}
                      </Text>
                    </Col>
                    <Col>
                      <Statistic
                        title="电池电量"
                        value={battery ?? '—'}
                        suffix={battery != null ? '%' : ''}
                      />
                      <Text type="secondary">
                        {snapshot?.deviceInfo.robotCharging ? <><BatteryChargingIcon /> 正在充电</> : snapshot ? '未在充电' : '等待状态'}
                      </Text>
                    </Col>
                    <Col>
                      <Statistic title="机器人 IP" value={snapshot?.deviceInfo.robotIp || '—'} />
                      <Text type="secondary">
                        {snapshot?.deviceInfo.robotConnected ? '网络已关联' : '等待连接'}
                      </Text>
                    </Col>
                  </Row>
                </Col>
              </Row>
            </Card>

            {/* 主内容网格 */}
            <Row gutter={[16, 16]}>
              {/* ============ 左列：任务进度 + 任务流程 + 直达导航 ============ */}
              <Col xs={24} xl={16}>
                <div className="panel-stack">
                  {/* 任务进度：当前任务（上）+ 导航路线（下），合并为一张整宽卡片 */}
                  <Card
                    className="progress-card"
                    title={
                      <Space size={8}>
                        <NodeIndexOutlined />
                        {snapshot?.command ? (
                          <Tooltip title="点击查看完整任务流程">
                            <span className="progress-card__flow" onClick={() => setFlowModalOpen(true)}>
                              {flowName}
                            </span>
                          </Tooltip>
                        ) : (
                          <span>任务进度</span>
                        )}
                        {snapshot?.command && (
                          <Tag style={{ margin: 0 }}>{snapshot.command.tasks.length} 步</Tag>
                        )}
                      </Space>
                    }
                    extra={snapshot && <Tag color={statusTagColor(snapshot.taskState.status)} style={{ margin: 0 }}>{statusLabel(snapshot.taskState.status)}</Tag>}
                  >
                    {snapshot && task ? (
                      <div className="progress-body">
                        {/* 主任务 */}
                        <div className="task-main">
                          <div className="task-main__index">
                            <span className="task-main__label">主任务</span>
                            <span className="task-main__value">
                              {String(snapshot.taskState.taskIndex + 1).padStart(2, '0')}
                              <small> / {String(snapshot.command?.tasks.length ?? 0).padStart(2, '0')}</small>
                            </span>
                          </div>
                          <div className="task-main__body">
                            <Tag color="blue" style={{ margin: 0 }}>{taskTypeLabel(task)}</Tag>
                            <Paragraph
                              key={`main-${snapshot.taskState.taskIndex}`}
                              className="task-text task-text--main"
                              ellipsis={{ rows: 2, expandable: 'collapsible', symbol: (expanded: boolean) => (expanded ? '收起' : '展开') }}
                            >
                              {taskDisplayName(task)}
                            </Paragraph>
                          </div>
                        </div>

                        {/* 子任务 */}
                        {innerTask && (
                          <div className="inner-task">
                            <div className="inner-task__head">
                              <Space size={6}>
                                <ThunderboltOutlined style={{ color: '#52c41a' }} />
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  子任务 {snapshot.taskState.innerTaskIndex + 1}
                                  {task.inner_tasks?.length ? ` / ${task.inner_tasks.length}` : ''} · {taskTypeLabel(innerTask)}
                                </Text>
                              </Space>
                              <Tag color={statusTagColor(snapshot.taskState.innerTaskStatus ?? '')} style={{ margin: 0 }}>
                                {statusLabel(snapshot.taskState.innerTaskStatus)}
                              </Tag>
                            </div>
                            <Paragraph
                              key={`inner-${snapshot.taskState.taskIndex}-${snapshot.taskState.innerTaskIndex}`}
                              className="task-text"
                              ellipsis={{ rows: 3, expandable: 'collapsible', symbol: (expanded: boolean) => (expanded ? '收起' : '展开全文') }}
                            >
                              {taskDisplayName(innerTask)}
                            </Paragraph>
                          </div>
                        )}
                      </div>
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={snapshot ? '设备空闲，可发起任务流程、对话或直达导航。' : '连接成功后会自动获取当前任务。'}
                      />
                    )}

                    {/* 导航路线：只显示当前点位附近的窗口，完整列表在抽屉中查看 */}
                    {routePoints.length > 0 && (
                      <div className="route-section">
                        <div className="route-section__head">
                          <Space size={8} align="center">
                            <EnvironmentOutlined style={{ color: '#66758c' }} />
                            <Text strong style={{ fontSize: 13 }}>导航路线</Text>
                            <span className="route-progress">
                              <span className="route-progress__bar">
                                <span style={{ width: `${routeStats.percent}%` }} />
                              </span>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {routeStats.done} / {routePoints.length}
                              </Text>
                            </span>
                            <Tooltip title="点击可跳转的点位即可跳到该导航步骤；流程暂停时需先继续任务">
                              <QuestionCircleOutlined className="route-section__help" />
                            </Tooltip>
                          </Space>
                          {routePoints.length > ROUTE_WINDOW && (
                            <Button size="small" type="link" onClick={() => setPointsModalOpen(true)}>
                              查看全部
                            </Button>
                          )}
                        </div>
                        <div className="route-rail">
                          {routeWindow.start > 0 && (
                            <button type="button" className="route-more" onClick={() => setPointsModalOpen(true)}>
                              前 {routeWindow.start} 个
                            </button>
                          )}
                          <Steps
                            className="route-rail__steps"
                            direction="horizontal"
                            size="small"
                            initial={routeWindow.start}
                            current={Math.max(routePoints.findIndex((p) => p.progress === 'active'), routeWindow.start)}
                            items={routeWindow.items.map((rp) => {
                              return {
                                title: (
                                  <Tooltip title={rp.canNavigate ? `跳转到 ${rp.name}` : rp.name}>
                                    <span
                                      className={`route-step__name${rp.canNavigate ? ' route-step__name--link' : ''}`}
                                      onClick={() => rp.canNavigate && requestJump(rp)}
                                    >
                                      {rp.name}
                                    </span>
                                  </Tooltip>
                                ),
                                status: rp.progress === 'completed' ? 'finish' : rp.progress === 'active' ? 'process' : 'wait',
                              };
                            })}
                          />
                          {routeWindow.end < routePoints.length && (
                            <button type="button" className="route-more" onClick={() => setPointsModalOpen(true)}>
                              后 {routePoints.length - routeWindow.end} 个
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {snapshot?.command && routePoints.length === 0 && (
                      <div className="route-section route-section--empty">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          <EnvironmentOutlined /> 当前流程没有可展示的导航路线
                        </Text>
                      </div>
                    )}
                  </Card>

                  {/* 任务流程 */}
                  <Card
                    title={<Space><NodeIndexOutlined /> 任务流程</Space>}
                    extra={
                      <Space size={4}>
                        {taskModes && <Text type="secondary" style={{ fontSize: 11 }}>{taskModeTotal} 个</Text>}
                        <Button
                          size="small"
                          type="text"
                          icon={taskModesLoading ? <LoadingOutlined /> : <ReloadOutlined />}
                          aria-label="刷新任务流程"
                          onClick={controller.fetchTaskModes}
                          disabled={status !== 'connected'}
                        />
                      </Space>
                    }
                  >
                    {taskModes && taskModeTotal > 0 ? (
                      <div className="mode-groups">
                        {MODE_GROUPS.filter((g) => taskModes[g.key].length > 0).map((group) => (
                          <div key={group.key} className="mode-group">
                            <div className="mode-group__label">
                              <Tag color={group.color} style={{ margin: 0 }}>{group.label}</Tag>
                              <Text type="secondary" style={{ fontSize: 11 }}>{taskModes[group.key].length}</Text>
                            </div>
                            <div className="mode-grid">
                              {taskModes[group.key].map((name) => {
                                const isRunning = snapshot?.command?.name === name;
                                return (
                                  <Tooltip key={name} title={name} mouseEnterDelay={0.6}>
                                    <Button
                                      className="mode-btn"
                                      disabled={!canControl}
                                      type={isRunning ? 'primary' : 'default'}
                                      icon={group.icon}
                                      onClick={() => requestTaskMode(name)}
                                    >
                                      <span className="ellipsis">{name}</span>
                                      {isRunning && <Tag color="blue" style={{ marginLeft: 'auto', fontSize: 10 }}>运行中</Tag>}
                                    </Button>
                                  </Tooltip>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={taskModes ? '设备没有可用的任务流程' : taskModesLoading ? '正在获取任务流程…' : '连接设备后将自动获取任务流程列表'}
                      />
                    )}
                  </Card>

                  {/* 直达导航：点位磁贴 */}
                  <Card
                    title={
                      <Space>
                        <EnvironmentOutlined /> 直达导航
                        {pointGroup && <Tag style={{ margin: 0 }}>{pointGroup.name}</Tag>}
                      </Space>
                    }
                    extra={
                      <Space size={8}>
                        {hiddenPointCount > 0 && (
                          <Segmented
                            size="small"
                            value={showHiddenPoints ? 'all' : 'visible'}
                            onChange={(v) => setShowHiddenPoints(v === 'all')}
                            options={[
                              { label: `全部 ${pointGroup?.points.length ?? 0}`, value: 'all' },
                              { label: `可见 ${(pointGroup?.points.length ?? 0) - hiddenPointCount}`, value: 'visible' },
                            ]}
                          />
                        )}
                        {!hiddenPointCount && pointGroup && (
                          <Text type="secondary" style={{ fontSize: 11 }}>{pointGroup.points.length} 个点位</Text>
                        )}
                        <Button
                          size="small"
                          type="text"
                          icon={pointGroupLoading ? <LoadingOutlined /> : <ReloadOutlined />}
                          aria-label="刷新点位"
                          onClick={controller.fetchPoints}
                          disabled={status !== 'connected'}
                        />
                      </Space>
                    }
                  >
                    {snapshot && navDisabledReason && (
                      <div className="inline-hint">
                        <WarningOutlined /> {navDisabledReason}
                      </div>
                    )}

                    {visiblePoints.length > 0 ? (
                      <div className="point-grid">
                        {visiblePoints.map((pt: PointItem) => {
                          const disabled = !canNavigate || !pt.isActive;
                          return (
                            <button
                              type="button"
                              key={pt.id || `${pt.command}-${pt.name}`}
                              className={[
                                'point-tile',
                                pt.isChargingPile ? 'point-tile--charging' : '',
                                !pt.isUiVisible ? 'point-tile--hidden' : '',
                              ].join(' ')}
                              disabled={disabled}
                              title={disabled ? (pt.isActive ? navDisabledReason : '点位未启用') : `导航到 ${pt.name}`}
                              onClick={() => navigateDirect(pt.command, pt.name)}
                            >
                              <span className="point-tile__icon">
                                {pt.isChargingPile ? <BatteryChargingIcon /> : <EnvironmentOutlined />}
                              </span>
                              <span className="point-tile__body">
                                <span className="point-tile__name">{pt.name}</span>
                                <span className="point-tile__code">{pt.command}</span>
                              </span>
                              {(!pt.isActive || !pt.isUiVisible) && (
                                <span className="point-tile__flag">{!pt.isActive ? '未启用' : '隐藏'}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                          pointGroup
                            ? '点位分组中没有点位'
                            : pointGroupLoading || status === 'connected'
                              ? '正在获取点位分组…'
                              : '连接设备后将自动获取点位分组'
                        }
                      />
                    )}

                    {/* 手动输入：一行 */}
                    <form className="manual-point" onSubmit={submitDirectNavigation}>
                      <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>手动点位</Text>
                      <Space.Compact style={{ flex: 1, minWidth: 0 }}>
                        <Input
                          style={{ width: '40%' }}
                          value={point}
                          onChange={(e) => setPoint(e.target.value)}
                          placeholder="点位值，如 cdz"
                          autoComplete="off"
                        />
                        <Input
                          style={{ width: '60%' }}
                          value={pointName}
                          onChange={(e) => setPointName(e.target.value)}
                          placeholder="点位名称，如 会议室"
                        />
                      </Space.Compact>
                      <Button
                        icon={<EnvironmentOutlined />}
                        htmlType="submit"
                        disabled={!canNavigate || !point.trim() || !pointName.trim()}
                      >
                        导航
                      </Button>
                    </form>
                  </Card>
                </div>
              </Col>

              {/* ============ 右列：控制动作 + 文本提问 + 音色 ============ */}
              <Col xs={24} xl={8}>
                <div className="panel-stack">
                  {/* 控制动作 */}
                  <Card
                    title={<Space><ThunderboltOutlined /> 控制动作</Space>}
                    extra={
                      <Tag color={canControl ? 'success' : 'default'}>
                        {canControl ? '可控制' : '已锁定'}
                      </Tag>
                    }
                  >
                    {CONTROL_GROUPS.map((group, gi) => (
                      <div key={group.title} className={gi > 0 ? 'control-group control-group--split' : 'control-group'}>
                        <div className="control-group__title">
                          <Text strong style={{ fontSize: 13 }}>{group.title}</Text>
                          <Text type="secondary" style={{ fontSize: 11 }}>{group.description}</Text>
                        </div>
                        <div className="control-grid">
                          {group.items.map((item) => {
                            const enabled = Boolean(canControl && snapshot?.buttons[item.key]);
                            return (
                              <Button
                                key={item.key}
                                block
                                icon={item.icon}
                                disabled={!enabled}
                                danger={item.danger}
                                onClick={() => handleControlClick(item)}
                                className="control-btn"
                              >
                                {item.label}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </Card>

                  {/* 文本提问 */}
                  <Card size="small" title={<Space><MessageOutlined /> 文本提问</Space>}>
                    <form onSubmit={submitQuestion}>
                      <Input.TextArea
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            if (canControl && question.trim()) execute('textQuestion', { text: question });
                          }
                        }}
                        placeholder="例如：请介绍一下序厅的主要内容。"
                        maxLength={500}
                        autoSize={{ minRows: 2, maxRows: 5 }}
                      />
                      <div className="question-footer">
                        <Text type="secondary" style={{ fontSize: 11 }}>Ctrl + Enter 发送 · {question.length}/500</Text>
                        <Button type="primary" size="small" htmlType="submit" icon={<SendOutlined />} disabled={!canControl || !question.trim()}>
                          发送
                        </Button>
                      </div>
                    </form>

                    {/* 建议问题：来自运行时配置 agentApplication.suggestedQuestions，点击直接发送 */}
                    {suggestedQuestions.length > 0 && (
                      <div className="suggested-questions">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          <BulbOutlined /> 建议问题（点击直接提问）
                        </Text>
                        <div className="suggested-questions__list">
                          {suggestedQuestions.map((q) => (
                            <Tooltip key={q} title={canControl ? `发送：${q}` : '设备不可控制'}>
                              <Tag
                                className={`suggested-question${canControl ? '' : ' suggested-question--disabled'}`}
                                color={canControl ? 'blue' : 'default'}
                                onClick={() => askSuggested(q)}
                              >
                                {q}
                              </Tag>
                            </Tooltip>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>

                  {/* 设备信息：来自运行时配置 device / agentApplication / wakeWords */}
                  <Card size="small" title={<Space><InfoCircleOutlined /> 设备信息</Space>}>
                    {runtimeDevice ? (
                      <Descriptions
                        column={1}
                        size="small"
                        colon={false}
                        styles={{ label: { color: 'rgba(0,0,0,0.45)', width: 76 } }}
                        items={[
                          {
                            key: 'auth',
                            label: '授权',
                            children: (
                              <Space size={4} wrap>
                                <SafetyCertificateOutlined />
                                <Text>{authorizationText}</Text>
                                {runtimeDevice.authorizationExpired && <Tag color="red">已过期</Tag>}
                                {runtimeDevice.isSoftwareTrial && <Tag color="orange">试用</Tag>}
                                {runtimeDevice.isEnabled === false && <Tag color="red">已停用</Tag>}
                              </Space>
                            ),
                          },
                          ...(runtimeDevice.tenantName
                            ? [{ key: 'tenant', label: '所属单位', children: <Text>{runtimeDevice.tenantName}</Text> }]
                            : []),
                          ...(runtimeDevice.location || runtimeDevice.groupName
                            ? [{
                                key: 'location',
                                label: '位置/分组',
                                children: <Text>{[runtimeDevice.location, runtimeDevice.groupName].filter(Boolean).join(' / ')}</Text>,
                              }]
                            : []),
                          {
                            key: 'agent',
                            label: '智能体',
                            children: (
                              <Text>
                                {runtimeDevice.agentName || '—'}
                                {runtimeDevice.llmModelName && <Text type="secondary">（{runtimeDevice.llmModelName}）</Text>}
                              </Text>
                            ),
                          },
                          {
                            key: 'wake',
                            label: '唤醒词',
                            children: runtimeDevice.wakeWords.length > 0 ? (
                              <Space size={[4, 4]} wrap>
                                {runtimeDevice.wakeWords.map((w) => <Tag key={w} style={{ margin: 0 }}>{w}</Tag>)}
                              </Space>
                            ) : (
                              <Text type="secondary">未配置</Text>
                            ),
                          },
                          {
                            key: 'version',
                            label: '软件版本',
                            children: (
                              <Paragraph style={{ margin: 0 }} ellipsis={{ tooltip: runtimeDevice.systemVersion || undefined }}>
                                {runtimeDevice.softwareVersion || '—'}
                              </Paragraph>
                            ),
                          },
                          { key: 'heartbeat', label: '最近心跳', children: <Text>{runtimeDevice.lastHeartbeat || '—'}</Text> },
                          { key: 'authAt', label: '最近激活', children: <Text>{runtimeDevice.lastAuthAt || '—'}</Text> },
                        ]}
                      />
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={status === 'connected' ? '正在读取设备运行时配置…' : '连接设备后显示授权、版本、唤醒词等信息'}
                      />
                    )}
                  </Card>

                  {/* 音色选择 */}
                  <Card
                    size="small"
                    className="voice-card"
                    title={<Space><AudioOutlined /> 音色选择</Space>}
                    extra={
                      <Space size={4}>
                        {voiceTones.length > 0 && <Text type="secondary" style={{ fontSize: 11 }}>{voiceTones.length} 个</Text>}
                        <Button
                          size="small"
                          type="text"
                          icon={voiceLoading ? <LoadingOutlined /> : <ReloadOutlined />}
                          aria-label="刷新音色"
                          onClick={controller.fetchVoices}
                          disabled={status !== 'connected'}
                        />
                      </Space>
                    }
                  >
                    {voiceTones.length > 0 ? (
                      <div>
                        {/* 当前音色 */}
                        {currentVoice && (
                          <div className="voice-current">
                            <Avatar size={34} icon={<AudioOutlined />} style={{ background: '#52c41a', flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Text type="secondary" style={{ fontSize: 11 }}>当前音色</Text>
                              <div className="ellipsis"><Text strong>{currentVoice.displayName}</Text></div>
                            </div>
                            <Button
                              size="small"
                              icon={voicePreviewing && previewingId === currentVoice.id ? <LoadingOutlined /> : <SoundOutlined />}
                              disabled={voicePreviewing || status !== 'connected'}
                              onClick={() => handlePreview(currentVoice)}
                            >
                              试听
                            </Button>
                          </div>
                        )}

                        {voicePreviewing && previewText && (
                          <div className="voice-playing">
                            <SoundOutlined /> <span className="ellipsis">正在播放：{previewText}</span>
                          </div>
                        )}

                        {/* 筛选 */}
                        <div className="voice-filter">
                          <Input
                            size="small"
                            allowClear
                            prefix={<SearchOutlined />}
                            placeholder="搜索音色名称 / 编码"
                            value={voiceKeyword}
                            onChange={(e) => setVoiceKeyword(e.target.value)}
                          />
                          {voiceGenders.length > 1 && (
                            <Segmented
                              size="small"
                              value={voiceGender}
                              onChange={(v) => setVoiceGender(String(v))}
                              options={[{ label: '全部', value: 'all' }, ...voiceGenders.map((g) => ({ label: g, value: g }))]}
                            />
                          )}
                        </div>

                        {/* 音色网格（限高滚动） */}
                        {filteredVoices.length > 0 ? (
                          <div className="voice-grid">
                            {filteredVoices.map((vt) => {
                              const isCurrent = currentVoice?.id === vt.id;
                              const isPreviewingThis = voicePreviewing && previewingId === vt.id;
                              return (
                                <div key={vt.id} className={`voice-tile${isCurrent ? ' voice-tile--current' : ''}`}>
                                  <div className="voice-tile__main">
                                    <div className="voice-tile__name ellipsis" title={vt.displayName}>{vt.displayName}</div>
                                    <div className="voice-tile__meta ellipsis" title={vt.customTestText || vt.voiceCode}>
                                      {[vt.gender ? genderLabel(vt.gender) : '', vt.voiceCode].filter(Boolean).join(' · ')}
                                    </div>
                                    <div className="voice-tile__tags">
                                      {isCurrent && <Tag color="green">当前</Tag>}
                                      {vt.isDefault && <Tag color="orange">默认</Tag>}
                                    </div>
                                  </div>
                                  <div className="voice-tile__actions">
                                    <Tooltip title="试听">
                                      <Button
                                        size="small"
                                        type="text"
                                        aria-label={`试听 ${vt.displayName}`}
                                        icon={isPreviewingThis ? <LoadingOutlined /> : <SoundOutlined />}
                                        disabled={voicePreviewing || status !== 'connected'}
                                        onClick={() => handlePreview(vt)}
                                      />
                                    </Tooltip>
                                    {!isCurrent && (
                                      <Button
                                        size="small"
                                        type="primary"
                                        ghost
                                        loading={voiceBinding && bindingId === vt.id}
                                        disabled={!canControl || voiceBinding}
                                        onClick={() => handleBind(vt)}
                                      >
                                        绑定
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的音色" />
                        )}
                      </div>
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={voiceLoading ? '正在获取音色列表…' : status === 'connected' ? '没有可选音色' : '连接设备后将自动获取音色列表'}
                      />
                    )}
                  </Card>
                </div>
              </Col>
            </Row>

            {/* 底部信息 */}
            <div className="console-footer">
              <Text type="secondary" style={{ fontSize: 11 }}>
                <ApiOutlined /> {activeUrl || socketPreview}
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>WebSocket / JSON · 完整快照驱动</Text>
            </div>
          </Content>
        </div>
      </Layout>

      {/* 实时报文抽屉 */}
      <Drawer
        title={<Space><CodeOutlined /> 实时报文 <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>最近 {logs.length} 条</Text></Space>}
        open={logDrawerOpen}
        onClose={closeLogDrawer}
        size={600}
        extra={
          <Space>
            <Segmented
              size="small"
              value={logFilter}
              onChange={(v) => setLogFilter(v as 'all' | LogDirection)}
              options={[
                { label: '全部', value: 'all' },
                { label: '接收', value: 'incoming' },
                { label: '发送', value: 'outgoing' },
                { label: '系统', value: 'system' },
              ]}
            />
            <Popconfirm title="清空所有报文？" onConfirm={controller.clearLogs} disabled={!logs.length}>
              <Button size="small" danger icon={<CloseOutlined />} aria-label="清空所有报文" disabled={!logs.length} />
            </Popconfirm>
          </Space>
        }
      >
        {filteredLogs.length ? (
          <Timeline
            style={{ paddingLeft: 8, paddingTop: 8 }}
            items={filteredLogs.map((entry) => {
              const expanded = expandedLog === entry.id;
              return {
                key: entry.id,
                dot: <Tag color={LOG_DIR_COLORS[entry.direction]} style={{ margin: 0 }}>{LOG_DIR_LABELS[entry.direction]}</Tag>,
                children: (
                  <div style={{ cursor: 'pointer' }} onClick={() => setExpandedLog(expanded ? null : entry.id)}>
                    <div className="log-head">
                      <Text code className="ellipsis" style={{ fontSize: 11, maxWidth: 320 }}>{entry.type}</Text>
                      <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace', marginLeft: 'auto' }}>
                        {formatTime(entry.timestamp)}
                      </Text>
                    </div>
                    {expanded ? (
                      <pre className="log-raw">{prettyRaw(entry.raw)}</pre>
                    ) : (
                      <Paragraph
                        ellipsis={{ rows: 1 }}
                        style={{ margin: '4px 0 0', fontSize: 11, fontFamily: 'monospace', color: 'rgba(0,0,0,0.45)' }}
                      >
                        {entry.raw}
                      </Paragraph>
                    )}
                  </div>
                ),
              };
            })}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={logs.length ? '当前筛选下没有报文' : '连接后可在这里核对发送与接收的原始消息'}
          />
        )}
      </Drawer>

      {/* 导航路线抽屉 */}
      <Drawer
        title={
          <Space size={8}>
            <EnvironmentOutlined />
            <span>导航路线</span>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              已完成 {routeStats.done} / {routePoints.length}
            </Text>
          </Space>
        }
        open={pointsModalOpen}
        onClose={() => setPointsModalOpen(false)}
        size={460}
        afterOpenChange={(open) => {
          if (open) document.querySelector('.route-row--active')?.scrollIntoView({ block: 'center' });
        }}
      >
        <div className="route-drawer">
          <div className="route-drawer__tools">
            <Input
              allowClear
              size="small"
              prefix={<SearchOutlined />}
              placeholder="搜索点位名称 / 点位值"
              value={routeKeyword}
              onChange={(e) => setRouteKeyword(e.target.value)}
            />
            <Segmented
              size="small"
              block
              value={routeFilter}
              onChange={(v) => setRouteFilter(v as typeof routeFilter)}
              options={[
                { label: `全部 ${routePoints.length}`, value: 'all' },
                { label: `待执行 ${routeStats.pending}`, value: 'pending' },
                { label: `已完成 ${routeStats.done}`, value: 'completed' },
              ]}
            />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {snapshot?.buttons.pauseTask ? '点击「跳转」从该步骤重新派发后续任务' : '流程未在运行（或已暂停），暂不可跳转'}
            </Text>
          </div>

          {filteredRoutePoints.length ? (
            <div className="route-list">
              {filteredRoutePoints.map((rp) => {
                const globalIdx = routePoints.indexOf(rp);
                return (
                  <div key={rp.key} className={`route-row route-row--${rp.progress}`}>
                    <span className="route-row__dot" style={{ background: routeProgressColor(rp.progress) }}>
                      {rp.progress === 'completed' ? <CheckOutlined /> : globalIdx + 1}
                    </span>
                    <div className="route-row__body">
                      <div className="route-row__name ellipsis" title={rp.name}>{rp.name}</div>
                      <div className="route-row__meta ellipsis">
                        {rp.point || '—'} · 步骤 {rp.stepId}
                      </div>
                    </div>
                    {rp.progress === 'active' ? (
                      <Tag color="blue" style={{ margin: 0 }}>当前</Tag>
                    ) : (
                      <Button
                        size="small"
                        type="text"
                        className="route-row__jump"
                        disabled={!rp.canNavigate}
                        onClick={() => { setPointsModalOpen(false); requestJump(rp); }}
                      >
                        跳转
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的点位" />
          )}
        </div>
      </Drawer>

      {/* 任务流程详情弹窗 */}
      <Modal
        title={
          <Space>
            <NodeIndexOutlined />
            {flowName}
            {snapshot?.command && (
              <Tag color="blue">{snapshot.command.tasks.length} 个主任务</Tag>
            )}
          </Space>
        }
        open={flowModalOpen}
        onCancel={() => setFlowModalOpen(false)}
        footer={null}
        width={720}
      >
        {snapshot?.command ? (
          <div>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              完整任务流程树，按原始根任务顺序排列。点击导航任务可直接跳转或发起直达导航。
            </Paragraph>
            <List
              dataSource={snapshot.command.tasks}
              renderItem={(taskNode, index) => {
                const isCurrent = index === snapshot.taskState.taskIndex;
                const isNavigation = taskNode.type === 'navigation';
                const navPoint = isNavigation
                  ? (typeof taskNode.content.command === 'string' ? taskNode.content.command.trim() : '')
                  : '';
                const navName = isNavigation
                  ? (typeof taskNode.content.pointName === 'string' ? taskNode.content.pointName.trim() : '')
                  : '';
                const canJump = Boolean(
                  isNavigation &&
                  typeof taskNode.step_id === 'number' &&
                  taskNode.step_id > 0 &&
                  navPoint &&
                  navName &&
                  canControl &&
                  snapshot.buttons.pauseTask,
                );
                const canDirect = Boolean(isNavigation && navPoint && navName && canNavigate);
                return (
                  <List.Item
                    style={{
                      background: isCurrent ? '#f0f5ff' : undefined,
                      paddingLeft: isCurrent ? 12 : undefined,
                      borderRadius: isCurrent ? 6 : undefined,
                      marginBottom: 4,
                    }}
                    actions={
                      isNavigation && (canJump || canDirect)
                        ? ([
                            canJump && (
                              <Button
                                key="jump"
                                size="small"
                                type="primary"
                                onClick={() => {
                                  if (typeof taskNode.step_id === 'number') {
                                    setFlowModalOpen(false);
                                    requestJump({
                                      key: `step:${taskNode.step_id}`,
                                      name: navName || taskDisplayName(taskNode),
                                      rootIndex: index,
                                      stepId: taskNode.step_id,
                                      point: navPoint,
                                      pointName: navName,
                                      progress: isCurrent ? 'active' : 'pending',
                                      canNavigate: canJump,
                                    });
                                  }
                                }}
                              >
                                跳转
                              </Button>
                            ),
                            canDirect && (
                              <Button
                                key="direct"
                                size="small"
                                onClick={() => {
                                  setFlowModalOpen(false);
                                  navigateDirect(navPoint, navName);
                                }}
                              >
                                直达
                              </Button>
                            ),
                          ].filter(Boolean) as ReactElement[])
                        : undefined
                    }
                  >
                    <List.Item.Meta
                      avatar={
                        <Avatar
                          size={32}
                          shape="circle"
                          style={{
                            background: isCurrent ? '#1677ff' : isNavigation ? '#f0f0f0' : '#fafafa',
                            color: isCurrent ? '#fff' : '#8c8c8c',
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {index + 1}
                        </Avatar>
                      }
                      title={
                        <Space size={6} wrap>
                          <Tag>{taskTypeLabel(taskNode)}</Tag>
                          <Text strong style={{ fontSize: 13 }}>{taskDisplayName(taskNode)}</Text>
                          {isCurrent && <Tag color="blue">当前</Tag>}
                          {taskNode.is_show === false && <Tag>隐藏</Tag>}
                          {isNavigation && navPoint && (
                            <Text type="secondary" code style={{ fontSize: 10 }}>{navPoint}</Text>
                          )}
                        </Space>
                      }
                      description={
                        taskNode.inner_tasks && taskNode.inner_tasks.length > 0 ? (
                          <Space size={4} wrap>
                            {taskNode.inner_tasks.map((inner, i) => (
                              <Tag key={i} style={{ fontSize: 10 }}>
                                {taskTypeLabel(inner)}: {taskDisplayName(inner)}
                              </Tag>
                            ))}
                          </Space>
                        ) : null
                      }
                    />
                  </List.Item>
                );
              }}
            />
          </div>
        ) : (
          <Empty description="当前没有任务流程" />
        )}
      </Modal>
    </AntApp>
  );
}

export default App;
