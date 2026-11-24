const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

async function runSmoke({ app, BrowserWindow, win, settings, instance }) {
  const watchdog = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 45000);
  watchdog.unref();
  let singleInstance;
  if (process.argv.includes('--instance-smoke')) {
    const before = instance.repeatCount;
    const secondary = spawn(process.execPath, [app.getAppPath(), '--smoke', '--secondary-smoke'], { windowsHide: true, stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { secondary.kill(); reject(new Error('Second instance did not exit')); }, 10000);
      secondary.once('error', e => { clearTimeout(timer); reject(e); });
      secondary.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    singleInstance = code === 0 && instance.repeatCount === before + 1 && BrowserWindow.getAllWindows().length === 1;
    if (!singleInstance) throw new Error('Single-instance check failed');
  }
  let localMeterIndependent = true;
  let microphoneResult;
  if (process.argv.includes('--microphone-smoke')) {
    settings.asrKey = ''; settings.workspace = '';
    microphoneResult = await win.webContents.executeJavaScript(`(async () => {
      applySettings((await window.desk.initial()).value.settings);
      document.querySelector('#audio-source').value = 'microphone';
      await document.querySelector('#audio-source').onchange();
      const originalDisplay = navigator.mediaDevices.getDisplayMedia;
      let displayCalls = 0;
      navigator.mediaDevices.getDisplayMedia = () => { displayCalls++; throw new Error('Microphone must not capture screen'); };
      try {
        await toggleAudio();
        if (!audio?.worklet) throw new Error(document.querySelector('#notice').textContent);
        const resource = audio; let frames = 0, bytes = 0;
        const handler = resource.worklet.port.onmessage;
        resource.worklet.port.onmessage = event => { frames++; bytes = event.data.pcm.byteLength; handler(event); };
        await new Promise(resolve => setTimeout(resolve, 250));
        const result = {audioOnly:resource.stream.getVideoTracks().length === 0,localOnly:document.querySelector('#connection').textContent === '仅本地音量检测',pcm:frames > 0 && bytes > 0,noScreenCapture:displayCalls === 0};
        const saved = await window.desk.initial(); result.sourceSaved = saved.value.settings.audioSource === 'microphone';
        document.querySelector('#audio-source').value = 'system';
        await document.querySelector('#audio-source').onchange();
        result.switchReleasesCapture = resource.stream.getTracks().every(t => t.readyState === 'ended') && resource.context.state === 'closed' && audio === null;
        // Verify OS permission failures leave the UI recoverable without starting ASR.
        const originalMic = navigator.mediaDevices.getUserMedia;
        try {
          document.querySelector('#audio-source').value = 'microphone';
          navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied','NotAllowedError'); };
          await toggleAudio(); result.deniedRecoverable = audio === null && !starting && document.querySelector('#notice').textContent.includes('麦克风访问被拒绝');
        } finally { navigator.mediaDevices.getUserMedia = originalMic; document.querySelector('#audio-source').value = 'system'; }
        return result;
      } finally { navigator.mediaDevices.getDisplayMedia = originalDisplay; await stopAudio(); }
    })()`, true);
    console.log('Microphone capture:', JSON.stringify(microphoneResult));
    if (!Object.values(microphoneResult).every(Boolean)) throw new Error('Microphone smoke check failed');
  }
  if (process.argv.includes('--capture-smoke')) {
    const capture = await win.webContents.executeJavaScript(`(async () => {
      let stream;
      try { stream = await navigator.mediaDevices.getDisplayMedia({video:true,audio:true}); }
      catch(e) { return {error:e.name + ': ' + e.message}; }
      const context = new AudioContext();
      try {
        await context.audioWorklet.addModule('pcm-worklet.js');
        const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const node = new AudioWorkletNode(context,'pcm-capture');
        const frame = new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('PCM worklet did not emit audio')),3000);
          node.port.onmessage=e=>{clearTimeout(timer);resolve(e.data.pcm.byteLength);};
        });
        source.connect(node);node.connect(context.destination);await context.resume();
        const pcmBytes=await frame;node.disconnect();source.disconnect();
        return {audioTracks:stream.getAudioTracks().length,videoTracks:stream.getVideoTracks().length,sampleRate:context.sampleRate,pcmBytes};
      }
      finally { stream.getTracks().forEach(t=>t.stop());await context.close(); }
    })()`, true);
    console.log('Native loopback capture:', JSON.stringify(capture));
    if (!capture.audioTracks) throw new Error('Native audio capture returned no audio track');
    settings.asrKey = ''; settings.workspace = '';
    const metering = await win.webContents.executeJavaScript(`(async () => {
      const initial = await window.desk.initial(); applySettings(initial.value.settings);
      await toggleAudio();
      try {
        await new Promise(resolve=>setTimeout(resolve,200));
        return {localOnly:document.querySelector('#connection').textContent === '仅本地音量检测',running:audio?.context?.state === 'running',worklet:!!audio?.worklet};
      } finally {await stopAudio();}
    })()`, true);
    localMeterIndependent = Object.values(metering).every(Boolean);
    console.log('Meter without API configuration:', JSON.stringify(metering));
    if (!localMeterIndependent) throw new Error('Local metering requires ASR unexpectedly');
  }
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const state = await window.desk.initial();
    await document.querySelector('#phone-audio').onclick();
    const phoneOn = document.querySelector('#phone-audio').getAttribute('aria-pressed') === 'true';
    await document.querySelector('#phone-audio').onclick();
    const phoneToggle = phoneOn && document.querySelector('#phone-audio').getAttribute('aria-pressed') === 'false';
    await document.querySelector('#settings-open').onclick();
    const settingsOpen = document.querySelector('#settings-dialog').open && !!document.querySelector('#asrModel') && !!document.querySelector('#baseUrl');
    document.querySelector('#settings-dialog').close();
    await document.querySelector('#theme-toggle').onclick();
    const darkOn = document.documentElement.dataset.theme === 'dark' && (await window.desk.initial()).value.settings.theme === 'dark';
    await document.querySelector('#theme-toggle').onclick();
    const themeToggle = darkOn && document.documentElement.dataset.theme === 'light';
    await window.desk.answer({text:'old question',language:'en'});
    await wait(10);
    await window.desk.answer({text:'新的问题',language:'zh'});
    await wait(400);
    const after = await window.desk.initial();
    const old = after.value.items.find(x => x.text === 'old question');
    const latest = after.value.items.find(x => x.text === '新的问题');
    const isolated = old.status === 'interrupted' && !old.answer && latest.status === 'done' && latest.answer === '测试参考：新的问题';
    // Verify cancelling an answer still lets the user retry directly with "立即回答".
    await window.desk.select(old.id); await wait(20);
    document.querySelector('#answer').click(); await wait(200);
    const retried = (await window.desk.initial()).value.items.find(x => x.id === old.id);
    const retryAfterInterrupt = retried.status === 'done' && retried.answer.includes('old question');
    // Verify clicking "立即回答" on a completed question regenerates directly.
    await window.desk.select(latest.id); await wait(20);
    document.querySelector('#answer').click(); await wait(120);
    const regenerated = (await window.desk.initial()).value.items.find(x => x.id === latest.id).status === 'done';
    // Verify clicking "新问题" creates an empty editable draft and focuses it.
    document.querySelector('#new-question').click(); await wait(40);
    const questionBox = document.querySelector('#question');
    const fresh = questionBox.value === '' && !questionBox.readOnly && document.activeElement === questionBox;
    document.querySelector('#question').value = '请介绍一下你自己，以及你做过的项目。';
    await window.desk.answer({text:document.querySelector('#question').value,language:'zh'}); await wait(100);
    document.querySelector('#question').value += ' 请说明你的收获。';
    await mergeQuestion(true); await wait(120);
    let list = (await window.desk.initial()).value.items;
    const combined = list.at(-1);
    const mergeAndAnswer = combined.text.includes('请说明你的收获。') && combined.status === 'done';
    await window.desk.deleteQuestion(combined.id); await wait(20);
    list = (await window.desk.initial()).value.items;
    const deleted = !list.some(q => q.id === combined.id);
    await window.desk.undoDelete(); await wait(20);
    const restored = (await window.desk.initial()).value.items.some(q => q.id === combined.id);
    // Deleting an active generation must reject its intentionally late mock chunk.
    const running = await window.desk.answer({text:'old question',language:'en'});
    await window.desk.deleteQuestion(running.value); await wait(180);
    list = (await window.desk.initial()).value.items;
    const deletedGeneration = !list.some(q => q.id === running.value);
    for (const q of list) await window.desk.deleteQuestion(q.id);
    await wait(30);
    const emptyState = document.querySelector('#question').value === '' && !document.querySelector('.history-select');
    await window.desk.answer({text:'Tell me about your STM32 project.',language:'en'}); await wait(120);
    const responseText = document.querySelector('#response').textContent;
    const bilingual = document.querySelectorAll('.answer-english').length === 2 && document.querySelectorAll('.answer-translation').length === 2 && responseText.includes('题目中文译文') && !responseText.includes('正在组织参考回答');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { title: document.title, bridge: state.ok, settingsOpen, themeToggle, controls: !!document.querySelector('#listen'), cancellationIsolation: isolated, retryAfterInterrupt, regenerated, newQuestion: fresh, mergeAndAnswer, deleteAndUndo:deleted && restored, deletedGeneration, emptyState, bilingual, phoneToggle };
  })()`);
  result.localMeterIndependent = localMeterIndependent;
  if (singleInstance !== undefined) result.singleInstance = singleInstance;
  if (microphoneResult) result.microphone = Object.values(microphoneResult).every(Boolean);
  fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
  await win.webContents.executeJavaScript(`document.querySelector('#settings-dialog').close()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(__dirname, '../artifacts/smoke.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('#theme-toggle').click()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(__dirname, '../artifacts/smoke-dark.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('#theme-toggle').click()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  if (process.argv.includes('--layout-smoke')) {
    const layouts = [];
    for (const [width, height] of [[1160, 820], [980, 680], [760, 600]]) {
      win.setContentSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 150));
      const layout = await win.webContents.executeJavaScript(`(() => {
        const box=id=>{const r=document.querySelector(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
        const input=box('#question'),output=box('#response');
        const buttons=['#listen','#phone-audio','#theme-toggle','#settings-open','#audio-source','#new-question','#answer','#merge-answer','#undo-delete','#export','#expand','#stop-answer'];
        return {width:innerWidth,height:innerHeight,input,output,noPageOverflow:document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight,
          actionsVisible:buttons.every(id=>{const r=box(id);return r.width>0 && r.x>=0 && r.y>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;}),inputUsable:input.height>=55,outputUsable:output.height>=100};
      })()`);
      layouts.push(layout);
      fs.writeFileSync(path.join(__dirname, `../artifacts/layout-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(path.join(__dirname, '../artifacts/layout.json'), JSON.stringify(layouts, null, 2));
    result.layout = layouts.every(x => x.noPageOverflow && x.actionsVisible && x.inputUsable && x.outputUsable);
    console.log('Layout:', JSON.stringify(layouts));
  }
  fs.writeFileSync(path.join(__dirname, '../artifacts/smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(Object.values(result).every(Boolean) ? 0 : 1);
}

module.exports = { runSmoke };
