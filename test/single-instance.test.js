const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { acquireSingleInstance } = require('../src/single-instance');
function fixture(acquired) {
  const app = new EventEmitter(); let quits = 0;
  app.requestSingleInstanceLock = () => acquired; app.quit = () => quits++;
  const calls = [];
  const window = { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
  return { app, window, calls, get quits() { return quits; } };
}
test('重复实例立即正常退出，不安装启动事件', () => {
  const f = fixture(false); const gate = acquireSingleInstance(f.app, () => f.window);
  assert.equal(gate.acquired, false); assert.equal(f.quits, 1); assert.equal(f.app.listenerCount('second-instance'), 0);
});
test('重复启动恢复最小化窗口并显示聚焦', () => {
  const f = fixture(true); const gate = acquireSingleInstance(f.app, () => f.window);
  f.app.emit('second-instance'); assert.deepEqual(f.calls, ['restore','show','focus']);
  assert.equal(gate.repeatCount, 1); assert.equal(f.quits, 0);
  gate.ready(); assert.equal(f.calls.length, 3);
});
test('主窗口尚未创建时记住聚焦请求，加载完成后执行', () => {
  const f = fixture(true); let window;
  const gate = acquireSingleInstance(f.app, () => window);
  f.app.emit('second-instance'); assert.equal(f.calls.length, 0);
  window = f.window; gate.ready(); assert.deepEqual(f.calls, ['restore','show','focus']);
});
test('非最小化窗口不调用restore，销毁窗口不操作', () => {
  const f = fixture(true); f.window.isMinimized = () => false;
  acquireSingleInstance(f.app, () => f.window); f.app.emit('second-instance');
  assert.deepEqual(f.calls, ['show','focus']);
  f.window.isDestroyed = () => true; f.app.emit('second-instance'); assert.equal(f.calls.length, 2);
});
