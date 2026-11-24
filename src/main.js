const { app, BrowserWindow, ipcMain, session, desktopCapturer, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Questions, languageOf } = require('./state');
const { Config } = require('./config');
const { generate } = require('./answer');
const { Transcriber } = require('./asr');
const { PhoneAudio } = require('./phone-audio');
const { acquireSingleInstance } = require('./single-instance');
const smoke = process.argv.includes('--smoke');
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), 'interview-desk-smoke'));
let win, store, settings, autoTimer, active, configError = '';
const instance = acquireSingleInstance(app, () => win);
const questions = new Questions();
const page = pathToFileURL(path.join(__dirname, 'ui/index.html')).href;
const emit = (type, data = {}) => { if (win && !win.isDestroyed()) win.webContents.send('event', { type, ...data }); };
const phoneAudio = smoke ? {
  state: {phase:'idle',message:'手机音频未开启'}, snapshot(){return this.state;},
  async start(){this.state={phase:'running',message:'模拟手机音频已开启'};emit('phone-state',{state:this.state});return this.state;},
  stop(){this.state={phase:'idle',message:'模拟手机音频已停止'};emit('phone-state',{state:this.state});return this.state;}
} : new PhoneAudio(state => emit('phone-state', { state }));
const snapshot = () => emit('questions', { items: questions.snapshot(), current: questions.current?.id, canUndo: questions.deleted.length > 0 });
function clearAuto() { clearTimeout(autoTimer); autoTimer = null; }
function cancel() {
  if (!active) return;
  active.controller.abort(); active.q.status = 'interrupted'; active.q.submitted = false; active = null; snapshot();
}
async function answer(q, force = false, expanded = false) {
  clearAuto();
  if (!settings.deepseekKey && !settings.baseUrl?.trim() && !smoke) throw new Error('请先在设置中填写 API Key（或配置本地兼容接口地址）');
  if (!questions.claim(q, force)) return;
  cancel(); q.status = 'generating'; q.answer = ''; q.startedAt = Date.now(); q.firstMs = null;
  const measureFrom = force || q.edited ? q.startedAt : (q.endedAt || q.startedAt);
  const request = { controller: new AbortController(), q, revision: q.revision }; active = request; snapshot();
  const timeout = setTimeout(() => { request.timeout = true; request.controller.abort(); }, 60000);
  try {
    const provider = smoke ? async (question, _settings, _history, _expanded, _signal, onChunk) => {
      // Deliberately ignore abort to verify that late provider data cannot replace a new question.
      await new Promise(resolve => setTimeout(resolve, question.text === 'old question' ? 150 : 30));
      onChunk(languageOf(question.text, question.language) === 'en'
        ? `【英文原题】\n${question.text}\n【题目中文译文】\n请介绍你的STM32项目。\n【English answer】\nEN: I built an STM32 temperature-controlled fan.\nZH: 我做过一个STM32温控风扇项目。\nEN: It includes data acquisition and control.\nZH: 它包含数据采集与控制功能。`
        : `测试参考：${question.text}`);
    } : generate;
    await provider(q, settings, questions.items, expanded, request.controller.signal, chunk => {
      if (active !== request) return;
      q.answer += chunk;
      // Translation is not counted as a usable English answer.
      const english = q.answer.indexOf('【English answer】');
      const englishText = english >= 0 ? q.answer.slice(english + 16).split('\n').filter(line => line.startsWith('EN:')).map(line => line.slice(3)).join(' ') : '';
      if (!q.firstMs && (languageOf(q.text, q.language) === 'zh' ? q.answer.trim().length >= 30 : englishText.trim().length >= 50)) {
        q.firstMs = Date.now() - measureFrom;
      }
      emit('chunk', { id: q.id, answer: q.answer, firstMs: q.firstMs });
    });
    if (active === request) { if (!q.answer.trim()) throw new Error('服务未返回可显示的答案'); q.status = 'done'; }
  } catch (error) {
    if (active !== request) return;
    q.status = 'interrupted';
    q.submitted = false;
    q.error = request.timeout ? '回答超时，已保留生成内容，请重试' : request.controller.signal.aborted ? '生成已停止' : error instanceof TypeError ? '回答服务网络连接失败，请检查接口地址与网络后重试' : error.message;
    emit('notice', { message: q.error, error: true });
  } finally {
    clearTimeout(timeout);
    if (active === request) { active = null; snapshot(); }
  }
}
const asr = new Transcriber((id, sentence) => {
  const q = questions.sentence(id, sentence, settings.manualQuestions);
  if (!q) return;
  clearAuto(); snapshot();
  if (q.final && !q.submitted && settings.auto) autoTimer = setTimeout(() => {
    answer(q).catch(e => emit('notice', { message: e.message, error: true }));
  }, settings.mergeMs);
}, message => { clearAuto(); emit('asr-failed', { message }); });

function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('请求来源无效');
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, value) => {
    try { trusted(event); return { ok: true, value: await fn(value) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}
function stopAudio() { clearAuto(); asr.stop(); }
if (instance.acquired) app.whenReady().then(async () => {
  store = new Config(app.getPath('userData'), safeStorage);
  try { settings = store.load(); } catch { settings = { ...require('./config').defaults, deepseekKey: '', asrKey: '' }; configError = '原配置无法读取或解密，请重新填写设置后保存'; }
  win = new BrowserWindow({ width: 1160, height: 880, minWidth: 760, minHeight: 600, backgroundColor: settings.theme === 'dark' ? '#111816' : '#f4f6f2', title: 'Interview Desk · 面试参考', show: !smoke, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !smoke } });
  win.setAlwaysOnTop(!!settings.top);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => { stopAudio(); cancel(); phoneAudio.stop(); });
  const allowedPermission = (contents, permission) => contents === win.webContents && contents.getURL() === page && ['media', 'display-capture'].includes(permission);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowedPermission(contents, permission)));
  session.defaultSession.setPermissionCheckHandler(allowedPermission);
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let grant = {};
    try {
      if (request.frame === win.webContents.mainFrame && request.frame.url === page && process.platform === 'win32') {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        if (sources.length) grant = { video: sources[0], audio: 'loopback' };
      }
    } catch { /* Empty grant denies the request. */ }
    callback(grant);
  });
  handle('initial', () => ({ settings: store.public(settings), configError, items: questions.snapshot(), phoneAudio: phoneAudio.snapshot() }));
  handle('phone-start', () => phoneAudio.start());
  handle('phone-stop', () => phoneAudio.stop());
  handle('settings-read', () => {
    try { settings = store.load(); configError = ''; }
    catch { configError = '原配置无法读取或解密，请重新填写设置后保存'; }
    win.setAlwaysOnTop(!!settings.top);
    win.setBackgroundColor(settings.theme === 'dark' ? '#111816' : '#f4f6f2');
    if (!settings.auto) clearAuto();
    return store.public(settings);
  });
  handle('save', value => {
    settings = store.save(value, settings); win.setAlwaysOnTop(!!settings.top);
    win.setBackgroundColor(settings.theme === 'dark' ? '#111816' : '#f4f6f2');
    if (!settings.auto) clearAuto(); return store.public(settings);
  });
  handle('answer', value => {
    if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20000 || !['auto', 'zh', 'en'].includes(value.language)) throw new Error('请输入有效问题（最多两万字）');
    const q = questions.edit(value.id, value.text.trim(), value.language);
    // Schedule the network call independently so the UI can cancel it immediately.
    answer(q, !!value.force, !!value.expanded).catch(e => emit('notice', { message: e.message, error: true }));
    return q.id;
  });
  handle('merge', value => {
    if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20000 || !['auto', 'zh', 'en'].includes(value.language)) throw new Error('请先选择有效问题');
    const index = questions.items.findIndex(q => q.id === value.id);
    if (index < 1) throw new Error('没有可合并的上一题');
    questions.edit(value.id, value.text.trim(), value.language);
    const q = questions.merge(value.id); clearAuto(); cancel(); snapshot();
    if (value.answerNow) answer(q).catch(e => emit('notice', { message: `合并已完成：${e.message}`, error: true }));
    return q.id;
  });
  handle('delete', id => {
    if (!questions.items.some(q => q.id === id)) throw new Error('请先选择要删除的问题');
    clearAuto(); if (active?.q.id === id) cancel();
    questions.remove(id); snapshot();
  });
  handle('undo-delete', () => { clearAuto(); questions.undo(); snapshot(); });
  handle('select', id => { clearAuto(); const q = questions.items.find(q => q.id === id); if (q) questions.current = q; snapshot(); });
  handle('new', () => { clearAuto(); questions.create('', settings.manualQuestions && asr.ready ? 'audio' : 'manual'); snapshot(); });
  handle('cancel', () => { clearAuto(); cancel(); });
  handle('asr-start', rate => asr.start(settings, rate));
  handle('asr-stop', () => stopAudio());
  ipcMain.on('audio', (event, bytes) => { try { trusted(event); if (bytes instanceof Uint8Array) asr.audio(bytes); } catch { /* Invalid untrusted frame data ignored. */ } });
  handle('export', async () => {
    const result = await dialog.showSaveDialog(win, { defaultPath: '面试参考记录.txt', filters: [{ name: '文本', extensions: ['txt'] }] });
    if (!result.canceled) fs.writeFileSync(result.filePath, questions.items.map(q => `问题：${q.text}\n状态：${q.status}\n参考答案（非用户真实发言）：\n${q.answer}\n`).join('\n----------------\n'), 'utf8');
    return !result.canceled;
  });
  win.on('closed', () => { stopAudio(); cancel(); phoneAudio.stop(); win = null; });
  await win.loadFile(path.join(__dirname, 'ui/index.html'));
  instance.ready();
  if (smoke) {
    try {
      await require('./smoke').runSmoke({ app, BrowserWindow, win, settings, instance });
    } catch (e) { console.error(e.message || e); app.exit(1); }
  }
}).catch(e => { console.error('应用启动失败:', e.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
if (instance.acquired) app.on('will-quit', () => { stopAudio(); cancel(); phoneAudio.stop(); });
