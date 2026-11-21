import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Divider,
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
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  AudioOutlined,
  ThunderboltOutlined as BatteryChargingIcon,
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DisconnectOutlined,
  EnvironmentOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FastForwardOutlined,
  LinkOutlined,
  LoadingOutlined,
  MessageOutlined,
  NodeIndexOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ActionName, ButtonKey, PointItem, RoutePoint } from './protocol';
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
  icon: React.ReactNode;
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

function routeProgressText(progress: string): string {
  if (progress === 'completed') return '前序位置';
  if (progress === 'active') return '当前位置';
  return '待执行';
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
  } = controller;

  const [question, setQuestion] = useState('');
  const [point, setPoint] = useState('');
  const [pointName, setPointName] = useState('');
  const [showDeviceCode, setShowDeviceCode] = useState(false);
  const [pointsModalOpen, setPointsModalOpen] = useState(false);
  const [flowModalOpen, setFlowModalOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | LogDirection>('all');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

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

  const submitQuestion = (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    execute('textQuestion', { text: question });
  };

  const submitDirectNavigation = (e: FormEvent) => {
    e.preventDefault();
    if (!point.trim() || !pointName.trim() || !canControl) return;
    navigateDirect(point.trim(), pointName.trim());
  };

  const navigateDirect = (targetPoint: string, targetPointName: string) => {
    if (!targetPoint || !targetPointName || !canControl) return;
    Modal.confirm({
      title: `导航到"${targetPointName}"？`,
      content: `将使用点位值 ${targetPoint} 发起独立导航，不改变当前任务树中的步骤索引。`,
      okText: '开始导航',
      cancelText: '取消',
      onOk: () => execute('navigateToPoint', { point: targetPoint, pointName: targetPointName }),
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

  const deviceStatus = screenOnline === true ? '在线' : screenOnline === false ? '离线' : '未知';
  const flowName = snapshot ? (snapshot.command?.name ?? '无任务流程') : '等待设备状态';
  const battery = snapshot?.deviceInfo.robotBatteryPercent;

  return (
    <AntApp>
      {contextHolder}
      <Layout style={{ minHeight: '100vh' }}>
        {/* 左侧连接配置面板 */}
        <Sider
          width={320}
          theme="light"
          style={{
            overflow: 'auto',
            height: '100vh',
            position: 'sticky',
            top: 0,
            borderRight: '1px solid #f0f0f0',
          }}
        >
          <div style={{ padding: '24px 20px' }}>
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              {/* 品牌区域 */}
              <div>
                <Space align="center" size={12}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: 'linear-gradient(135deg, #1677ff, #0958d9)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <RobotOutlined style={{ color: '#fff', fontSize: 20 }} />
                  </div>
                  <div>
                    <Title level={5} style={{ margin: 0 }}>数字人控制台</Title>
                    <Text type="secondary" style={{ fontSize: 11 }}>DIGITAL HUMAN / OPS</Text>
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

                  <Form.Item label="设备号">
                    <Input.Search
                      prefix={<RobotOutlined />}
                      type={showDeviceCode ? 'text' : 'password'}
                      value={config.deviceCode}
                      onChange={(e) => updateConfig('deviceCode', e.target.value)}
                      placeholder="输入设备码"
                      autoComplete="off"
                      enterButton={false}
                      suffix={
                        <Space size={2}>
                          <Button
                            type="text"
                            size="small"
                            icon={showDeviceCode ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                            onClick={() => setShowDeviceCode((v) => !v)}
                          />
                          <Button
                            type="text"
                            size="small"
                            icon={<CopyOutlined />}
                            onClick={copyDeviceCode}
                          />
                        </Space>
                      }
                    />
                  </Form.Item>
                </Form>

                {/* WebSocket 端点预览 */}
                <Card size="small" style={{ marginBottom: 12, background: '#fafafa' }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>WebSocket 端点</Text>
                  <Paragraph style={{ margin: '4px 0 0' }} ellipsis={{ tooltip: socketPreview }}>
                    <Text code style={{ fontSize: 11 }}>{socketPreview}</Text>
                  </Paragraph>
                </Card>

                {configDirty && isActive && (
                  <div style={{ marginBottom: 12 }}>
                    <Text type="warning" style={{ fontSize: 12 }}>
                      <WarningOutlined /> 配置已修改，重连后生效。
                    </Text>
                  </div>
                )}

                <Space direction="vertical" style={{ width: '100%' }}>
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
              <Card size="small">
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">服务通道</Text>
                    <Tag color={CONNECTION_COLORS[status]}>{CONNECTION_LABELS[status]}</Tag>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">设备状态</Text>
                    <Text strong>{deviceStatus}</Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">最近快照</Text>
                    <Text strong>{formatTime(lastReceivedAt)}</Text>
                  </div>
                </Space>
              </Card>

              <div>
                <Space align="start" size={8}>
                  <WarningOutlined style={{ color: '#8c8c8c', marginTop: 2 }} />
                  <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
                    控制动作不做本地成功预判，以设备最新完整快照为准。
                  </Text>
                </Space>
              </div>
            </Space>
          </div>
        </Sider>

        {/* 主内容区 */}
        <Layout>
          <Header style={{
            background: '#fff',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 32px',
            height: 72,
          }}>
            <div>
              <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>OPERATIONS CONSOLE</Text>
              <Title level={4} style={{ margin: '2px 0 0' }}>任务与设备控制</Title>
            </div>
            <Space size="middle">
              <Tag icon={<CodeOutlined />} color="blue">协议 v1.23</Tag>
              <Tag
                color={CONNECTION_COLORS[status]}
                icon={status === 'connecting' || status === 'reconnecting' ? <LoadingOutlined /> : status === 'connected' ? <LinkOutlined /> : <DisconnectOutlined />}
              >
                {CONNECTION_LABELS[status]}
              </Tag>
              <Button
                icon={isQuerying ? <LoadingOutlined /> : <ReloadOutlined />}
                onClick={controller.requestState}
                disabled={status !== 'connected' || isQuerying}
              >
                {isQuerying ? '获取中' : '刷新状态'}
              </Button>
            </Space>
          </Header>

          <Content style={{ padding: '24px 32px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>
            {/* 错误提示 */}
            {error && (
              <Alert
                message={error}
                type="error"
                showIcon
                closable
                onClose={controller.clearError}
                style={{ marginBottom: 16 }}
              />
            )}

            {/* 设备信息横幅 */}
            <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)', border: 'none' }}>
              <Row gutter={24} align="middle">
                <Col flex="auto">
                  <Space size="large" align="center">
                    <div style={{
                      width: 56, height: 56, borderRadius: 14,
                      background: 'rgba(255,255,255,0.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <RobotOutlined style={{ color: '#fff', fontSize: 28 }} />
                    </div>
                    <div>
                      <Space size={8}>
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: screenOnline === true ? '#52c41a' : '#8c8c8c',
                        }} />
                        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>设备 {deviceStatus}</Text>
                      </Space>
                      <Title level={4} style={{ color: '#fff', margin: '4px 0' }}>
                        {snapshot?.deviceInfo.deviceName || '尚未获取设备信息'}
                      </Title>
                      <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
                        {snapshot ? '设备完整状态已同步' : '连接服务器后，将在此展示数字人与机器人状态'}
                      </Text>
                    </div>
                  </Space>
                </Col>
                <Col flex="none">
                  <Row gutter={32}>
                    <Col>
                      <Statistic
                        title={<span style={{ color: 'rgba(255,255,255,0.6)' }}>机器人</span>}
                        value={snapshot ? (snapshot.deviceInfo.robotConnected ? '已连接' : '未连接') : '—'}
                        valueStyle={{ color: '#fff', fontSize: 18 }}
                      />
                      <Text style={{ color: snapshot && !snapshot.deviceInfo.robotNormal ? '#ffccc7' : 'rgba(255,255,255,0.5)', fontSize: 11 }}>
                        {snapshot ? (snapshot.deviceInfo.robotNormal ? '运行正常' : snapshot.deviceInfo.robotErrorMessage || '状态异常') : '等待状态'}
                      </Text>
                    </Col>
                    <Col>
                      <Statistic
                        title={<span style={{ color: 'rgba(255,255,255,0.6)' }}>电池电量</span>}
                        value={battery ?? '—'}
                        suffix={battery != null ? '%' : ''}
                        valueStyle={{ color: '#fff', fontSize: 18 }}
                      />
                      <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
                        {snapshot?.deviceInfo.robotCharging ? <><BatteryChargingIcon /> 正在充电</> : snapshot ? '未在充电' : '等待状态'}
                      </Text>
                    </Col>
                    <Col>
                      <Statistic
                        title={<span style={{ color: 'rgba(255,255,255,0.6)' }}>机器人 IP</span>}
                        value={snapshot?.deviceInfo.robotIp || '—'}
                        valueStyle={{ color: '#fff', fontSize: 14 }}
                      />
                      <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
                        {snapshot?.deviceInfo.robotConnected ? '网络已关联' : '等待连接'}
                      </Text>
                    </Col>
                  </Row>
                </Col>
              </Row>
            </Card>

            {/* 主内容网格 */}
            <Row gutter={16}>
              {/* 左列：当前任务 + 轨迹预览 */}
              <Col xs={24} lg={16}>
                {/* 当前任务 */}
                <Card title={<Space><NodeIndexOutlined /> 当前任务</Space>} extra={
                  snapshot && <Tag color={statusTagColor(snapshot.taskState.status)}>{statusLabel(snapshot.taskState.status)}</Tag>
                } style={{ marginBottom: 16 }}>
                  {snapshot && task ? (
                    <div>
                      <Row gutter={16} align="middle">
                        <Col flex="120px">
                          <div style={{ textAlign: 'center' }}>
                            <Text type="secondary" style={{ fontSize: 11 }}>主任务</Text>
                            <div style={{ fontSize: 36, fontWeight: 500, color: '#1677ff', lineHeight: 1.2 }}>
                              {String(snapshot.taskState.taskIndex + 1).padStart(2, '0')}
                              <span style={{ fontSize: 14, color: '#8c8c8c' }}> / {String(snapshot.command?.tasks.length ?? 0).padStart(2, '0')}</span>
                            </div>
                          </div>
                        </Col>
                        <Col flex="auto">
                          <Space direction="vertical" size={4}>
                            <Tag>{taskTypeLabel(task)}</Tag>
                            <Title level={5} style={{ margin: 0 }} ellipsis={{ tooltip: taskDisplayName(task) }}>
                              {taskDisplayName(task)}
                            </Title>
                            <Text type="secondary" style={{ fontSize: 12 }}>{statusLabel(snapshot.taskState.status)}</Text>
                          </Space>
                        </Col>
                      </Row>
                      {innerTask && (
                        <Card size="small" style={{ marginTop: 12, background: '#f6ffed', borderLeft: '3px solid #52c41a' }}>
                          <Space align="center" style={{ width: '100%' }}>
                            <ThunderboltOutlined style={{ color: '#52c41a' }} />
                            <div style={{ flex: 1 }}>
                              <Text type="secondary" style={{ fontSize: 11 }}>
                                子任务 {snapshot.taskState.innerTaskIndex + 1} · {taskTypeLabel(innerTask)}
                              </Text>
                              <div>
                                <Text strong style={{ fontSize: 13 }} ellipsis={{ tooltip: taskDisplayName(innerTask) }}>
                                  {taskDisplayName(innerTask)}
                                </Text>
                              </div>
                            </div>
                            <Tag color={statusTagColor(snapshot.taskState.innerTaskStatus ?? '')}>
                              {statusLabel(snapshot.taskState.innerTaskStatus)}
                            </Tag>
                          </Space>
                        </Card>
                      )}
                    </div>
                  ) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={snapshot ? '设备当前处于空闲状态，可以发起对话或独立导航。' : '连接成功后会自动发送 getState，获取当前主任务和子任务。'}
                    />
                  )}
                </Card>

                {/* 轨迹预览 */}
                <Card
                  title={
                    <Space
                      style={{ cursor: snapshot?.command ? 'pointer' : 'default', color: snapshot?.command ? '#1677ff' : undefined }}
                      onClick={() => snapshot?.command && setFlowModalOpen(true)}
                    >
                      <EnvironmentOutlined />
                      <Tooltip title={snapshot?.command ? '点击查看完整任务流程' : ''}>
                        <span>{flowName}</span>
                      </Tooltip>
                      {snapshot?.command && (
                        <Tag style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>
                          {snapshot.command.tasks.length} 步
                        </Tag>
                      )}
                    </Space>
                  }
                  extra={
                    <Space>
                      <Text type="secondary">{routePoints.length} 个导航点</Text>
                      {routePoints.length > 0 && (
                        <Button size="small" type="link" onClick={() => setPointsModalOpen(true)}>
                          全部点位
                        </Button>
                      )}
                    </Space>
                  }
                  style={{ marginBottom: 16 }}
                >
                  {routePoints.length ? (
                    <div>
                      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                        {routePoints.map((rp, idx) => (
                          <Col key={rp.key} flex="1 1 120px">
                            <Tooltip title={rp.canNavigate ? `跳转到 ${rp.name}` : rp.name}>
                              <div
                                style={{
                                  textAlign: 'center',
                                  cursor: rp.canNavigate ? 'pointer' : 'default',
                                  opacity: rp.canNavigate ? 1 : 0.6,
                                  transition: 'transform 0.15s',
                                }}
                                onClick={() => rp.canNavigate && requestJump(rp)}
                              >
                                <div
                                  style={{
                                    width: 44, height: 44, borderRadius: '50%',
                                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                    background: routeProgressColor(rp.progress),
                                    color: rp.progress === 'pending' ? '#8c8c8c' : '#fff',
                                    fontSize: 14, fontWeight: 600,
                                    border: rp.progress === 'active' ? '4px solid #d6e4ff' : '1px solid #d9d9d9',
                                    marginBottom: 8,
                                  }}
                                >
                                  {rp.progress === 'completed' ? <CheckOutlined /> : idx + 1}
                                </div>
                                <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {rp.name}
                                </div>
                                <div style={{ fontSize: 10, color: '#8c8c8c' }}>{routeProgressText(rp.progress)}</div>
                              </div>
                            </Tooltip>
                          </Col>
                        ))}
                      </Row>
                      <Divider style={{ margin: '8px 0' }} />
                      <Space size="large">
                        <Space>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#52c41a' }} />
                          <Text type="secondary" style={{ fontSize: 12 }}>前序</Text>
                        </Space>
                        <Space>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#1677ff' }} />
                          <Text type="secondary" style={{ fontSize: 12 }}>当前</Text>
                        </Space>
                        <Space>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#d9d9d9' }} />
                          <Text type="secondary" style={{ fontSize: 12 }}>待执行</Text>
                        </Space>
                        <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                          点击可用点位可跳转 · 暂停时需先继续任务
                        </Text>
                      </Space>
                    </div>
                  ) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={snapshot?.command ? '任务树中没有满足显示条件的根导航任务。' : '轨迹仅展示流程中的可见根导航任务，不代表机器人实际运动路径。'}
                    />
                  )}
                </Card>

                {/* 任务流程列表 */}
                <Card
                  title={<Space><NodeIndexOutlined /> 任务流程</Space>}
                  extra={
                    <Space size={4}>
                      {taskModes && (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {taskModes.guide.length + taskModes.explain.length + taskModes.unassigned.length} 个
                        </Text>
                      )}
                      <Button
                        size="small"
                        type="text"
                        icon={taskModesLoading ? <LoadingOutlined /> : <ReloadOutlined />}
                        onClick={controller.fetchTaskModes}
                        disabled={status !== 'connected'}
                      />
                    </Space>
                  }
                  style={{ marginBottom: 16 }}
                >
                  {taskModes ? (
                    (taskModes.guide.length > 0 || taskModes.explain.length > 0 || taskModes.unassigned.length > 0) ? (
                      <Space direction="vertical" style={{ width: '100%' }} size="middle">
                        {taskModes.explain.length > 0 && (
                          <div>
                            <div style={{ marginBottom: 6 }}>
                              <Space>
                                <Tag color="blue">讲解</Tag>
                                <Text type="secondary" style={{ fontSize: 11 }}>{taskModes.explain.length} 个</Text>
                              </Space>
                            </div>
                            <Row gutter={[8, 8]}>
                              {taskModes.explain.map((name) => {
                                const isRunning = snapshot?.command?.name === name;
                                return (
                                  <Col key={name} flex="1 1 200px">
                                    <Button
                                      block
                                      style={{ textAlign: 'left', height: 36 }}
                                      disabled={!canControl}
                                      type={isRunning ? 'primary' : 'default'}
                                      icon={<NodeIndexOutlined />}
                                      onClick={() => {
                                        if (!canControl) return;
                                        Modal.confirm({
                                          title: `发起任务流程"${name}"？`,
                                          content: '将通过文本提问方式向设备发送该任务指令，设备会根据当前状态处理。',
                                          okText: '确认',
                                          cancelText: '取消',
                                          onOk: () => execute('textQuestion', { text: name }),
                                        });
                                      }}
                                    >
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {name}
                                      </span>
                                      {isRunning && <Tag color="blue" style={{ marginLeft: 4, fontSize: 9 }}>运行中</Tag>}
                                    </Button>
                                  </Col>
                                );
                              })}
                            </Row>
                          </div>
                        )}
                        {taskModes.guide.length > 0 && (
                          <div>
                            <div style={{ marginBottom: 6 }}>
                              <Space>
                                <Tag color="green">带路</Tag>
                                <Text type="secondary" style={{ fontSize: 11 }}>{taskModes.guide.length} 个</Text>
                              </Space>
                            </div>
                            <Row gutter={[8, 8]}>
                              {taskModes.guide.map((name) => {
                                const isRunning = snapshot?.command?.name === name;
                                return (
                                  <Col key={name} flex="1 1 200px">
                                    <Button
                                      block
                                      style={{ textAlign: 'left', height: 36 }}
                                      disabled={!canControl}
                                      type={isRunning ? 'primary' : 'default'}
                                      icon={<EnvironmentOutlined />}
                                      onClick={() => {
                                        if (!canControl) return;
                                        Modal.confirm({
                                          title: `发起任务流程"${name}"？`,
                                          content: '将通过文本提问方式向设备发送该任务指令，设备会根据当前状态处理。',
                                          okText: '确认',
                                          cancelText: '取消',
                                          onOk: () => execute('textQuestion', { text: name }),
                                        });
                                      }}
                                    >
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {name}
                                      </span>
                                      {isRunning && <Tag color="blue" style={{ marginLeft: 4, fontSize: 9 }}>运行中</Tag>}
                                    </Button>
                                  </Col>
                                );
                              })}
                            </Row>
                          </div>
                        )}
                        {taskModes.unassigned.length > 0 && (
                          <div>
                            <div style={{ marginBottom: 6 }}>
                              <Space>
                                <Tag>未分配</Tag>
                                <Text type="secondary" style={{ fontSize: 11 }}>{taskModes.unassigned.length} 个</Text>
                              </Space>
                            </div>
                            <Row gutter={[8, 8]}>
                              {taskModes.unassigned.map((name) => {
                                const isRunning = snapshot?.command?.name === name;
                                return (
                                  <Col key={name} flex="1 1 200px">
                                    <Button
                                      block
                                      style={{ textAlign: 'left', height: 36 }}
                                      disabled={!canControl}
                                      type={isRunning ? 'primary' : 'default'}
                                      icon={<ThunderboltOutlined />}
                                      onClick={() => {
                                        if (!canControl) return;
                                        Modal.confirm({
                                          title: `发起任务流程"${name}"？`,
                                          content: '将通过文本提问方式向设备发送该任务指令，设备会根据当前状态处理。',
                                          okText: '确认',
                                          cancelText: '取消',
                                          onOk: () => execute('textQuestion', { text: name }),
                                        });
                                      }}
                                    >
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {name}
                                      </span>
                                      {isRunning && <Tag color="blue" style={{ marginLeft: 4, fontSize: 9 }}>运行中</Tag>}
                                    </Button>
                                  </Col>
                                );
                              })}
                            </Row>
                          </div>
                        )}
                      </Space>
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="设备没有可用的任务流程"
                      />
                    )
                  ) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={taskModesLoading ? '正在获取任务流程…' : '连接设备后将自动获取任务流程列表'}
                    />
                  )}
                </Card>
              </Col>

              {/* 右列：控制动作 + 文本提问 + 直达导航 */}
              <Col xs={24} lg={8}>
                {/* 控制动作 */}
                <Card
                  title={<Space><ThunderboltOutlined /> 控制动作</Space>}
                  extra={
                    <Tag color={canControl ? 'success' : 'default'}>
                      {canControl ? '可控制' : '已锁定'}
                    </Tag>
                  }
                  style={{ marginBottom: 16 }}
                >
                  {CONTROL_GROUPS.map((group, gi) => (
                    <div key={group.title} style={gi > 0 ? { marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0' } : undefined}>
                      <div style={{ marginBottom: 8 }}>
                        <Text strong style={{ fontSize: 13 }}>{group.title}</Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 11 }}>{group.description}</Text>
                      </div>
                      <Row gutter={[8, 8]}>
                        {group.items.map((item) => {
                          const enabled = Boolean(canControl && snapshot?.buttons[item.key]);
                          return (
                            <Col span={12} key={item.key}>
              <Button
                block
                icon={item.icon}
                disabled={!enabled}
                danger={item.danger}
                onClick={() => handleControlClick(item)}
                style={{ textAlign: 'left', height: 40 }}
              >
                {item.label}
              </Button>
                            </Col>
                          );
                        })}
                      </Row>
                    </div>
                  ))}
                </Card>

                {/* 文本提问 */}
                <Card
                  size="small"
                  title={<Space><MessageOutlined /> 文本提问</Space>}
                  style={{ marginBottom: 16 }}
                >
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
                      rows={3}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>Ctrl + Enter 发送 · {question.length}/500</Text>
                      <Button type="primary" size="small" htmlType="submit" icon={<SendOutlined />} disabled={!canControl || !question.trim()}>
                        发送
                      </Button>
                    </div>
                  </form>
                </Card>

                {/* 直达导航 */}
                <Card
                  size="small"
                  title={<Space><EnvironmentOutlined /> 直达导航</Space>}
                  extra={
                    pointGroup ? (
                      <Space size={4}>
                        <Text type="secondary" style={{ fontSize: 11 }}>{pointGroup.pointCount} 个点位</Text>
                        <Button
                          size="small"
                          type="text"
                          icon={pointGroupLoading ? <LoadingOutlined /> : <ReloadOutlined />}
                          onClick={controller.fetchPoints}
                          disabled={status !== 'connected'}
                        />
                      </Space>
                    ) : pointGroupLoading ? (
                      <LoadingOutlined style={{ fontSize: 12 }} />
                    ) : null
                  }
                >
                  {pointGroup && pointGroup.points.length > 0 ? (
                    <div>
                      <div style={{ marginBottom: 8 }}>
                        <Text type="secondary" style={{ fontSize: 11 }}>分组：{pointGroup.name}</Text>
                      </div>
                      <List
                        size="small"
                        dataSource={pointGroup.points}
                        renderItem={(pt: PointItem) => (
                          <List.Item
                            style={{ padding: '6px 0' }}
                            actions={[
                              <Button
                                key="nav"
                                size="small"
                                type="primary"
                                icon={<EnvironmentOutlined />}
                                disabled={!canControl || !pt.isActive}
                                onClick={() => navigateDirect(pt.command, pt.name)}
                              >
                                导航
                              </Button>,
                            ]}
                          >
                            <List.Item.Meta
                              avatar={
                                <div style={{
                                  width: 28, height: 28, borderRadius: '50%',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  background: pt.isChargingPile ? '#52c41a' : pt.isUiVisible ? '#1677ff' : '#f0f0f0',
                                  color: pt.isChargingPile || pt.isUiVisible ? '#fff' : '#8c8c8c',
                                  fontSize: 11, fontWeight: 600,
                                }}>
                                  {pt.isChargingPile ? <BatteryChargingIcon style={{ fontSize: 13 }} /> : <EnvironmentOutlined style={{ fontSize: 13 }} />}
                                </div>
                              }
                              title={
                                <Space size={4}>
                                  <Text strong style={{ fontSize: 13 }}>{pt.name}</Text>
                                  {pt.isChargingPile && <Tag color="green" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>充电桩</Tag>}
                                  {!pt.isActive && <Tag color="red" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>未启用</Tag>}
                                  {!pt.isUiVisible && <Tag style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>不可见</Tag>}
                                </Space>
                              }
                              description={
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  命令值: {pt.command}
                                </Text>
                              }
                            />
                          </List.Item>
                        )}
                      />
                      <Divider style={{ margin: '8px 0' }} />
                      <details>
                        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#8c8c8c' }}>
                          手动输入点位
                        </summary>
                        <form onSubmit={submitDirectNavigation} style={{ marginTop: 8 }}>
                          <Row gutter={8} style={{ marginBottom: 8 }}>
                            <Col span={10}>
                              <Text type="secondary" style={{ fontSize: 11 }}>点位值</Text>
                              <Input
                                size="small"
                                value={point}
                                onChange={(e) => setPoint(e.target.value)}
                                placeholder="例如 cdz"
                                autoComplete="off"
                              />
                            </Col>
                            <Col span={14}>
                              <Text type="secondary" style={{ fontSize: 11 }}>点位名称</Text>
                              <Input
                                size="small"
                                value={pointName}
                                onChange={(e) => setPointName(e.target.value)}
                                placeholder="例如 会议室"
                              />
                            </Col>
                          </Row>
                          <Button
                            block
                            icon={<EnvironmentOutlined />}
                            htmlType="submit"
                            disabled={!canControl || !point.trim() || !pointName.trim()}
                          >
                            导航到此点位
                          </Button>
                        </form>
                      </details>
                    </div>
                  ) : (
                    <div>
                      <Alert
                        type="info"
                        showIcon
                        message={pointGroup ? '点位分组为空' : '尚未获取点位分组'}
                        description={
                          pointGroup
                            ? '设备绑定的点位分组中没有点位。'
                            : status === 'connected'
                              ? '正在获取点位分组…'
                              : '连接设备后将自动获取点位分组。'
                        }
                        style={{ marginBottom: 12, fontSize: 12 }}
                      />
                      <details>
                        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#8c8c8c' }}>
                          手动输入点位
                        </summary>
                        <form onSubmit={submitDirectNavigation} style={{ marginTop: 8 }}>
                          <Row gutter={8} style={{ marginBottom: 8 }}>
                            <Col span={10}>
                              <Text type="secondary" style={{ fontSize: 11 }}>点位值</Text>
                              <Input
                                size="small"
                                value={point}
                                onChange={(e) => setPoint(e.target.value)}
                                placeholder="例如 cdz"
                                autoComplete="off"
                              />
                            </Col>
                            <Col span={14}>
                              <Text type="secondary" style={{ fontSize: 11 }}>点位名称</Text>
                              <Input
                                size="small"
                                value={pointName}
                                onChange={(e) => setPointName(e.target.value)}
                                placeholder="例如 会议室"
                              />
                            </Col>
                          </Row>
                          <Button
                            block
                            icon={<EnvironmentOutlined />}
                            htmlType="submit"
                            disabled={!canControl || !point.trim() || !pointName.trim()}
                          >
                            导航到此点位
                          </Button>
                        </form>
                      </details>
                    </div>
                  )}
                </Card>
              </Col>
            </Row>

            {/* 实时报文 */}
            <Card
              title={<Space><CodeOutlined /> 实时报文</Space>}
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
                  <Popconfirm
                    title="清空所有报文？"
                    onConfirm={controller.clearLogs}
                    disabled={!logs.length}
                  >
                    <Button size="small" danger icon={<CloseOutlined />} disabled={!logs.length} />
                  </Popconfirm>
                </Space>
              }
              style={{ marginTop: 16 }}
            >
              {filteredLogs.length ? (
                <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                  {filteredLogs.map((entry) => {
                    const expanded = expandedLog === entry.id;
                    return (
                      <div key={entry.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 0',
                            cursor: 'pointer',
                          }}
                          onClick={() => setExpandedLog(expanded ? null : entry.id)}
                        >
                          <Tag
                            color={LOG_DIR_COLORS[entry.direction]}
                            style={{ margin: 0, minWidth: 40, textAlign: 'center', flexShrink: 0 }}
                          >
                            {LOG_DIR_LABELS[entry.direction]}
                          </Tag>
                          <Text
                            code
                            style={{ fontSize: 11, flexShrink: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {entry.type}
                          </Text>
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontSize: 11,
                              fontFamily: 'monospace',
                              color: 'rgba(0, 0, 0, 0.45)',
                            }}
                            title={entry.raw}
                          >
                            {entry.raw}
                          </div>
                          <Text
                            type="secondary"
                            style={{ fontSize: 11, fontFamily: 'monospace', flexShrink: 0 }}
                          >
                            {formatTime(entry.timestamp)}
                          </Text>
                        </div>
                        {expanded && (
                          <pre style={{
                            margin: '0 0 8px',
                            padding: 12,
                            background: '#1a1a2e',
                            color: '#a9dc76',
                            borderRadius: 6,
                            fontSize: 11,
                            lineHeight: 1.6,
                            overflow: 'auto',
                            maxHeight: 300,
                            fontFamily: 'monospace',
                          }}>
                            {prettyRaw(entry.raw)}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={logs.length ? '当前筛选下没有报文' : '连接后可在这里核对发送与接收的原始消息'}
                />
              )}
            </Card>

            {/* 底部信息 */}
            <div style={{ padding: '16px 0', textAlign: 'center' }}>
              <Space size="large">
                <Text type="secondary" style={{ fontSize: 11 }}>
                  <ApiOutlined /> {activeUrl || socketPreview}
                </Text>
                <Text type="secondary" style={{ fontSize: 11 }}>WebSocket / JSON · 完整快照驱动</Text>
              </Space>
            </div>
          </Content>
        </Layout>
      </Layout>

      {/* 全部点位弹窗 */}
      <Modal
        title={flowName}
        open={pointsModalOpen}
        onCancel={() => setPointsModalOpen(false)}
        footer={null}
        width={600}
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          轨迹顺序与原始根任务数组一致；序号对应可见轨迹点，跳转使用节点的 step_id。
        </Paragraph>
        <List
          dataSource={routePoints}
          renderItem={(rp, index) => (
            <List.Item
              actions={[
                <Button
                  size="small"
                  disabled={!rp.canNavigate}
                  onClick={() => { requestJump(rp); setPointsModalOpen(false); }}
                >
                  跳转
                </Button>,
              ]}
            >
              <List.Item.Meta
                avatar={
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: routeProgressColor(rp.progress),
                    color: rp.progress === 'pending' ? '#8c8c8c' : '#fff',
                    fontSize: 12, fontWeight: 600,
                  }}>
                    {rp.progress === 'completed' ? <CheckOutlined /> : index + 1}
                  </div>
                }
                title={rp.name}
                description={
                  <Space>
                    <Text type="secondary" style={{ fontSize: 11 }}>主任务 {rp.rootIndex + 1}</Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>step_id {rp.stepId}</Text>
                    <Tag style={{ fontSize: 10 }}>{routeProgressText(rp.progress)}</Tag>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </Modal>

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
                const canDirect = Boolean(isNavigation && navPoint && navName && canControl);
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
                        ? [
                            canJump && (
                              <Button
                                key="jump"
                                size="small"
                                type="primary"
                                disabled={!canJump}
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
                                disabled={!canDirect}
                                onClick={() => {
                                  setFlowModalOpen(false);
                                  navigateDirect(navPoint, navName);
                                }}
                              >
                                直达
                              </Button>
                            ),
                          ].filter(Boolean) as React.ReactElement[]
                        : undefined
                    }
                  >
                    <List.Item.Meta
                      avatar={
                        <div style={{
                          width: 32, height: 32, borderRadius: '50%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: isCurrent ? '#1677ff' : isNavigation ? '#f0f0f0' : '#fafafa',
                          color: isCurrent ? '#fff' : '#8c8c8c',
                          fontSize: 12, fontWeight: 600,
                        }}>
                          {index + 1}
                        </div>
                      }
                      title={
                        <Space size={6}>
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
