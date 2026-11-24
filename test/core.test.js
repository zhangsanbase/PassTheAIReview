const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Questions, languageOf } = require('../src/state');
const { messagesFor, parseSSE, generate, endpointFor } = require('../src/answer');
const { Transcriber } = require('../src/asr');
const { Config, defaults } = require('../src/config');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('中文含英文术语只走中文，英文和强制语言可用', () => {
  for (const question of ['请介绍一下你自己', '解释一下 React 的 useEffect 和 API', '什么是 SQL 索引', '你如何使用 Node.js', '谈谈你的项目经历', 'I2C SPI DMA 区别', 'React useEffect useState 区别']) assert.equal(languageOf(question), 'zh');
  for (const question of ['Tell me about yourself.', 'Why this role?', 'How do you handle pressure?', 'Describe your project.', 'What is a SQL index?']) assert.equal(languageOf(question), 'en');
  assert.equal(languageOf('什么是 API', 'en'), 'en');
  assert.match(messagesFor({ text: '介绍 React' }, defaults, [], false)[0].content, /只用中文回答/);
  assert.match(messagesFor({ text: 'Tell me about yourself' }, defaults, [], false)[0].content, /【English answer】/);
});
test('手动提交中间结果后，定稿和重复事件不自动重提', () => {
  const state = new Questions();
  const q = state.sentence('session', { sentence_id: 1, text: '介绍一下', sentence_end: false });
  assert.equal(state.claim(q), true);
  assert.equal(state.claim(q), false);
  assert.equal(state.sentence('session', { sentence_id: 1, text: '介绍一下你自己', sentence_end: true }).id, q.id);
  assert.equal(q.submitted, true); assert.equal(state.claim(q), false);
  assert.equal(state.sentence('session', { sentence_id: 1, text: '介绍一下你自己', sentence_end: true }), null);
  assert.notEqual(state.sentence('session', { sentence_id: 2, text: '介绍一下你自己', sentence_end: true }).id, q.id);
});
test('长问题合并、跨会话句号隔离、编辑后重答', () => {
  const state = new Questions();
  const q = state.sentence('a', { sentence_id: 1, text: '讲一下项目', sentence_end: true });
  assert.equal(state.sentence('a', { sentence_id: 2, text: '特别是困难', sentence_end: true }).id, q.id);
  assert.match(q.text, /讲一下项目 特别是困难/);
  state.claim(q);
  const next = state.sentence('b', { sentence_id: 1, text: '你的职责呢', sentence_end: true });
  const merged = state.merge(next.id); assert.match(merged.text, /困难\n你的职责/);
  state.claim(merged); state.edit(merged.id, '修改后的问题', 'zh'); assert.equal(state.claim(merged), true);
});
test('SSE 支持逐字节 UTF8、CRLF、心跳和多个消息', async () => {
  const bytes = Buffer.from(': ping\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n');
  async function* chunks() { for (const b of bytes) yield Uint8Array.of(b); }
  let output = ''; for await (const text of parseSSE(chunks())) output += text;
  assert.equal(output, '你好 world');
});
test('SSE 不把断流当成完整回答', async () => {
  async function* broken() { yield Buffer.from('data: {"choices":[]}\n'); }
  await assert.rejects(async () => { for await (const _ of parseSSE(broken())) {} }, /提前结束/);
});
test('生成参数关闭思考、开启流式；HTTP 401 使用可理解错误', async () => {
  const settings = { ...defaults, deepseekKey: 'test-only' }; let request;
  const fetcher = async (_url, options) => { request = JSON.parse(options.body); return new Response('data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n'); };
  let result = ''; await generate({ text: '你好' }, settings, [], false, new AbortController().signal, x => result += x, fetcher);
  assert.equal(result, '回答'); assert.equal(request.stream, true); assert.equal(request.thinking.type, 'disabled');
  await assert.rejects(generate({ text: 'hi' }, settings, [], false, null, () => {}, async () => new Response('', { status: 401 })), /鉴权失败/);
});
test('请求取消能中断响应读取', async () => {
  const controller = new AbortController();
  const fetcher = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  const pending = generate({ text: 'hi' }, { ...defaults, deepseekKey: 'test' }, [], false, controller.signal, () => {}, fetcher);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
test('历史仅携带最近五轮已完成的参考答案', () => {
  const history = Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: `q${i}`, answer: `a${i}`, status: i === 8 ? 'interrupted' : 'done' }));
  const messages = messagesFor({ id: 'new', text: '中文' }, defaults, history, false);
  assert.equal(messages.length, 12); assert.equal(messages[1].content, 'q3'); assert.match(messages[2].content, /软件参考建议/);
});
test('配置密钥不暴露到页面、空白保留、可清除；非法参数被拒绝', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
  try {
    const crypto = { isEncryptionAvailable: () => true, encryptString: x => Buffer.from(`encrypted:${x}`), decryptString: b => b.toString().slice(10) };
    const store = new Config(directory, crypto);
    const saved = store.save({ deepseekKey: 'secret-key', asrKey: 'asr-key', profile: 'real experience' }, defaults);
    assert.equal(store.load().deepseekKey, 'secret-key'); assert.equal(store.public(saved).deepseekKey, undefined);
    assert.equal(store.public(saved).hasDeepseekKey, true);
    assert.ok(!fs.readFileSync(store.file, 'utf8').includes('secret-key'));
    assert.equal(store.save({ deepseekKey: '' }, saved).deepseekKey, 'secret-key');
    assert.equal(store.save({ clear_deepseekKey: true }, saved).deepseekKey, '');
    assert.throws(() => store.save({ silenceMs: 1 }, saved), /超出/);
    store.save({ audioSource: 'microphone' }, saved);
    assert.equal(store.load().audioSource, 'microphone');
    assert.throws(() => store.save({ audioSource: 'camera' }, saved), /声音来源无效/);
    store.save({ theme: 'dark', asrModel: ' paraformer-realtime-v2 ', baseUrl: ' https://api.openai.com/v1/ ' }, saved);
    assert.equal(store.load().theme, 'dark');
    assert.equal(store.load().asrModel, 'paraformer-realtime-v2');
    assert.equal(store.load().baseUrl, 'https://api.openai.com/v1/');
    assert.equal(store.save({ asrModel: '   ', baseUrl: '  ' }, saved).asrModel, '');
    assert.equal(store.save({ baseUrl: '  ' }, saved).baseUrl, '');
    assert.throws(() => store.save({ theme: 'sepia' }, saved), /主题模式无效/);
    assert.throws(() => store.save({ baseUrl: 'ftp://example.com' }, saved), /接口地址格式无效/);
    assert.throws(() => store.save({ baseUrl: 'not-a-url' }, saved), /接口地址格式无效/);
    // An external importer updates the profile while a window retains `saved`.
    const imported = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    imported.profile = 'Imported complete profile'; imported.role = '设备工程师';
    fs.writeFileSync(store.file, JSON.stringify(imported));
    const merged = store.save({ top: true }, saved);
    assert.equal(merged.profile, imported.profile); assert.equal(merged.role, imported.role);
    assert.equal(merged.deepseekKey, ''); assert.equal(merged.asrKey, 'asr-key'); assert.equal(merged.top, true);
  } finally { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true }); }
});
test('删除题目阻止ASR迟到结果复活，撤销可恢复，删除最后一题清空当前', () => {
  const state = new Questions();
  const q = state.sentence('delete', { sentence_id: 1, text: 'partial', sentence_end: false });
  state.remove(q.id); assert.equal(state.current, null);
  assert.equal(state.sentence('delete', { sentence_id: 1, text: 'final', sentence_end: true }), null);
  assert.equal(state.items.length, 0);
  assert.throws(() => state.edit(q.id, 'stale', 'auto'), /已不存在/);
  state.undo(); assert.equal(state.current.id, q.id);
  state.sentence('delete', { sentence_id: 1, text: 'final', sentence_end: true });
  assert.equal(state.current.text, 'final');
  const next = state.create('next'); state.remove(q.id); assert.equal(state.current.id, next.id);
  state.remove(next.id); assert.equal(state.current, null);
});
test('合并保留编辑与语言，连续合并不重复加入原始片段', () => {
  const state = new Questions();
  const first = state.create('第一部分'); const second = state.create('第二部分'); const third = state.create('第三部分');
  state.edit(third.id, '第三部分已编辑', 'en');
  const merged = state.merge(third.id); assert.equal(merged.text, '第二部分\n第三部分已编辑'); assert.equal(merged.language, 'en');
  const full = state.merge(merged.id); assert.equal(full.text, '第一部分\n第二部分\n第三部分已编辑');
  assert.equal(state.items.find(q => q.id === first.id).text, '第一部分');
  assert.throws(() => state.merge(full.id), /没有可合并/);
});
test('英文输出约定为原题、题目译文、逐句英文和中文，流式片段可渲染', () => {
  const { blocks } = require('../src/ui/answer-view');
  const prompt = messagesFor({text:'Tell me about yourself.'}, defaults, [], false)[0].content;
  assert.match(prompt, /【英文原题】/); assert.match(prompt, /【题目中文译文】/); assert.match(prompt, /每个EN:行只放一句英文/);
  const parsed = blocks('【英文原题】\nTell me about yourself.\n【题目中文译文】\n介绍你自己。\n【English answer】\nEN: I am a student.\nZH: 我是一名学生。\nEN: I study electronics.\nZH: 我学习电子技术。');
  assert.deepEqual(parsed.slice(-4).map(x => x.kind), ['english', 'translation', 'english', 'translation']);
  assert.equal(blocks('EN: I am')[0].text, 'I am');
  assert.equal(blocks('EN: <script>alert(1)</script>')[0].text, '<script>alert(1)</script>');
});
test('音频处理下混、限幅、50ms分块，静音仍持续发送且不回放', () => {
  const vm = require('node:vm'); let Processor;
  const frames = [];
  const context = { sampleRate: 40, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: event => frames.push(event) }; } }, registerProcessor: (_name, Class) => Processor = Class };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/pcm-worklet.js'), 'utf8'), context);
  const processor = new Processor();
  const output = [[new Float32Array(2)]];
  processor.process([[Float32Array.of(1, -2), Float32Array.of(1, -2)]], output);
  assert.deepEqual([...new Int16Array(frames[0].pcm)], [32767, -32768]);
  assert.deepEqual([...output[0][0]], [0, 0]);
  processor.process([[]], output); assert.deepEqual([...new Int16Array(frames[1].pcm)], [0, 0]);
});
test('识别未就绪不发音频；失败关闭连接；积压不重放', async () => {
  class Socket extends EventEmitter {
    static instance;
    constructor() { super(); this.sent = []; this.bufferedAmount = 0; this.readyState = 0; Socket.instance = this; }
    send(data) { this.sent.push(data); }
    terminate() { this.readyState = 3; this.emit('close'); }
    close() { this.terminate(); }
  }
  let failure; let sentence;
  const asr = new Transcriber((_, s) => sentence = s, message => failure = message, Socket);
  const pending = asr.start({ asrKey: 'test', workspace: 'test', silenceMs: 800 }, 48000);
  const socket = Socket.instance; socket.readyState = 1; socket.emit('open');
  asr.audio(new Uint8Array(100)); assert.equal(socket.sent.length, 1);
  socket.emit('message', JSON.stringify({ header: { task_id: asr.id, event: 'task-started' } })); await pending;
  asr.audio(new Uint8Array(100)); assert.equal(socket.sent.length, 2);
  socket.emit('message', JSON.stringify({ header: { task_id: asr.id, event: 'result-generated' }, payload: { output: { sentence: { text: 'test' } } } }));
  assert.equal(sentence.text, 'test');
  socket.bufferedAmount = 48000 * 5; asr.audio(new Uint8Array(100)); assert.match(failure, /积压/); assert.equal(asr.ready, false);
});
test('损坏配置可覆盖保存恢复；空白手动草稿被ASR复用；手动分题追句重置提交并保留编辑', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-recover-'));
  try {
    const crypto = { isEncryptionAvailable: () => true, encryptString: x => Buffer.from(`encrypted:${x}`), decryptString: b => { throw new Error('corrupt'); } };
    const store = new Config(directory, crypto);
    fs.writeFileSync(store.file, '{bad json');
    const recovered = store.save({ deepseekKey: 'new-key', top: true }, defaults);
    assert.equal(recovered.deepseekKey, 'new-key'); assert.equal(recovered.top, true);
  } finally { fs.rmSync(directory, { recursive: true }); }

  const state = new Questions();
  const draft = state.create('', 'manual');
  const reused = state.sentence('s1', { sentence_id: 1, text: '第一句', sentence_end: true }, false);
  assert.equal(reused.id, draft.id); assert.equal(reused.source, 'audio');
  assert.equal(state.items.length, 1);

  state.claim(reused);
  state.edit(reused.id, '改写第一句', 'zh');
  state.claim(reused);
  reused.status = 'done';
  const appended = state.sentence('s1', { sentence_id: 2, text: '补充第二句', sentence_end: true }, true);
  assert.equal(appended.id, reused.id);
  assert.equal(appended.text, '改写第一句 补充第二句');
  assert.equal(appended.submitted, false);
  assert.equal(appended.status, 'draft');
});
test('识别握手期间主动停止报取消而非异常断线', async () => {
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; }
    send() {}
    terminate() { this.readyState = 3; this.emit('close'); }
    close() { this.terminate(); }
  }
  let failure = '';
  const asr = new Transcriber(() => {}, message => { failure = message; }, Socket);
  const pending = asr.start({ asrKey: 'test', workspace: 'test', silenceMs: 800 }, 48000);
  asr.stop();
  await assert.rejects(pending, /已取消/);
  assert.equal(failure, '');
});
test('语音模型留空默认fun-asr-realtime，指定时按设置发送', async () => {
  class Socket extends EventEmitter {
    static instance;
    constructor() { super(); this.sent = []; this.readyState = 1; Socket.instance = this; }
    send(data) { this.sent.push(data); }
    terminate() { this.readyState = 3; }
    close() { this.terminate(); }
  }
  const asr = new Transcriber(() => {}, () => {}, Socket);
  const p1 = asr.start({ asrKey: 'k', workspace: 'w', silenceMs: 800, asrModel: '' }, 48000);
  Socket.instance.emit('open');
  Socket.instance.emit('message', JSON.stringify({ header: { task_id: asr.id, event: 'task-started' } }));
  await p1;
  assert.equal(JSON.parse(Socket.instance.sent[0]).payload.model, 'fun-asr-realtime');
  asr.stop();

  const p2 = asr.start({ asrKey: 'k', workspace: 'w', silenceMs: 800, asrModel: 'paraformer-realtime-v2' }, 48000);
  Socket.instance.emit('open');
  Socket.instance.emit('message', JSON.stringify({ header: { task_id: asr.id, event: 'task-started' } }));
  await p2;
  assert.equal(JSON.parse(Socket.instance.sent[0]).payload.model, 'paraformer-realtime-v2');
  asr.stop();
});
test('支持OpenAI兼容Base URL（含本地无密钥端点），默认DeepSeek才带thinking', async () => {
  assert.equal(endpointFor(''), 'https://api.deepseek.com/chat/completions');
  assert.equal(endpointFor('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(endpointFor('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1/chat/completions');

  let calledUrl, calledOptions;
  const fetcher = async (url, options) => {
    calledUrl = url; calledOptions = options;
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  };
  let output = '';
  await generate({ text: 'hello' }, { ...defaults, baseUrl: 'http://localhost:11434/v1', deepseekKey: '', model: 'qwen2.5' }, [], false, new AbortController().signal, c => output += c, fetcher);
  assert.equal(output, 'OK');
  assert.equal(calledUrl, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calledOptions.headers.Authorization, undefined);
  const body = JSON.parse(calledOptions.body);
  assert.equal(body.model, 'qwen2.5');
  assert.equal(body.thinking, undefined);
});
