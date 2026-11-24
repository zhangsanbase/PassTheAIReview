const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(electronDist)) {
  console.error('Electron runtime not found. Please run "npm install" first.');
  process.exit(1);
}

const folderName = `InterviewDesk-${pkg.version}-win-x64`;
const distRoot = path.join(root, 'dist');
const outDir = path.join(distRoot, folderName);
const zipPath = path.join(distRoot, `${folderName}.zip`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(distRoot, { recursive: true });

console.log(`Copying Electron runtime -> ${outDir}`);
fs.cpSync(electronDist, outDir, { recursive: true });

const defaultExe = path.join(outDir, 'electron.exe');
const targetExe = path.join(outDir, 'InterviewDesk.exe');
if (fs.existsSync(defaultExe)) fs.renameSync(defaultExe, targetExe);

const defaultAsar = path.join(outDir, 'resources', 'default_app.asar');
if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar, { force: true });

const appDir = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });

// Copy runtime dependencies recursively so the portable bundle needs no npm install.
function collectDeps(deps, seen = new Set()) {
  for (const name of Object.keys(deps || {})) {
    if (seen.has(name)) continue;
    const modDir = path.join(root, 'node_modules', name);
    if (!fs.existsSync(modDir)) continue;
    seen.add(name);
    const modPkg = JSON.parse(fs.readFileSync(path.join(modDir, 'package.json'), 'utf8'));
    collectDeps(modPkg.dependencies, seen);
  }
  return seen;
}
for (const name of collectDeps(pkg.dependencies)) {
  fs.cpSync(path.join(root, 'node_modules', name), path.join(appDir, 'node_modules', name), { recursive: true });
}

const appManifest = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  license: pkg.license,
  description: pkg.description,
  main: pkg.main,
  dependencies: pkg.dependencies
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appManifest, null, 2), 'utf8');

if (fs.existsSync(path.join(root, 'LICENSE'))) {
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));
}

const guide = [
  'Interview Desk / 面试参考工作台（Windows x64 便携版）',
  '',
  '1. 解压整个压缩包后，直接双击 InterviewDesk.exe 即可一键启动（无需安装 Node.js）。',
  '2. 首次使用点击右上角「设置」填写回答服务（DeepSeek 或 OpenAI 兼容 Base URL）及阿里云百炼实时语音配置。',
  '3. 若使用手机音频转发功能，请另外安装官方 scrcpy：winget install --exact Genymobile.scrcpy。',
  '4. 请保留目录下所有文件完整，不要单独移动 InterviewDesk.exe。',
  ''
].join('\r\n');
fs.writeFileSync(path.join(outDir, '使用说明.txt'), guide, 'utf8');

console.log(`Creating portable zip -> ${zipPath}`);
const psCommand = [
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  `[System.IO.Compression.ZipFile]::CreateFromDirectory('${outDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $true, [System.Text.Encoding]::UTF8)`
].join('; ');
execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });

console.log(`Done:\n- Folder: ${outDir}\n- Zip: ${zipPath}`);
