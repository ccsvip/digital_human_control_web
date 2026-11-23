/**
 * 只读连接测试：不发送任何控制指令，只查询状态 / 点位分组 / 任务模式 / 音色列表。
 * 运行方式: node test-ws-readonly.mjs
 */
import { WebSocket } from 'ws';

const HOST = '192.168.3.248';
const PORT = 8880;
const WS_URL = `ws://${HOST}:${PORT}/ws/realtime/`;
const HTTP_BASE = `http://${HOST}:${PORT}`;
const DEVICE_CODE = '607d8074a632bd819b5a8f99ea714afeefd2d988ad82760350268fa30de42a33';
const TIMEOUT = 10_000;

const ts = Date.now().toString(36);
const requests = [
  {
    type: 'device.action',
    id: `ro-state-${ts}`,
    payload: { deviceCode: DEVICE_CODE, action: 'getState', stepId: null, text: null, point: null, pointName: null },
  },
  { type: 'device.point_group.get', id: `ro-pg-${ts}`, payload: { deviceCode: DEVICE_CODE } },
  { type: 'device.task_mode.get', id: `ro-tm-${ts}`, payload: { deviceCode: DEVICE_CODE } },
];
const expected = new Set(['device.task_flow.state', 'device.point_group', 'device.task_mode']);
const results = [];

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
}

async function testWs() {
  console.log(`连接 ${WS_URL}`);
  const socket = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时')), TIMEOUT);
    socket.once('open', () => { clearTimeout(t); resolve(); });
    socket.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  report('WebSocket 连接', true, '已连接');

  const got = new Map();
  const others = [];
  const done = new Promise((resolve) => {
    const t = setTimeout(resolve, TIMEOUT);
    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (expected.has(msg.type) && !got.has(msg.type)) got.set(msg.type, msg);
      else others.push(msg);
      if (got.size === expected.size) { clearTimeout(t); resolve(); }
    });
  });
  for (const r of requests) socket.send(JSON.stringify(r));
  await done;
  socket.close();

  const state = got.get('device.task_flow.state');
  if (state) {
    const p = state.payload ?? {};
    const info = p.deviceInfo ?? {};
    report('getState', true,
      `设备=${info.deviceName} 机器人连接=${info.robotConnected} IP=${info.robotIp} 电量=${info.robotBatteryPercent}% ` +
      `充电=${info.robotCharging} 正常=${info.robotNormal}${info.robotErrorMessage ? ' 错误=' + info.robotErrorMessage : ''}`);
    console.log('   taskState:', JSON.stringify(p.taskState));
    console.log('   command:', p.command ? `${p.command.name}（${p.command.tasks?.length ?? 0} 个主任务）` : 'null');
    console.log('   可用按钮:', Object.entries(p.buttons ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || '无');
  } else report('getState', false, '超时未收到 device.task_flow.state（设备可能离线）');

  const pg = got.get('device.point_group');
  if (pg) {
    const g = pg.payload?.pointGroup;
    report('点位分组', true, g ? `${g.name}，${g.points?.length ?? 0} 个点位：${(g.points ?? []).map((x) => x.name).join('、')}` : 'pointGroup=null');
  } else report('点位分组', false, '超时未收到 device.point_group');

  const tm = got.get('device.task_mode');
  if (tm) report('任务模式', true, JSON.stringify(tm.payload?.modes));
  else report('任务模式', false, '超时未收到 device.task_mode');

  for (const m of others) {
    console.log(`   其他消息 ${m.type}:`, JSON.stringify(m.error ?? m.payload ?? m).slice(0, 300));
  }
}

async function testVoices() {
  try {
    const resp = await fetch(`${HTTP_BASE}/api/v1/ai-models/tts/options/`, {
      headers: { 'X-Device-Code': DEVICE_CODE },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!resp.ok) return report('音色列表', false, `HTTP ${resp.status}`);
    const d = await resp.json();
    const voices = d.voices ?? d.items ?? d.list ?? [];
    report('音色列表', true, `${voices.length} 个：${voices.map((v) => `${v.displayName ?? v.name}${v.isDefault ? '(默认)' : ''}`).join('、')}`);
  } catch (e) {
    report('音色列表', false, e.message);
  }
}

try {
  await testWs();
} catch (e) {
  report('WebSocket 连接', false, e.message);
}
await testVoices();
const fail = results.filter((r) => !r.ok).length;
console.log(`\n共 ${results.length} 项，通过 ${results.length - fail}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
