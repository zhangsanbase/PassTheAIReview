const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

function findTools(env = process.env) {
  const directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (env.LOCALAPPDATA) {
    directories.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    const packages = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(packages)) {
      for (const name of fs.readdirSync(packages).filter(x => x.startsWith('Genymobile.scrcpy_'))) {
        const base = path.join(packages, name); directories.push(base);
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith('scrcpy-')) directories.push(path.join(base, entry.name));
      }
    }
  }
  const find = name => directories.map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
  const executable = find('scrcpy.exe');
  const sibling = executable && path.join(path.dirname(fs.realpathSync(executable)), 'adb.exe');
  const adb = sibling && fs.existsSync(sibling) ? sibling : find('adb.exe');
  if (!executable || !adb) throw new Error('未找到 scrcpy 或 ADB。请先安装：winget install --exact Genymobile.scrcpy，然后重试。');
  return { executable, adb };
}
function explain(error) {
  const text = `${error?.message || ''} ${error?.stderr || ''}`;
  if (/unauthorized|authentication|authorize/i.test(text)) return '手机尚未授权。请解锁手机，在“允许 USB 调试”弹窗中点击允许后重试。';
  if (/more than one|multiple.*device/i.test(text)) return '检测到多台 USB 调试设备，请只保留需要转发的手机后重试。';
  if (/no devices|no device|device not found|offline|device disconnected|disconnected|device.*closed/i.test(text)) return '未连接可用手机或连接已断开。请检查数据线、USB 调试及手机授权后重新开启。';
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return '手机连接检查超时，请保持手机解锁并检查数据线后重试。';
  if (/audio|encoder|codec/i.test(text)) return '手机音频转发失败，请检查手机系统和应用是否支持音频采集，以及电脑播放设备是否可用。';
  return '手机音频转发未能启动或已异常退出。请检查 USB 连接、手机调试授权和电脑播放设备后重试。';
}

class PhoneAudio {
  constructor(onChange = () => {}, deps = {}) {
    this.onChange = onChange;
    this.find = deps.find || findTools;
    this.run = deps.run || promisify(execFile);
    this.spawn = deps.spawn || spawn;
    this.delay = deps.delay ?? 1500;
    this.child = null; this.epoch = 0;
    this.state = { phase: 'idle', message: '手机音频未开启' };
  }
  snapshot() { return { ...this.state }; }
  update(phase, message) { this.state = { phase, message }; this.onChange(this.snapshot()); }
  async start() {
    if (this.child || ['checking', 'starting'].includes(this.state.phase)) return this.snapshot();
    const epoch = ++this.epoch;
    this.update('checking', '正在检查手机连接与调试授权…');
    try {
      const tools = this.find();
      const options = { windowsHide: true, timeout: 10000, maxBuffer: 65536 };
      const device = await this.run(tools.adb, ['-d', 'get-state'], options);
      if (epoch !== this.epoch) return this.snapshot();
      if (device.stdout.trim() !== 'device') throw new Error('no device');
      const version = await this.run(tools.adb, ['-d', 'shell', 'getprop', 'ro.build.version.sdk'], options);
      if (epoch !== this.epoch) return this.snapshot();
      const sdk = Number(version.stdout.trim());
      if (!Number.isFinite(sdk) || sdk < 30) throw new Error('ANDROID_VERSION_UNSUPPORTED');
      this.update('starting', '正在启动手机音频转发…');
      const child = this.spawn(tools.executable, ['--select-usb', '--no-video', '--no-control', '--require-audio', '--audio-source=output'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let logs = '';
      const append = chunk => { logs = (logs + chunk.toString()).slice(-8192); };
      child.stdout?.on('data', append); child.stderr?.on('data', append);
      await new Promise((resolve, reject) => {
        let launched = false;
        const timer = setTimeout(() => {
          if (epoch !== this.epoch || this.child !== child) { resolve(); return; }
          launched = true;
          this.update('running', '手机音频转发进程已启动。请用手机播放声音测试，耳机接电脑；软件选择“系统声音”并点击“开始监听”。');
          resolve();
        }, this.delay);
        const ended = error => {
          clearTimeout(timer);
          if (epoch !== this.epoch || this.child !== child) { resolve(); return; }
          this.child = null;
          const message = explain({ message: `${error?.message || 'device disconnected'} ${logs}` });
          if (!launched) reject(new Error(message));
          else this.update('error', message);
        };
        child.once('error', ended);
        child.once('close', code => ended(new Error(code === 0 ? 'device disconnected' : `scrcpy exited ${code}`)));
      });
    } catch (error) {
      if (epoch !== this.epoch) return this.snapshot();
      const child = this.child; this.child = null; child?.kill();
      this.update('error', error.message === 'ANDROID_VERSION_UNSUPPORTED' ? '手机音频转发需要 Android 11 或以上版本，请检查系统版本。'
        : /未找到 scrcpy|手机音频转发失败|尚未授权|未连接可用|多台 USB|检查超时/.test(error.message) ? error.message : explain(error));
    }
    return this.snapshot();
  }
  stop() {
    this.epoch++;
    const child = this.child; this.child = null;
    if (child) child.kill();
    this.update('idle', '手机音频转发已停止；电脑语音监听由“开始监听／暂停监听”单独控制。');
    return this.snapshot();
  }
}
module.exports = { PhoneAudio, findTools, explain };
