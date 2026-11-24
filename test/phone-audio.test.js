const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PhoneAudio } = require('../src/phone-audio');
function fixture(run) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kills = 0; child.kill = () => { child.kills++; child.emit('close', null); };
  let spawns = 0, args;
  const states = [];
  const phone = new PhoneAudio(s => states.push(s.phase), {
    find: () => ({ executable: 'scrcpy.exe', adb: 'adb.exe' }), delay: 5,
    run: run || (async (_exe, args) => ({ stdout: args.includes('get-state') ? 'device\n' : '35\n' })),
    spawn: (_exe, value, options) => { spawns++; args = value; assert.equal(options.windowsHide, true); return child; }
  });
  return { phone, child, states, get spawns() { return spawns; }, get args() { return args; } };
}
test('手机音频启停与重复点击：只启动一个无画面转发进程', async () => {
  const f = fixture();
  const start = f.phone.start(); await f.phone.start();
  assert.equal((await start).phase, 'running'); assert.equal(f.spawns, 1);
  assert.ok(f.args.includes('--no-video')); assert.ok(f.args.includes('--no-control'));
  assert.ok(f.args.includes('--require-audio')); assert.ok(f.args.includes('--audio-source=output'));
  await f.phone.start(); assert.equal(f.spawns, 1);
  f.phone.stop(); assert.equal(f.phone.snapshot().phase, 'idle'); assert.equal(f.child.kills, 1);
  f.phone.stop(); assert.equal(f.child.kills, 1);
});
test('USB未授权给出明确提示且不启动转发', async () => {
  const f = fixture(async () => { const e = new Error('ADB failed'); e.stderr = 'error: device unauthorized'; throw e; });
  const state = await f.phone.start(); assert.equal(state.phase, 'error'); assert.match(state.message, /允许 USB 调试/); assert.equal(f.spawns, 0);
});
test('未连接、SDK过低和未安装能恢复重试', async () => {
  const missing = fixture(async () => { throw new Error('no devices/emulators found'); });
  assert.match((await missing.phone.start()).message, /未连接可用手机/);
  const old = fixture(async (_exe,args) => ({ stdout: args.includes('get-state') ? 'device' : '29' }));
  assert.match((await old.phone.start()).message, /Android 11/); assert.equal(old.spawns, 0);
  old.phone.find = () => { throw new Error('未找到 scrcpy 或 ADB'); };
  assert.match((await old.phone.start()).message, /未找到 scrcpy/);
});
test('检查手机期间取消，迟到检查结果不会启动进程', async () => {
  let complete;
  const f = fixture(() => new Promise(resolve => { complete = resolve; }));
  const start = f.phone.start(); f.phone.stop(); complete({ stdout: 'device' });
  assert.equal((await start).phase, 'idle'); assert.equal(f.spawns, 0);
});
test('运行中断开连接更新错误状态，主动停止不会变错误', async () => {
  const f = fixture(); await f.phone.start();
  f.child.stderr.emit('data', Buffer.from('Device disconnected')); f.child.emit('close', 1);
  assert.equal(f.phone.snapshot().phase, 'error'); assert.match(f.phone.snapshot().message, /连接已断开/);
  f.phone.stop(); assert.equal(f.phone.snapshot().phase, 'idle');
});
test('可执行文件启动失败以及启动初期退出不会误报运行', async () => {
  const f = fixture(); f.phone.spawn = () => { queueMicrotask(() => f.child.emit('error', new Error('spawn ENOENT'))); return f.child; };
  assert.equal((await f.phone.start()).phase, 'error');
  const early = fixture(); early.phone.spawn = () => { queueMicrotask(() => { early.child.stderr.emit('data','Audio encoder failed'); early.child.emit('close',1); }); return early.child; };
  assert.match((await early.phone.start()).message, /音频转发失败/);
});
