/**
 * WebSocket 接口测试脚本
 * 连接 ws://192.168.3.248:8880/ws/realtime/ 并逐一测试每个 action
 *
 * 运行方式: node test-ws.mjs
 */

import { WebSocket } from 'ws';

const WS_URL = 'ws://192.168.3.248:8880/ws/realtime/';
const DEVICE_CODE = '607d8074a632bd819b5a8f99ea714afeefd2d988ad82760350268fa30de42a33';
const RECEIVE_TIMEOUT = 8000; // 等待响应的超时时间

// ========== 工具函数 ==========

let messageCounter = 0;

function createDeviceAction(action, params = {}) {
  const id = `test-${Date.now()}-${++messageCounter}`;
  return JSON.stringify({
    type: 'device.action',
    id,
    payload: {
      deviceCode: DEVICE_CODE,
      action,
      stepId: params.stepId ?? null,
      text: params.text ?? null,
      point: params.point ?? null,
      pointName: params.pointName ?? null,
    },
  });
}

function timestamp() {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function log(tag, message) {
  console.log(`[${timestamp()}] [${tag}] ${message}`);
}

function logJson(tag, obj) {
  console.log(`[${timestamp()}] [${tag}]`);
  console.log(JSON.stringify(obj, null, 2));
}

// ========== 等待消息 ==========

function waitForMessage(socket, predicate, timeout = RECEIVE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error(`等待消息超时（${timeout}ms）`));
    }, timeout);

    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (!predicate || predicate(msg)) {
          clearTimeout(timer);
          socket.off('message', handler);
          resolve(msg);
        }
      } catch {
        // 忽略无法解析的消息
      }
    }
    socket.on('message', handler);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== 主测试流程 ==========

async function main() {
  console.log('='.repeat(70));
  console.log('  WebSocket 接口测试');
  console.log(`  目标: ${WS_URL}`);
  console.log(`  设备码: ${DEVICE_CODE.slice(0, 16)}...`);
  console.log('='.repeat(70));
  console.log();

  // 1. 连接测试
  log('CONNECT', `正在连接 ${WS_URL} ...`);
  const socket = new WebSocket(WS_URL);
  const results = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时（10s）')), 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  log('CONNECT', '✅ WebSocket 连接成功');
  results.push({ test: 'WebSocket 连接', status: 'PASS', detail: `已连接 ${WS_URL}` });

  // 收集所有接收到的消息
  const receivedMessages = [];
  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      receivedMessages.push(msg);
    } catch { /* ignore */ }
  });

  // 2. 测试 getState —— 获取当前状态
  console.log();
  log('TEST', '--- 1/13: getState (获取当前状态) ---');
  try {
    const action = createDeviceAction('getState');
    log('SEND', action);
    socket.send(action);

    const response = await waitForMessage(
      socket,
      (msg) => msg.type === 'device.task_flow.state',
      RECEIVE_TIMEOUT,
    );
    log('RECV', `收到 device.task_flow.state (id: ${response.id})`);
    logJson('RECV', response);

    // 验证响应结构
    const payload = response.payload;
    const checks = [
      ['type === device.task_flow.state', response.type === 'device.task_flow.state'],
      ['payload 存在', !!payload],
      ['payload.deviceCode 存在', typeof payload?.deviceCode === 'string'],
      ['payload.deviceInfo 存在', typeof payload?.deviceInfo === 'object'],
      ['payload.command 字段存在', 'command' in (payload ?? {})],
      ['payload.taskState 存在', typeof payload?.taskState === 'object'],
      ['payload.buttons 存在', typeof payload?.buttons === 'object'],
      ['taskState.taskIndex 存在', 'taskIndex' in (payload?.taskState ?? {})],
      ['taskState.status 存在', 'status' in (payload?.taskState ?? {})],
      ['taskState.innerTaskIndex 存在', 'innerTaskIndex' in (payload?.taskState ?? {})],
      ['taskState.innerTaskStatus 存在', 'innerTaskStatus' in (payload?.taskState ?? {})],
    ];
    const allPassed = checks.every(([, v]) => v);
    checks.forEach(([label, passed]) => {
      log('CHECK', `${passed ? '✅' : '❌'} ${label}`);
    });
    results.push({ test: 'getState', status: allPassed ? 'PASS' : 'WARN', detail: `收到状态响应，${checks.filter(([, v]) => !v).length} 项校验未通过` });

    // 从状态中提取按钮信息用于后续测试
    var buttons = payload?.buttons ?? {};
    var deviceInfo = payload?.deviceInfo ?? {};
    var taskState = payload?.taskState ?? {};
    var command = payload?.command ?? null;
    var snapshot = payload;

    log('INFO', `设备名称: ${deviceInfo.deviceName || '未知'}`);
    log('INFO', `机器人连接: ${deviceInfo.robotConnected}`);
    log('INFO', `机器人IP: ${deviceInfo.robotIp || '无'}`);
    log('INFO', `电池电量: ${deviceInfo.robotBatteryPercent ?? '未知'}%`);
    log('INFO', `任务状态: ${taskState.status}`);
    log('INFO', `主任务索引: ${taskState.taskIndex}`);
    log('INFO', `按钮状态: ${JSON.stringify(buttons)}`);
  } catch (err) {
    log('FAIL', `getState 失败: ${err.message}`);
    results.push({ test: 'getState', status: 'FAIL', detail: err.message });
    var buttons = {};
    var deviceInfo = {};
    var taskState = {};
    var command = null;
    var snapshot = null;
  }

  await sleep(1000);

  // 定义需要测试的按钮动作（不含需要确认的危险动作的只发 getState 后查看）
  const buttonActions = [
    { name: 'pauseTask', label: '暂停任务', needsSnapshot: true, buttonKey: 'pauseTask' },
    { name: 'resumeTask', label: '继续任务', needsSnapshot: true, buttonKey: 'resumeTask' },
    { name: 'skipCurrentTask', label: '跳过当前任务', needsSnapshot: true, buttonKey: 'skipCurrentTask' },
    { name: 'startDialogue', label: '开始对话', needsSnapshot: true, buttonKey: 'startDialogue' },
    { name: 'interruptDialogue', label: '打断对话', needsSnapshot: true, buttonKey: 'interruptDialogue' },
    { name: 'endDialogue', label: '结束对话', needsSnapshot: true, buttonKey: 'endDialogue' },
    { name: 'stopNavigation', label: '停止导航', needsSnapshot: true, buttonKey: 'stopNavigation' },
    { name: 'endRecording', label: '结束录音', needsSnapshot: true, buttonKey: 'endRecording' },
  ];

  // 3-10: 测试按钮类动作
  let testIndex = 2;
  for (const action of buttonActions) {
    console.log();
    log('TEST', `--- ${testIndex}/13: ${action.name} (${action.label}) ---`);
    testIndex++;

    const buttonEnabled = buttons[action.buttonKey] === true;
    log('INFO', `按钮 ${action.buttonKey} 当前状态: ${buttonEnabled ? '可用' : '不可用'}`);

    try {
      const msg = createDeviceAction(action.name);
      log('SEND', msg);
      socket.send(msg);
      log('SEND', `✅ ${action.name} 指令已发送`);

      // 等待可能的状态更新（非阻塞，3秒超时）
      try {
        const stateUpdate = await waitForMessage(
          socket,
          (m) => m.type === 'device.task_flow.state',
          4000,
        );
        log('RECV', `收到状态更新 (id: ${stateUpdate.id})`);
        logJson('RECV', stateUpdate);

        // 更新 buttons 和 snapshot
        buttons = stateUpdate.payload?.buttons ?? buttons;
        snapshot = stateUpdate.payload;

        results.push({
          test: action.name,
          status: 'PASS',
          detail: `指令已发送，收到状态更新。按钮${buttonEnabled ? '可用' : '不可用（仍发送测试）'}`,
        });
      } catch {
        log('INFO', '4秒内未收到状态更新（协议不要求对无效动作返回响应）');
        results.push({
          test: action.name,
          status: buttonEnabled ? 'WARN' : 'PASS',
          detail: `指令已发送，按钮${buttonEnabled ? '可用但未收到响应' : '不可用（预期无响应）'}`,
        });
      }
    } catch (err) {
      log('FAIL', `${action.name} 失败: ${err.message}`);
      results.push({ test: action.name, status: 'FAIL', detail: err.message });
    }

    await sleep(800);
  }

  // 11: textQuestion
  console.log();
  log('TEST', `--- ${testIndex}/13: textQuestion (文本提问) ---`);
  testIndex++;
  try {
    const msg = createDeviceAction('textQuestion', { text: '你好，请简单介绍一下自己。' });
    log('SEND', msg);
    socket.send(msg);
    log('SEND', '✅ textQuestion 指令已发送');

    try {
      const stateUpdate = await waitForMessage(
        socket,
        (m) => m.type === 'device.task_flow.state',
        4000,
      );
      log('RECV', `收到状态更新 (id: ${stateUpdate.id})`);
      logJson('RECV', stateUpdate);
      buttons = stateUpdate.payload?.buttons ?? buttons;
      results.push({ test: 'textQuestion', status: 'PASS', detail: '文本提问已发送，收到状态更新' });
    } catch {
      log('INFO', '4秒内未收到状态更新');
      results.push({ test: 'textQuestion', status: 'WARN', detail: '文本提问已发送，未收到状态响应' });
    }
  } catch (err) {
    log('FAIL', `textQuestion 失败: ${err.message}`);
    results.push({ test: 'textQuestion', status: 'FAIL', detail: err.message });
  }
  await sleep(1000);

  // 12: navigateToPoint
  console.log();
  log('TEST', `--- ${testIndex}/13: navigateToPoint (直达导航) ---`);
  testIndex++;
  try {
    const robotConnected = deviceInfo.robotConnected === true;
    log('INFO', `机器人连接状态: ${robotConnected ? '已连接' : '未连接'}`);

    const msg = createDeviceAction('navigateToPoint', { point: 'test_point', pointName: '测试点位' });
    log('SEND', msg);
    socket.send(msg);
    log('SEND', '✅ navigateToPoint 指令已发送');

    try {
      const stateUpdate = await waitForMessage(
        socket,
        (m) => m.type === 'device.task_flow.state',
        4000,
      );
      log('RECV', `收到状态更新 (id: ${stateUpdate.id})`);
      logJson('RECV', stateUpdate);
      buttons = stateUpdate.payload?.buttons ?? buttons;
      results.push({ test: 'navigateToPoint', status: 'PASS', detail: '导航指令已发送，收到状态更新' });
    } catch {
      log('INFO', '4秒内未收到状态更新');
      results.push({ test: 'navigateToPoint', status: 'WARN', detail: '导航指令已发送，未收到状态响应' });
    }
  } catch (err) {
    log('FAIL', `navigateToPoint 失败: ${err.message}`);
    results.push({ test: 'navigateToPoint', status: 'FAIL', detail: err.message });
  }
  await sleep(1000);

  // 13: endTask
  console.log();
  log('TEST', `--- ${testIndex}/13: endTask (结束任务流程) ---`);
  testIndex++;
  try {
    const msg = createDeviceAction('endTask');
    log('SEND', msg);
    socket.send(msg);
    log('SEND', '✅ endTask 指令已发送');

    try {
      const stateUpdate = await waitForMessage(
        socket,
        (m) => m.type === 'device.task_flow.state',
        4000,
      );
      log('RECV', `收到状态更新 (id: ${stateUpdate.id})`);
      logJson('RECV', stateUpdate);
      buttons = stateUpdate.payload?.buttons ?? buttons;
      results.push({ test: 'endTask', status: 'PASS', detail: '结束任务指令已发送，收到状态更新' });
    } catch {
      log('INFO', '4秒内未收到状态更新');
      results.push({ test: 'endTask', status: 'WARN', detail: '结束任务指令已发送，未收到状态响应' });
    }
  } catch (err) {
    log('FAIL', `endTask 失败: ${err.message}`);
    results.push({ test: 'endTask', status: 'FAIL', detail: err.message });
  }
  await sleep(1000);

  // ========== 额外测试：jumpToNavigationStep ==========
  console.log();
  log('TEST', `--- 额外: jumpToNavigationStep (跳转导航步骤) ---`);
  // 从快照中提取可用的 stepId
  if (snapshot?.command?.tasks) {
    const navTasks = snapshot.command.tasks.filter(
      (t) => t.type === 'navigation' && typeof t.step_id === 'number' && t.step_id > 0,
    );
    if (navTasks.length > 0) {
      const targetStep = navTasks[0];
      try {
        const msg = createDeviceAction('jumpToNavigationStep', { stepId: targetStep.step_id });
        log('SEND', msg);
        socket.send(msg);
        log('SEND', `✅ jumpToNavigationStep(stepId=${targetStep.step_id}) 指令已发送`);

        try {
          const stateUpdate = await waitForMessage(
            socket,
            (m) => m.type === 'device.task_flow.state',
            4000,
          );
          log('RECV', `收到状态更新 (id: ${stateUpdate.id})`);
          logJson('RECV', stateUpdate);
          results.push({ test: 'jumpToNavigationStep', status: 'PASS', detail: `跳转到 stepId=${targetStep.step_id}，收到状态更新` });
        } catch {
          log('INFO', '4秒内未收到状态更新');
          results.push({ test: 'jumpToNavigationStep', status: 'WARN', detail: `跳转指令已发送(stepId=${targetStep.step_id})，未收到状态响应` });
        }
      } catch (err) {
        log('FAIL', `jumpToNavigationStep 失败: ${err.message}`);
        results.push({ test: 'jumpToNavigationStep', status: 'FAIL', detail: err.message });
      }
    } else {
      log('INFO', '快照中没有可用的导航步骤（step_id > 0），跳过 jumpToNavigationStep 测试');
      results.push({ test: 'jumpToNavigationStep', status: 'SKIP', detail: '无可用导航步骤' });
    }
  } else {
    log('INFO', '无任务树(command=null)，跳过 jumpToNavigationStep 测试');
    results.push({ test: 'jumpToNavigationStep', status: 'SKIP', detail: '无任务树' });
  }
  await sleep(500);

  // ========== 额外测试：shutdownRobot（仅发送，不实际关机） ==========
  console.log();
  log('TEST', `--- 额外: shutdownRobot (机器人关机 - 仅测试消息格式，请注意) ---`);
  log('WARN', '⚠️  此操作会请求机器人关机！跳过实际发送，仅验证消息构造。');
  const shutdownMsg = createDeviceAction('shutdownRobot');
  log('FORMAT', `构造消息: ${shutdownMsg}`);
  const parsed = JSON.parse(shutdownMsg);
  const formatOk = parsed.type === 'device.action'
    && parsed.payload.action === 'shutdownRobot'
    && parsed.payload.stepId === null
    && parsed.payload.text === null
    && parsed.payload.point === null
    && parsed.payload.pointName === null;
  log('CHECK', `${formatOk ? '✅' : '❌'} 消息格式正确`);
  results.push({ test: 'shutdownRobot', status: formatOk ? 'PASS' : 'FAIL', detail: '消息格式验证（未实际发送）' });

  // ========== 额外测试：screen_offline / screen_online 消息处理 ==========
  console.log();
  log('TEST', `--- 额外: 接收消息统计 ---`);
  log('INFO', `总共接收到 ${receivedMessages.length} 条消息`);
  const typeCounts = {};
  for (const msg of receivedMessages) {
    const type = msg.type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }
  log('INFO', `消息类型分布: ${JSON.stringify(typeCounts)}`);
  results.push({ test: '消息接收统计', status: 'PASS', detail: `共接收 ${receivedMessages.length} 条，类型: ${JSON.stringify(typeCounts)}` });

  // 关闭连接
  console.log();
  log('CLOSE', '正在关闭 WebSocket 连接...');
  socket.close();
  await sleep(500);
  log('CLOSE', '✅ 连接已关闭');

  // ========== 汇总 ==========
  console.log();
  console.log('='.repeat(70));
  console.log('  测试结果汇总');
  console.log('='.repeat(70));
  console.log();

  const padLen = Math.max(...results.map((r) => r.test.length)) + 2;
  console.log(`${'测试项'.padEnd(padLen)}  状态    详情`);
  console.log('-'.repeat(90));
  for (const r of results) {
    const statusIcon = r.status === 'PASS' ? '✅ PASS' : r.status === 'WARN' ? '⚠️  WARN' : r.status === 'SKIP' ? '⏭️  SKIP' : '❌ FAIL';
    console.log(`${r.test.padEnd(padLen)}  ${statusIcon}   ${r.detail}`);
  }
  console.log('-'.repeat(90));

  const passCount = results.filter((r) => r.status === 'PASS').length;
  const warnCount = results.filter((r) => r.status === 'WARN').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n总计: ${results.length} 项 | ✅ PASS: ${passCount} | ⚠️ WARN: ${warnCount} | ❌ FAIL: ${failCount} | ⏭️ SKIP: ${skipCount}`);
  console.log();
}

main().catch((err) => {
  console.error(`\n❌ 测试执行失败: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
