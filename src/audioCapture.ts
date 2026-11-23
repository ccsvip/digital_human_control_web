/**
 * 浏览器麦克风采集，输出 16 kHz、单声道、s16le PCM，每片约 3200 字节（100 ms），
 * 供云端 /ws/realtime/ 的 asr.session 流式识别使用。
 */
const TARGET_SAMPLE_RATE = 16_000;
const CHUNK_BYTES = 3_200;
const SAMPLES_PER_CHUNK = CHUNK_BYTES / 2;

export interface PcmCapture {
  /** 停止采集；会先把不足一片的剩余音频交给 onChunk，可重复调用 */
  stop: () => void;
}

/** 浏览器只允许在安全上下文（https 或 localhost）里使用麦克风 */
export function isMicrophoneSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function describeMicError(reason: unknown): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return '浏览器只允许在 https 或 localhost 下使用麦克风';
  }
  const name = reason instanceof Error ? reason.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝，请在浏览器地址栏允许使用麦克风';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的麦克风';
  if (name === 'NotReadableError') return '麦克风被其他程序占用';
  return reason instanceof Error && reason.message ? reason.message : '无法打开麦克风';
}

export async function startPcmCapture(onChunk: (chunk: ArrayBuffer) => void): Promise<PcmCapture> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(describeMicError(null));
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('当前浏览器不支持录音');
  }
  const context = new AudioContextCtor();
  if (context.state === 'suspended') await context.resume().catch(() => undefined);

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const ratio = context.sampleRate / TARGET_SAMPLE_RATE;

  let leftover = new Float32Array(0);
  let pending: number[] = [];
  const emit = (count: number) => {
    const chunk = new Int16Array(pending.slice(0, count));
    pending = pending.slice(count);
    onChunk(chunk.buffer);
  };

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const merged = new Float32Array(leftover.length + input.length);
    merged.set(leftover);
    merged.set(input, leftover.length);
    // 简单平均降采样到 16 kHz
    const outCount = Math.floor(merged.length / ratio);
    for (let i = 0; i < outCount; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += merged[j];
      const v = Math.max(-1, Math.min(1, sum / (end - start)));
      pending.push(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff));
    }
    leftover = merged.slice(Math.floor(outCount * ratio));
    while (pending.length >= SAMPLES_PER_CHUNK) emit(SAMPLES_PER_CHUNK);
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      if (pending.length > 0) emit(pending.length);
      try {
        source.disconnect();
        processor.disconnect();
        mute.disconnect();
      } catch {
        // 节点已断开时忽略
      }
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    },
  };
}
