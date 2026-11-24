const $ = id => document.getElementById(id);
let config = {}, items = [], currentId = null, audio = null, starting = false, audioEpoch = 0, dirty = false;
let phoneState = { phase: 'idle' };
function showPhoneState(state, announce = true) {
  phoneState = state;
  const active = ['checking', 'starting', 'running'].includes(state.phase);
  const button = $('phone-audio');
  button.textContent = state.phase === 'running' ? '手机音频 · 停止' : ['checking','starting'].includes(state.phase) ? '手机连接中 · 取消' : '手机音频 · 开启';
  button.setAttribute('aria-pressed', String(active)); button.dataset.phase = state.phase;
  if (state.message) {
    button.title = state.message;
    if (announce && state.phase === 'error') notice(state.message, true);
  }
}
const statusNames = { draft: '', generating: '正在生成…', done: '', interrupted: '已中断' };
let noticeTimer = null;
function notice(message = '', error = false) {
  clearTimeout(noticeTimer); noticeTimer = null;
  $('notice').textContent = message; $('notice').classList.toggle('error', error);
  if (message && !error) noticeTimer = setTimeout(() => { $('notice').textContent = ''; $('notice').classList.remove('error'); }, 2200);
}
async function call(promise) { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; }
function safe(action) { return async (...args) => { try { await action(...args); } catch (e) { notice(e.message, true); } }; }
function showAnswer(text) {
  const container = $('response');
  const scrollTop = container.scrollTop;
  // Clear text-node placeholders (e.g. "正在组织参考回答…") before diffing element blocks.
  if (!container.children.length && container.childNodes.length) container.textContent = '';
  const descriptors = [];
  for (const block of AnswerView.blocks(text)) {
    descriptors.push({ tag: block.kind === 'heading' ? 'H3' : 'P', className: `answer-${block.kind}`, text: block.text });
    if (block.tail) descriptors.push({ tag: 'P', className: '', text: block.tail });
  }
  const existing = container.children;
  let samePrefix = 0;
  while (
    samePrefix < descriptors.length &&
    samePrefix < existing.length &&
    existing[samePrefix].tagName === descriptors[samePrefix].tag &&
    existing[samePrefix].className === descriptors[samePrefix].className &&
    existing[samePrefix].textContent === descriptors[samePrefix].text
  ) {
    samePrefix++;
  }
  while (existing.length > descriptors.length) container.lastElementChild.remove();
  for (let i = samePrefix; i < descriptors.length; i++) {
    const desc = descriptors[i];
    const current = existing[i];
    if (current && current.tagName === desc.tag && current.className === desc.className) {
      current.textContent = desc.text;
    } else {
      const element = document.createElement(desc.tag.toLowerCase());
      if (desc.className) element.className = desc.className;
      element.textContent = desc.text;
      if (current) container.replaceChild(element, current);
      else container.append(element);
    }
  }
  container.scrollTop = scrollTop;
}
function applyTheme(theme) {
  const mode = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode;
  const button = $('theme-toggle');
  button.textContent = mode === 'dark' ? '☀ 浅色' : '🌙 深色';
  button.setAttribute('aria-pressed', String(mode === 'dark'));
}
function applySettings(s) {
  config = s; $('auto').checked = !!s.auto; $('manual-questions').checked = !!s.manualQuestions; $('top').checked = !!s.top; $('font-size').value = String(s.fontSize);
  $('audio-source').value = s.audioSource || 'system';
  applyTheme(s.theme);
  document.documentElement.style.setProperty('--font', `${s.fontSize}px`);
  for (const key of ['model', 'baseUrl', 'asrModel', 'region', 'workspace', 'silenceMs', 'mergeMs', 'profile', 'role']) $(key).value = s[key] ?? '';
  for (const key of ['deepseekKey', 'asrKey']) { $(key).value = ''; $(key).placeholder = s[key === 'deepseekKey' ? 'hasDeepseekKey' : 'hasAsrKey'] ? '已加密保存；留空保留，填写替换' : '尚未配置'; $(`clear_${key}`).checked = false; }
}
function renderQuestions(data) {
  const previousId = currentId; items = data.items; currentId = data.current || null;
  const q = items.find(x => x.id === currentId);
  $('count').textContent = String(items.length).padStart(2, '0');
  $('undo-delete').disabled = !data.canUndo;
  const canMerge = q && items.findIndex(x => x.id === q.id) > 0;
  $('merge-answer').disabled = !canMerge;
  $('stop-answer').disabled = q?.status !== 'generating';
  if (items.length) {
    $('history').replaceChildren(...items.map((q, i) => {
      const row = document.createElement('div'); row.className = 'history-row';
      const button = document.createElement('button'); button.className = 'history-select'; button.textContent = `${String(i + 1).padStart(2, '0')}  ${q.text || '新问题'}`;
      button.title = q.text; button.classList.toggle('selected', q.id === currentId);
      button.onclick = safe(async () => { dirty = false; await call(window.desk.select(q.id)); });
      const remove = document.createElement('button'); remove.className = 'history-delete'; remove.textContent = '×';
      remove.title = '删除此题（可撤销）'; remove.setAttribute('aria-label', `删除问题 ${i + 1}`);
      remove.onclick = safe(() => deleteQuestion(q.id)); row.append(button, remove); return row;
    }));
  } else { const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = '暂无问题'; $('history').replaceChildren(empty); }
  if (q) {
    if (!dirty || previousId !== currentId) { $('question').value = q.text; $('language').value = q.language; dirty = false; }
    $('question-state').textContent = q.source === 'audio' && !q.final ? '正在识别…' : '';
    $('answer-status').textContent = statusNames[q.status];
    if (q.answer) showAnswer(q.answer);
    else if (q.status === 'generating') $('response').textContent = '正在组织参考回答…';
    else $('response').textContent = '暂无参考答案';
    $('latency').textContent = q.firstMs ? `首段 ${(q.firstMs / 1000).toFixed(2)} s` : '';
  } else {
    $('question').value = ''; $('language').value = 'auto'; dirty = false;
    $('question-state').textContent = ''; $('answer-status').textContent = '';
    $('response').textContent = '暂无参考答案'; $('latency').textContent = '';
  }
}
async function deleteQuestion(id) {
  if (id === currentId) dirty = false;
  await call(window.desk.deleteQuestion(id)); notice('');
}
async function mergeQuestion(answerNow) {
  const text = $('question').value.trim(); if (!text) throw new Error('请先选择或输入问题');
  dirty = false;
  await call(window.desk.merge({ id: currentId, text, language: $('language').value, answerNow }));
  notice('');
}
async function submit(force = false, expanded = false) {
  const text = $('question').value.trim(); if (!text) throw new Error('请先输入问题或开始监听');
  const language = $('language').value; dirty = false;
  await call(window.desk.answer({ id: currentId, text, language, force, expanded }));
}
async function stopAudio(message = '') {
  audioEpoch++; starting = false;
  const resource = audio; audio = null;
  if (resource) {
    if (resource.worklet) { resource.worklet.port.onmessage = null; resource.worklet.disconnect(); }
    resource.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    if (resource.context && resource.context.state !== 'closed') await resource.context.close();
  }
  await call(window.desk.stopASR());
  $('listen').textContent = '▶ 开始监听'; $('connection').textContent = '未监听'; $('connection').classList.remove('live'); $('level').value = 0;
  notice(message);
}
async function toggleAudio() {
  if (audio || starting) return stopAudio();
  const epoch = ++audioEpoch; starting = true;
  const microphone = $('audio-source').value === 'microphone';
  $('listen').textContent = '■ 取消连接'; $('connection').textContent = '连接中';
  try {
    const stream = microphone
      ? await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (epoch !== audioEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
    audio = { stream, source: microphone ? 'microphone' : 'system' };
    if (!stream.getAudioTracks().length) throw new Error(microphone ? '未取得麦克风音频，请检查 Windows 默认输入设备' : '未取得系统音频，请确认默认播放设备可用');
    for (const track of stream.getTracks()) track.onended = () => safe(async () => { await stopAudio(); notice('设备或采集流已结束；转写存在缺口，请检查声音来源对应的设备后重新开始', true); })();
    const context = new AudioContext(); audio.context = context;
    await context.audioWorklet.addModule('pcm-worklet.js');
    if (epoch !== audioEpoch) return;
    const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const worklet = new AudioWorkletNode(context, 'pcm-capture'); audio.worklet = worklet;
    let transcribing = false;
    worklet.port.onmessage = event => { if (epoch === audioEpoch) {
      // Metering is local and must work even before ASR is configured or connected.
      $('level').value = Math.min(1, event.data.level * 4);
      if (transcribing) window.desk.audio(new Uint8Array(event.data.pcm));
    } };
    source.connect(worklet); worklet.connect(context.destination); await context.resume();
    if (epoch !== audioEpoch) return;
    if (!config.hasAsrKey || !config.workspace) {
      starting = false; $('listen').textContent = '■ 暂停检测'; $('connection').textContent = '仅本地音量检测'; $('connection').classList.add('live');
      notice('');
      return;
    }
    await call(window.desk.startASR(context.sampleRate));
    if (epoch !== audioEpoch) return;
    transcribing = true;
    starting = false; $('listen').textContent = '■ 暂停监听'; $('connection').textContent = '正在监听'; $('connection').classList.add('live');
    notice('');
  } catch (e) {
    if (epoch !== audioEpoch) return;
    await stopAudio('');
    const message = e.name === 'NotAllowedError' ? (microphone ? '麦克风访问被拒绝，请在 Windows 隐私设置中允许桌面应用访问麦克风后重试' : '音频采集未获授权，请点击开始监听重新尝试')
      : e.name === 'NotFoundError' ? '没有找到麦克风，请连接设备并在 Windows 中选择默认输入设备'
      : e.name === 'NotReadableError' ? '音频设备无法打开，请检查是否被独占或已断开后重试' : e.message;
    notice(message, true);
  }
}
// Output routing changes can invalidate the default loopback target: never silently continue.
navigator.mediaDevices.addEventListener('devicechange', () => { if (audio) safe(async () => { await stopAudio(); notice('音频设备发生变化，已暂停；请确认所选来源的默认播放或输入设备后重新开始', true); })(); });
window.desk.onEvent(data => {
  if (data.type === 'phone-state') showPhoneState(data.state);
  if (data.type === 'questions') renderQuestions(data);
  if (data.type === 'chunk') {
    const q = items.find(q => q.id === data.id); if (q) { q.answer = data.answer; q.firstMs = data.firstMs; }
    if (data.id === currentId) { showAnswer(data.answer); $('latency').textContent = data.firstMs ? `首段 ${(data.firstMs / 1000).toFixed(2)} s` : ''; }
  }
  if (data.type === 'notice') notice(data.message, data.error);
  if (data.type === 'asr-failed') safe(async () => { await stopAudio(''); notice(data.message, true); })();
});
$('listen').onclick = safe(toggleAudio);
$('phone-audio').onclick = safe(async () => {
  // Set the phase immediately so a second click cancels instead of starting twice.
  const stop = ['checking','starting','running'].includes(phoneState.phase);
  showPhoneState({ phase: stop ? 'idle' : 'checking', message: stop ? '正在停止手机音频…' : '正在检查手机连接…' });
  const state = await call(stop ? window.desk.phoneStop() : window.desk.phoneStart());
  showPhoneState(state);
});
$('audio-source').onchange = safe(async () => {
  const value = $('audio-source').value;
  if (audio || starting) await stopAudio('');
  try { applySettings(await call(window.desk.save({ audioSource: value }))); }
  catch (e) { $('audio-source').value = config.audioSource || 'system'; throw e; }
  notice('');
});
$('answer').onclick = safe(() => submit(true));
$('expand').onclick = safe(() => submit(true, true));
$('stop-answer').onclick = safe(() => call(window.desk.cancel()));
$('question').oninput = () => { dirty = true; };
$('language').onchange = () => { dirty = true; };
$('merge-answer').onclick = safe(() => mergeQuestion(true));
$('undo-delete').onclick = safe(async () => { dirty = false; await call(window.desk.undoDelete()); notice(''); });
$('new-question').onclick = safe(async () => { dirty = false; await call(window.desk.newQuestion()); $('question').focus(); });
$('export').onclick = safe(async () => { if (await call(window.desk.export())) notice('已导出'); });
$('theme-toggle').onclick = safe(async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  applySettings(await call(window.desk.save({ theme: next })));
});
$('settings-open').onclick = safe(async () => {
  applySettings(await call(window.desk.readSettings()));
  $('settings-error').textContent = '';
  $('settings-dialog').showModal();
});
$('settings-close').onclick = () => { applySettings(config); $('settings-dialog').close(); };
$('settings-dialog').addEventListener('cancel', () => applySettings(config));
$('settings-form').onsubmit = event => {
  event.preventDefault();
  (async () => {
    try {
      const input = {};
      for (const key of ['deepseekKey', 'asrKey', 'model', 'baseUrl', 'asrModel', 'workspace', 'region', 'silenceMs', 'mergeMs', 'profile', 'role']) input[key] = $(key).value;
      for (const key of ['clear_deepseekKey', 'clear_asrKey']) input[key] = $(key).checked;
      applySettings(await call(window.desk.save(input))); $('settings-error').textContent = ''; $('settings-dialog').close();
      notice('设置已保存');
    } catch (e) { $('settings-error').textContent = e.message; }
  })();
};
for (const key of ['auto', 'manual-questions', 'top', 'font-size']) $(key).onchange = safe(async () => {
  const input = key === 'font-size' ? { fontSize: Number($(key).value) } : key === 'manual-questions' ? { manualQuestions: $('manual-questions').checked } : { [key]: $(key).checked };
  applySettings(await call(window.desk.save(input)));
});
safe(async () => { const initial = await call(window.desk.initial()); applySettings(initial.settings); showPhoneState(initial.phoneAudio, false); if (initial.configError) notice(initial.configError, true); })();
