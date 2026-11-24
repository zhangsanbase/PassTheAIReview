const WebSocket = require('ws');
const { randomUUID } = require('node:crypto');
const { httpError } = require('./answer');
class Transcriber {
  constructor(onSentence, onFailure, Socket = WebSocket) { Object.assign(this, { onSentence, onFailure, Socket, ready: false, socket: null, stopping: false }); }
  async start(settings, sampleRate) {
    this.stop();
    this.stopping = false;
    if (!settings.asrKey || !settings.workspace) throw new Error('请先填写百炼 API Key 和业务空间 ID');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('音频采样率无效');
    const domain = settings.region === 'singapore' ? 'ap-southeast-1' : 'cn-beijing';
    const socket = new this.Socket(`wss://${settings.workspace}.${domain}.maas.aliyuncs.com/api-ws/v1/inference`, { headers: { Authorization: `Bearer ${settings.asrKey}` }, handshakeTimeout: 15000 });
    this.socket = socket; this.rate = sampleRate; this.id = randomUUID(); const session = this.id;
    let settled = false;
    await new Promise((resolve, reject) => {
      const fail = message => {
        clearTimeout(timer);
        if (this.socket !== socket) { if (!settled) { settled = true; reject(new Error('识别启动已取消')); } return; }
        this.socket = null; this.ready = false; socket.terminate();
        if (!settled) { settled = true; reject(new Error(message)); } else this.onFailure(message);
      };
      const timer = setTimeout(() => fail('语音识别连接超时，请检查网络及地域'), 15000);
      socket.on('open', () => {
        if (this.socket !== socket) return;
        const model = settings.asrModel?.trim() || 'fun-asr-realtime';
        socket.send(JSON.stringify({ header: { action: 'run-task', task_id: session, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, input: {}, parameters: { format: 'pcm', sample_rate: sampleRate, max_sentence_silence: settings.silenceMs, heartbeat: true } } }));
      });
      socket.on('message', raw => {
        if (this.socket !== socket) return;
        try {
          const event = JSON.parse(raw.toString());
          if (event.header?.task_id !== session) return;
          if (event.header.event === 'task-started') { clearTimeout(timer); this.ready = true; settled = true; resolve(); }
          if (event.header.event === 'result-generated') {
            const sentence = event.payload?.output?.sentence || {};
            if (this.audioStartedAt && Number.isFinite(sentence.end_time)) sentence.endedAt = this.audioStartedAt + sentence.end_time;
            this.onSentence(session, sentence);
          }
          if (event.header.event === 'task-failed') fail('语音识别任务失败，请检查余额、模型权限、业务空间及地域');
        } catch { fail('语音识别返回了无法读取的数据'); }
      });
      socket.on('unexpected-response', (_req, response) => { response.resume(); fail(httpError(response.statusCode, '百炼')); });
      socket.on('error', () => fail('语音识别连接失败，请检查网络和服务配置'));
      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(this.stopping || this.socket !== socket ? '识别启动已取消' : '识别连接在启动前关闭'));
        }
        if (this.socket === socket) { this.socket = null; this.ready = false; this.onFailure('识别连接已断开；此期间转写存在缺口，请重新开始'); }
      });
    });
  }
  audio(bytes) {
    if (!this.ready || !this.socket) return;
    const buffer = Buffer.from(bytes);
    if (!buffer.length || buffer.length > this.rate * 2 || buffer.length % 2) return;
    if (this.socket.bufferedAmount > this.rate * 4) {
      this.stop(); this.onFailure('音频发送积压，已暂停；请检查网络后重新开始'); return;
    }
    this.audioStartedAt ||= Date.now() - buffer.length / (this.rate * 2) * 1000;
    this.socket.send(buffer);
  }
  stop() {
    this.stopping = true;
    const socket = this.socket; this.socket = null; this.ready = false; this.audioStartedAt = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ header: { action: 'finish-task', task_id: this.id, streaming: 'duplex' }, payload: { input: {} } }));
      socket.close(); const timer = setTimeout(() => socket.terminate(), 1000); timer.unref();
    } else socket.terminate();
  }
}
module.exports = { Transcriber };
