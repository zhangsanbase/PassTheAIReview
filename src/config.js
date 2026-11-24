const fs = require('node:fs');
const path = require('node:path');
const defaults = { model: 'deepseek-flash', baseUrl: '', asrModel: '', region: 'beijing', workspace: '', profile: '', role: '', silenceMs: 800, mergeMs: 200, auto: true, manualQuestions: false, fontSize: 19, top: false, audioSource: 'system', theme: 'light' };
class Config {
  constructor(directory, crypto) { this.file = path.join(directory, 'settings.json'); this.crypto = crypto; }
  load() {
    if (!fs.existsSync(this.file)) return { ...defaults, deepseekKey: '', asrKey: '' };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const result = { ...defaults, ...data };
    if (!['system', 'microphone'].includes(result.audioSource)) result.audioSource = 'system';
    if (!['light', 'dark'].includes(result.theme)) result.theme = 'light';
    if (typeof result.asrModel !== 'string') result.asrModel = '';
    if (typeof result.baseUrl !== 'string') result.baseUrl = '';
    for (const key of ['deepseekKey', 'asrKey']) result[key] = data[key] ? this.crypto.decryptString(Buffer.from(data[key], 'base64')) : '';
    return result;
  }
  public(settings) {
    const { deepseekKey, asrKey, ...data } = settings;
    return { ...data, hasDeepseekKey: !!deepseekKey, hasAsrKey: !!asrKey };
  }
  save(input, previous) {
    // Merge against disk too: a running window may predate an imported profile.
    let diskPrevious = {};
    if (fs.existsSync(this.file)) {
      try { diskPrevious = this.load(); } catch { /* Allow overwriting unreadable or undecryptable config. */ }
    }
    const data = { ...previous, ...diskPrevious };
    for (const key of Object.keys(defaults)) if (Object.hasOwn(input, key)) data[key] = input[key];
    for (const key of ['deepseekKey', 'asrKey']) {
      if (input[key]?.trim()) data[key] = input[key].trim();
      if (input[`clear_${key}`]) data[key] = '';
    }
    if (!['beijing', 'singapore'].includes(data.region)) throw new Error('地域无效');
    if (!['system', 'microphone'].includes(data.audioSource)) throw new Error('声音来源无效');
    if (!['light', 'dark'].includes(data.theme)) throw new Error('主题模式无效');
    if (typeof data.asrModel !== 'string' || data.asrModel.trim().length > 120) throw new Error('语音模型名称无效或过长');
    data.asrModel = data.asrModel.trim();
    if (typeof data.baseUrl !== 'string' || data.baseUrl.trim().length > 500) throw new Error('接口地址无效或过长');
    data.baseUrl = data.baseUrl.trim();
    if (data.baseUrl) {
      let parsed;
      try { parsed = new URL(data.baseUrl); } catch { throw new Error('接口地址格式无效，请填写 http:// 或 https:// 开头的地址'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('接口地址格式无效，仅支持 http:// 或 https://');
    }
    if (data.workspace && !/^[\w-]{1,120}$/.test(data.workspace)) throw new Error('业务空间 ID 格式无效');
    for (const key of ['model', 'workspace', 'profile', 'role']) if (typeof data[key] !== 'string' || data[key].length > 20000) throw new Error('设置内容无效或过长');
    for (const [key, min, max] of [['silenceMs', 200, 6000], ['mergeMs', 0, 2000], ['fontSize', 14, 32]]) {
      data[key] = Number(data[key]); if (!Number.isInteger(data[key]) || data[key] < min || data[key] > max) throw new Error(`${key} 超出允许范围`);
    }
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Windows 加密存储不可用，配置未保存');
    const disk = { ...data };
    for (const key of ['deepseekKey', 'asrKey']) disk[key] = data[key] ? this.crypto.encryptString(data[key]).toString('base64') : '';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(disk, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
    return data;
  }
}
module.exports = { Config, defaults };
