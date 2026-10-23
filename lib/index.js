/**
 * dsh-pet-launcher —— DSH 桌面端「桌宠启动器」。
 *
 * 宿主半侧职责：
 *   ① 往桌面端 index.html 注入一行**内联 script**（唯一有效通道，见下方大段注释）；
 *   ② 注册 4 条 HTTP 路由（widget.js / status / start / stop）；
 *   ③ 真正 spawn 桌宠进程（不是从 agent 的 shell 里起，那样会被写权限掐死）。
 *
 * 三只宠物的定义全在 pets.json（唯一真相源）；本文件不写死任何宠物路径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(LIB_DIR, '..')
const PETS_FILE = path.join(PACKAGE_ROOT, 'pets.json')
const WIDGET_FILE = path.join(LIB_DIR, 'widget.js')

const PREFIX = '/pet-launcher'
const WIDGET_PATH = PREFIX + '/widget.js'
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 进程扫描结果缓存：面板 8 秒轮询一次，扫描缓存活 10 秒 —— 每 5 秒拉一个 PowerShell 太烧 CPU
// （PowerShell 冷启动 250–500ms，等于常态占 5–10% 一个核）。
const SCAN_TTL_MS = 10000
const SCAN_TIMEOUT_MS = 6000
const KILL_WAIT_MS = 400
const SHUTDOWN_TIMEOUT_MS = 5000

// —— 桌面端（Electron）结构化注入行：**内联 script 行**，不是 script-src 行 ——
// 桌面壳的 index.html 从安装包静态 dist 直出，`tapIndex`（函数变换）永远过不去；
// 唯一通道是 `webserver/index-inject` 推的结构化行，经 IPC 交给页面侧解释器逐行应用。
// 而解释器对两种 script 行处理不对称：
//   case "script":     createElement + textContent + append  —— 没有 await，不可能"加载失败"
//   case "script-src": await loadScript(src)                  —— 失败即 reject，会 reject 掉
//                                                                __DSH_BOOT_READY__ ⇒ 整个应用起不来
// 所以由我们自己建 <script src=…> 并吞掉 onerror：路由在就正常加载，路由不在就静默失败。
const WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/pet-launcher/widget.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// ————————————————————————————— 小工具 —————————————————————————————
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const msgOf = (err) => String((err && err.message) || err)
const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)

function sendJson(res, status, obj) {
  try {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(obj))
  } catch (err) {
    /* 客户端断开之类，忽略 */
  }
}

/** JSONC → JSON：剥 `//` `/* *\/` 注释与尾逗号（`main-config.jsonc` 就带注释）。 */
function parseJsonc(text) {
  const src = stripBom(String(text))
  let out = ''
  let inStr = false
  let esc = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  // 尾逗号（第二次扫描，字符串内部不动）
  let cleaned = ''
  inStr = false
  esc = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inStr) {
      cleaned += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      cleaned += c
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === '}' || out[j] === ']') continue
    }
    cleaned += c
  }
  return JSON.parse(cleaned)
}

const normPath = (p) => String(p || '').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase()

// ————————————————————————— pets.json —————————————————————————
function readPets() {
  const parsed = JSON.parse(stripBom(fs.readFileSync(PETS_FILE, 'utf8')))
  const raw = Array.isArray(parsed && parsed.pets) ? parsed.pets : []
  return raw
    .filter((p) => p && typeof p.id === 'string' && p.id)
    .map((p) => ({
      id: p.id,
      label: typeof p.label === 'string' && p.label ? p.label : p.id,
      enabled: p.enabled !== false,
      kind: p.kind === 'cmd' || p.kind === 'dshpet' ? p.kind : 'exe',
      target: typeof p.target === 'string' ? p.target : '',
      args: Array.isArray(p.args) ? p.args.map(String) : [],
      cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : p.target ? path.dirname(p.target) : undefined,
      detect: p.detect && typeof p.detect === 'object' ? p.detect : {},
      configFile: typeof p.configFile === 'string' ? p.configFile : '',
      apiBase: typeof p.apiBase === 'string' && p.apiBase ? p.apiBase : '/dsh-pet-7340',
      helperPath: typeof p.helperPath === 'string' ? p.helperPath : '',
      hideOnHostStart: p.hideOnHostStart === true,
      // 默认 true：关 DSH 时把这只一起收掉（用户 2026-10-19 要求）。dshpet 不吃这个标志 ——
      // 那只的生命周期归 dsh-pet 插件自己（它退出时自己 stopHelper）。
      killOnHostExit: p.killOnHostExit !== false,
    }))
}

function findPet(id) {
  return readPets().find((p) => p.id === id) || null
}

// ————————————————————— 进程扫描（Get-Process，不碰 WMI/CIM）—————————————————————
// 为什么不用 CIM：本机 sandbox/ConstrainedLanguage 下 `Get-CimInstance` 直接不可用；
// 而 `Get-Process` 就能给出 Path —— 足够按"镜像完整路径"精确认人（pythonw.exe 有两个
// 实例：大肥鱼那只在 venv 里，另一只是系统 Python，只看镜像名会认错）。
let scanCache = { at: 0, key: '', result: { list: [], ok: true, error: '' } }

/** 起/停之后一定要让缓存失效，否则 10 秒内读到的还是变化前的进程表（踩过：杀完仍显示"在跑"）。 */
function invalidateScan() {
  scanCache = { at: 0, key: '', result: { list: [], ok: true, error: '' } }
}

function imagesOf(pets) {
  const names = new Set()
  for (const p of pets) {
    const det = p.detect || {}
    const name = det.imageName || (p.kind === 'exe' && p.target ? path.basename(p.target) : '')
    if (name) names.add(String(name).replace(/\.exe$/i, '').toLowerCase())
  }
  if (pets.some((p) => p.kind === 'dshpet')) names.add('electron')
  return [...names].sort()
}

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"

/** 隐藏跑一段 PowerShell，stdout/stderr 全丢弃（结果由脚本自己写文件）。 */
function psExec(script, timeoutMs) {
  return new Promise((resolve) => {
    const exe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    let child
    try {
      child = spawn(
        exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        // 关键：**不要管道**。管道 stdio 在受限沙箱里会 EPERM（本机实测），
        // 而 stdio:'ignore' 到处都能起。输出走临时文件，见 psProcessList。
        { windowsHide: true, stdio: 'ignore' },
      )
    } catch (err) {
      return resolve({ ok: false, error: 'PowerShell 启动失败：' + msgOf(err) })
    }
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try {
        clearTimeout(timer)
      } catch (err) {}
      resolve(v)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (err) {}
      finish({ ok: false, error: 'PowerShell 超时（' + timeoutMs + 'ms）' })
    }, timeoutMs)
    child.on('error', (err) => finish({ ok: false, error: 'PowerShell 出错：' + msgOf(err) }))
    child.on('close', () => finish({ ok: true }))
  })
}

let tmpSeq = 0

/** 返回 { list, ok, error }；ok=false 表示"扫描不可用"，调用方必须如实上报，不许当成"没在跑"。 */
async function psProcessList(names) {
  const tmp = path.join(
    process.env.TEMP || process.env.TMP || os.tmpdir(),
    'dsh-pet-launcher-' + process.pid + '-' + ++tmpSeq + '.json',
  )
  const q = psQuote(tmp)
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$ProgressPreference="SilentlyContinue";',
    'try {',
    '  $r = Get-Process -Name ' + names.map(psQuote).join(',') + ' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path;',
    '  if ($r) { $r | ConvertTo-Json -Compress | Set-Content -LiteralPath ' + q + ' -Encoding UTF8 }',
    '  else { Set-Content -LiteralPath ' + q + ' -Value "[]" -Encoding UTF8 }',
    '} catch {',
    '  try { Set-Content -LiteralPath ' + q + ' -Value "[]" -Encoding UTF8 } catch {}',
    '}',
  ].join('\n')
  try {
    const run = await psExec(script, SCAN_TIMEOUT_MS)
    if (!run.ok) return { list: [], ok: false, error: run.error }
    let text = ''
    try {
      text = stripBom(fs.readFileSync(tmp, 'utf8')).trim()
    } catch (err) {
      return { list: [], ok: false, error: '读不到扫描输出（' + tmp + '）：' + msgOf(err) }
    }
    if (!text) return { list: [], ok: false, error: '扫描输出为空' }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      return { list: [], ok: false, error: '扫描输出不是 JSON：' + text.slice(0, 120) }
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return {
      ok: true,
      error: '',
      list: arr
        .filter((r) => r && typeof r.Id === 'number')
        .map((r) => ({ pid: Number(r.Id), image: String(r.ProcessName || '') + '.exe', path: String(r.Path || '') })),
    }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch (err) {}
  }
}

async function scanImages(pets, force) {
  const names = imagesOf(pets)
  if (!names.length) return { list: [], ok: true, error: '' }
  const key = names.join(',')
  if (!force && scanCache.key === key && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.result
  const result = await psProcessList(names)
  scanCache = { at: Date.now(), key, result }
  return result
}

/** 扫描结果里属于这只宠物的进程（镜像名 + 完整路径双重比对，避免误杀兄弟进程）。 */
function matchProcesses(list, pet) {
  const det = pet.detect || {}
  const wantImage = String(det.imageName || (pet.kind === 'exe' && pet.target ? path.basename(pet.target) : ''))
    .replace(/\.exe$/i, '')
    .toLowerCase()
  const wantPath = det.imagePath || (pet.kind === 'exe' ? pet.target : '')
  if (!wantImage) return []
  return list.filter((row) => {
    const image = String(row.image || '').replace(/\.exe$/i, '').toLowerCase()
    if (image !== wantImage) return false
    if (!wantPath) return true
    if (!row.path) return false // 读不到路径就宁可认"没跑"，也不误杀
    return normPath(row.path) === normPath(wantPath)
  })
}

// ————————————————————— 本插件起过的 pid —————————————————————
const launched = new Map() // id -> { pid }
const lastError = new Map() // id -> string

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM' // 存在但没权限 → 活着
  }
}

async function killPids(pids) {
  const killed = []
  for (const pid of pids) {
    if (!pidAlive(pid)) continue
    try {
      process.kill(pid)
    } catch (err) {}
    killed.push(pid)
  }
  if (!killed.length) return killed
  await sleep(KILL_WAIT_MS)
  for (const pid of killed) {
    if (!pidAlive(pid)) continue
    // SIGTERM 没拿下（GUI 进程常见）→ 强杀。taskkill /T 连子进程一起收。
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      }).on('error', () => {})
    } catch (err) {}
  }
  invalidateScan()
  return killed
}

// ————————————————— 宿主退出：把桌宠一起收掉 —————————————————
// 用户要求：「dsh 关掉就关掉三个桌宠」。插件被 dispose（宿主退出）时这个函数**同步**跑，
// 原因：dispose 之后进程马上就走，异步的东西（setTimeout/await）来不及。所以走 execFileSync，
// 而且仍然不用管道（结果写临时文件），一次 PowerShell 扫全部镜像、然后逐个 process.kill。
function psProcessListSync(names, timeoutMs) {
  const tmp = path.join(
    process.env.TEMP || process.env.TMP || os.tmpdir(),
    'dsh-pet-launcher-exit-' + process.pid + '-' + ++tmpSeq + '.json',
  )
  const q = psQuote(tmp)
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$ProgressPreference="SilentlyContinue";',
    'try {',
    '  $r = Get-Process -Name ' + names.map(psQuote).join(',') + ' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path;',
    '  if ($r) { $r | ConvertTo-Json -Compress | Set-Content -LiteralPath ' + q + ' -Encoding UTF8 }',
    '  else { Set-Content -LiteralPath ' + q + ' -Value "[]" -Encoding UTF8 }',
    '} catch {',
    '  try { Set-Content -LiteralPath ' + q + ' -Value "[]" -Encoding UTF8 } catch {}',
    '}',
  ].join('\n')
  try {
    execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: 'ignore', timeout: timeoutMs || SHUTDOWN_TIMEOUT_MS },
    )
    const text = stripBom(fs.readFileSync(tmp, 'utf8')).trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr
      .filter((r) => r && typeof r.Id === 'number')
      .map((r) => ({ pid: Number(r.Id), image: String(r.ProcessName || '') + '.exe', path: String(r.Path || '') }))
  } catch (err) {
    return []
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch (err) {}
  }
}

/**
 * dsh-pet 桌面 helper 的兜底清理（异步、延迟 3 秒、detached）。
 *
 * 为什么不在这里同步杀：dsh-pet **会自己把被杀掉的 helper 拉回来**（实测：杀掉后 8 秒内换了新 pid）。
 * 同步杀只会和它的重启逻辑打架。正确顺序是让 dsh-pet 自己的 dispose（`disposed = true; stopHelper()`
 * → 不会重启）先走。这里只负责兜底：3 秒后如果 **DSH 已经不在了**、helper 还赖着，就补一刀。
 * DSH 还活着（比如刚重开）就什么都不做，免得把新会话的宠物掐掉。
 */
function scheduleHelperCleanup(helperPaths) {
  const paths = [...new Set(helperPaths.filter(Boolean))]
  if (!paths.length) return
  const cond = paths.map((p) => '$_.Path -eq ' + psQuote(p)).join(' -or ')
  const script = [
    'Start-Sleep -Milliseconds 3000;',
    'if (Get-Process -Name ' + psQuote('DeepSeek Harness') + ' -ErrorAction SilentlyContinue) { exit };',
    'Get-Process -Name ' + psQuote('electron') + ' -ErrorAction SilentlyContinue | Where-Object { ' + cond + ' } | ForEach-Object {',
    '  try { & taskkill /PID $_.Id /T /F 2>$null } catch {}',
    '}',
  ].join('\n')
  try {
    const child = spawn(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.on('error', () => {})
    child.unref()
    return true
  } catch (err) {
    return false
  }
}

/** 关 DSH 时收掉 pets.json 里 killOnHostExit 的那几只；返回被杀的 pid 列表。 */
function killPetsOnShutdown(reason) {
  let pets = []
  try {
    pets = readPets()
  } catch (err) {
    return []
  }
  const targets = pets.filter((p) => (p.kind === 'exe' || p.kind === 'cmd') && p.killOnHostExit)
  const helperPaths = pets.filter((p) => p.kind === 'dshpet' && p.helperPath).map((p) => p.helperPath)
  // helper 只安排兜底，不在这里同步杀（见 scheduleHelperCleanup 的注释）
  try {
    scheduleHelperCleanup(helperPaths)
  } catch (err) {}
  if (!targets.length) return []
  const names = imagesOf(targets)
  const list = psProcessListSync(names)
  const pids = new Set()
  for (const pet of targets) {
    for (const row of matchProcesses(list, pet)) pids.add(row.pid)
    // 兜底：本插件记录过的 pid 哪怕扫描没看到也收掉（扫描可能被超时截断）
    const rec = launched.get(pet.id)
    if (rec && pidAlive(rec.pid)) pids.add(rec.pid)
  }
  const killed = []
  for (const pid of pids) {
    try {
      process.kill(pid)
      killed.push(pid)
    } catch (err) {}
  }
  // 还活着的再同步强杀一次（同步：进程马上就要退了，不能留异步兜底）
  for (const pid of killed) {
    if (!pidAlive(pid)) continue
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 })
    } catch (err) {}
  }
  if (killed.length) {
    try {
      console.warn('[pet-launcher] ' + (reason || '宿主退出') + '：已结束 ' + killed.length + ' 个桌宠进程（pid ' + killed.join(',') + '）')
    } catch (err) {}
  }
  invalidateScan()
  return killed
}

// ————————————————————— dsh-pet（插件那只）状态 —————————————————————
function readDshPetState(pet, scanList) {
  const out = { display: null, showing: null, error: '', helperRunning: null }
  if (pet.helperPath) {
    const helper = String(pet.helperPath)
    out.helperRunning = (scanList || []).some((row) => row.path && normPath(row.path) === normPath(helper))
  }
  if (!pet.configFile) {
    out.error = 'pets.json 里缺 configFile'
    return out
  }
  try {
    const obj = parseJsonc(fs.readFileSync(pet.configFile, 'utf8'))
    const list = obj && Array.isArray(obj.pets) ? obj.pets : []
    if (!list.length) {
      out.error = 'configFile 里没有 pets[]'
      return out
    }
    const display = String(list[0].display || '')
    out.display = display || '(未设置)'
    out.showing = display === 'desktop' || display === 'both'
  } catch (err) {
    // 按"未知"处理，不许崩
    out.error = '读/解析配置失败：' + msgOf(err)
  }
  return out
}

function httpJson({ method, port, pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(String(body), 'utf8')
    const headers = { Accept: 'application/json' }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(payload.length)
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers, timeout: 20000 },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch (err) {}
          resolve({ status: res.statusCode || 0, text, json })
        })
      },
    )
    req.on('timeout', () => {
      try {
        req.destroy(new Error('请求超时（20s）'))
      } catch (err) {}
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** display 翻转：desktop ↔ none。返回切换后的值。 */
async function setDshPetDisplay(pet, want, port) {
  if (!port) throw new Error('拿不到 ctx.webServer.port，无法调用 dsh-pet 接口')
  let obj
  try {
    obj = parseJsonc(fs.readFileSync(pet.configFile, 'utf8'))
  } catch (err) {
    throw new Error('读/解析 ' + pet.configFile + ' 失败：' + msgOf(err))
  }
  const list = obj && Array.isArray(obj.pets) ? obj.pets : []
  if (!list.length) throw new Error(pet.configFile + ' 里没有 pets[]')
  list[0].display = want
  const res = await httpJson({
    method: 'PUT',
    port,
    pathname: pet.apiBase.replace(/\/$/, '') + '/config',
    body: JSON.stringify(obj),
  })
  if (res.status === 404) {
    throw new Error('dsh-pet 路由 404（插件没装或已停）：PUT ' + pet.apiBase + '/config')
  }
  if (res.status === 409) {
    throw new Error('dsh-pet 判定用户配置无法解析（409），需人工确认：' + JSON.stringify(res.json || res.text).slice(0, 300))
  }
  if (res.status !== 200) {
    const detail = (res.json && (res.json.error || res.json.message)) || res.text
    throw new Error('PUT ' + pet.apiBase + '/config → HTTP ' + res.status + '：' + String(detail || '').slice(0, 300))
  }
  return want
}

// ————————————————————— 状态 / 起停实现 —————————————————————
// scan = { list, ok, error }。ok === false 表示"扫描不可用"：
// 此时**绝不能**把"没扫到"当成"没在跑"——那会起出第二只桌宠，而且按钮也结束不了它。
async function petView(pet, scan, port) {
  const base = { id: pet.id, label: pet.label, enabled: pet.enabled, kind: pet.kind, mode: pet.kind === 'dshpet' ? 'toggle' : 'spawn' }
  if (pet.kind === 'dshpet') {
    const st = readDshPetState(pet, scan.ok ? scan.list : null)
    return Object.assign(base, {
      running: st.showing,
      pid: null,
      display: st.display,
      helperRunning: st.helperRunning,
      error: st.error || lastError.get(pet.id) || '',
      helperPath: pet.helperPath || '',
    })
  }
  const rec = launched.get(pet.id)
  if (rec && pidAlive(rec.pid)) {
    return Object.assign(base, { running: true, pid: rec.pid, source: 'launcher', error: lastError.get(pet.id) || '' })
  }
  if (rec) launched.delete(pet.id)
  if (!scan.ok) {
    return Object.assign(base, {
      running: null,
      pid: null,
      error: '进程扫描不可用：' + (scan.error || '未知原因'),
    })
  }
  const hits = matchProcesses(scan.list, pet)
  if (hits.length) {
    return Object.assign(base, { running: true, pid: hits[0].pid, source: 'scan', count: hits.length, error: lastError.get(pet.id) || '' })
  }
  return Object.assign(base, { running: false, pid: null, error: lastError.get(pet.id) || '' })
}

async function startPet(pet, scan, port) {
  if (pet.kind === 'dshpet') {
    const st = readDshPetState(pet, scan.ok ? scan.list : null)
    if (st.showing === true) return { ok: true, already: true, display: st.display }
    if (st.showing === null) throw new Error(st.error || '当前状态未知，拒绝盲改')
    const display = await setDshPetDisplay(pet, 'desktop', port)
    return { ok: true, display, before: st.display }
  }

  const rec = launched.get(pet.id)
  if (rec && pidAlive(rec.pid)) return { ok: true, already: true, pid: rec.pid, source: 'launcher' }
  if (!scan.ok) {
    throw new Error(
      '进程扫描不可用，无法确认它是不是已经在跑了；为避免起出第二只桌宠，本次已拒绝：' + (scan.error || '未知原因'),
    )
  }
  const hits = matchProcesses(scan.list, pet)
  if (hits.length) {
    launched.set(pet.id, { pid: hits[0].pid })
    return { ok: true, already: true, pid: hits[0].pid, source: 'scan' }
  }

  // 缓存可能过期 → 强刷一次扫描再决定（宁可多花 300ms，也不起重复实例）
  const fresh = await scanImages(readPets(), true)
  if (!fresh.ok) {
    throw new Error('进程扫描不可用，已放弃启动：' + (fresh.error || '未知原因'))
  }
  const freshHits = matchProcesses(fresh.list, pet)
  if (freshHits.length) {
    launched.set(pet.id, { pid: freshHits[0].pid })
    return { ok: true, already: true, pid: freshHits[0].pid, source: 'scan' }
  }

  if (!pet.target) throw new Error('pets.json 里缺 target')
  if (!fs.existsSync(pet.target)) throw new Error('目标不存在：' + pet.target)

  const opts = { detached: true, stdio: 'ignore', windowsHide: true }
  if (pet.cwd) opts.cwd = pet.cwd
  let child
  if (pet.kind === 'cmd') {
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', pet.target], opts)
  } else {
    child = spawn(pet.target, pet.args, opts)
  }
  const pid = child && typeof child.pid === 'number' ? child.pid : 0
  if (!pid) {
    lastError.set(pet.id, 'spawn 失败（拿不到 pid，多半是目标不可执行）')
    throw new Error(lastError.get(pet.id) + '：' + pet.target)
  }
  launched.set(pet.id, { pid })
  lastError.delete(pet.id)
  child.on('error', (err) => {
    lastError.set(pet.id, 'spawn 出错：' + msgOf(err))
    if (launched.get(pet.id)?.pid === pid) launched.delete(pet.id)
  })
  child.on('exit', () => {
    // cmd 型（启动桌宠.cmd 里 start 出去）会立刻退出 —— 真身交给扫描认领
    if (launched.get(pet.id)?.pid === pid) launched.delete(pet.id)
  })
  try {
    child.unref()
  } catch (err) {}
  invalidateScan() // 新进程还没进旧缓存，别让下一次状态查询读到"没在跑"
  // cmd 型（启动桌宠.cmd）最后那个 `start "" exe` 要 1–3 秒才真正起来。
  // 如果只靠一次即时扫描，会把"还没起来"这个否定结果缓存住 10 秒 —— 用户点了启动却看到灰点。
  // 所以补两次强制扫描，把真身写进缓存。
  if (pet.kind === 'cmd') {
    for (const delay of [1500, 4000]) {
      try {
        const t = setTimeout(() => {
          scanImages(readPets(), true).catch(() => {})
        }, delay)
        if (t && typeof t.unref === 'function') t.unref()
      } catch (e2) {}
    }
  }
  return { ok: true, pid, kind: pet.kind, target: pet.target }
}

async function stopPet(pet, scan, port) {
  if (pet.kind === 'dshpet') {
    const st = readDshPetState(pet, scan.ok ? scan.list : null)
    if (st.showing === false) return { ok: true, already: true, display: st.display }
    if (st.showing === null) throw new Error(st.error || '当前状态未知，拒绝盲改')
    const display = await setDshPetDisplay(pet, 'none', port)
    return { ok: true, display, before: st.display }
  }

  const pids = new Set()
  const rec = launched.get(pet.id)
  if (rec && pidAlive(rec.pid)) pids.add(rec.pid)
  if (scan.ok) for (const row of matchProcesses(scan.list, pet)) pids.add(row.pid)
  if (!pids.size) {
    const fresh = await scanImages(readPets(), true)
    if (!fresh.ok) {
      throw new Error('进程扫描不可用，且本插件没记录到 pid，无法安全结束：' + (fresh.error || '未知原因'))
    }
    for (const row of matchProcesses(fresh.list, pet)) pids.add(row.pid)
  }
  if (!pids.size) {
    launched.delete(pet.id)
    return { ok: true, already: true }
  }
  const killed = await killPids([...pids])
  const after = await scanImages(readPets(), true)
  launched.delete(pet.id)
  if (!after.ok) {
    return { ok: true, killed, verified: false, warning: '已发结束信号，但扫描不可用、无法确认：' + (after.error || '') }
  }
  const still = matchProcesses(after.list, pet).map((r) => r.pid)
  if (still.length) {
    const err = '结束失败，仍在运行：pid ' + still.join(', ')
    lastError.set(pet.id, err)
    throw new Error(err)
  }
  lastError.delete(pet.id)
  return { ok: true, killed }
}

// ————————————————————————— 插件本体 —————————————————————————
export default {
  name: 'dsh-pet-launcher',
  apply(root) {
    // ⓪ 释放器先挂上：root.effect 里注册的回调在插件卸载/热重载时执行
    const rowDisposers = []
    try {
      root.effect(() => () => {
        for (const d of rowDisposers) {
          try {
            d()
          } catch (err) {}
        }
      })
    } catch (err) {}

    // ① 注入行必须**在 apply 里第一时间同步注册**：桌面宿主启动时一次性 collectIndexInjections() 取表，
    //    包在 root.inject([...], cb) 里晚一步就永远进不了表（按钮永远不出现）。
    try {
      const dispose = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === WIDGET_PATH) return // 旧行为 → 不重复
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_PATH) >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: WIDGET_ROW_TEXT })
        } catch (err) {
          try {
            console.warn('[pet-launcher] 注入行注册失败：' + msgOf(err))
          } catch (e2) {}
        }
      })
      if (typeof dispose === 'function') rowDisposers.push(dispose)
    } catch (err) {
      try {
        console.warn('[pet-launcher] 无法订阅 webserver/index-inject：' + msgOf(err))
      } catch (e2) {}
    }

    // ② 其余逻辑等 webServer 就绪后再跑
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const webServer = ctx.webServer
      const port = webServer && typeof webServer.port === 'number' ? webServer.port : 0

      // —— 回环栅栏：这接口能起任意进程，绝不能给局域网/伪造 Origin 的网页打 ——
      // 双层：① 插件自己的回环 + 同源校验（永远先跑）；② 宿主 connection.requestRejection 可用时委托它，
      //       它抛异常按拒绝处理（fail-closed）。
      function isLoopbackHostname(hn) {
        const h = String(hn || '')
          .toLowerCase()
          .replace(/^\[/, '')
          .replace(/\]$/, '')
        if (!h) return false
        if (h === 'localhost' || h.endsWith('.localhost')) return true
        if (h === '::1') return true
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
        if (!m) return false
        if (Number(m[1]) !== 127) return false
        return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
      }
      function connectionFence() {
        try {
          const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : null) || ctx.connection
          return conn && typeof conn.requestRejection === 'function' ? conn : null
        } catch (err) {
          return null
        }
      }
      /** POST 只放行本机：Host 回环 + 非跨站 + Origin 与 Host 同源（有的话）。 */
      function selfRejection(req) {
        try {
          const headers = (req && req.headers) || {}
          let hostUrl
          try {
            hostUrl = new URL('http://' + String(headers.host || ''))
          } catch (err) {
            return 403
          }
          if (!isLoopbackHostname(hostUrl.hostname)) return 403
          const site = String(headers['sec-fetch-site'] || '').toLowerCase()
          if (site === 'cross-site') return 403
          const origin = headers.origin
          if (typeof origin === 'string' && origin && origin !== 'null') {
            let originUrl
            try {
              originUrl = new URL(origin)
            } catch (err) {
              return 403
            }
            if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
          }
          return null
        } catch (err) {
          return 403
        }
      }
      function rejected(req, res) {
        const deny = (code, why) => {
          const c = code || 403
          const detail =
            why ||
            (c === 401
              ? '需要 DSH 的浏览器会话认证 —— 请在 DSH 窗口里面点按钮（命令行/脚本没有会话 cookie，一律拒）'
              : '只接受本机（回环）请求')
          try {
            res.writeHead(c, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end('forbidden: pet-launcher —— ' + detail)
          } catch (err) {}
          return true
        }
        if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') return false
        const self = selfRejection(req)
        if (self !== null) {
          try {
            console.warn('[pet-launcher] 已拒绝一个非本机/跨站 POST（Host=' + String((req.headers || {}).host || '') + '）')
          } catch (err) {}
          return deny(self, '来源不是本机回环（Host / Origin / Sec-Fetch-Site 不符）')
        }
        const conn = connectionFence()
        if (!conn) return false
        let code
        try {
          code = conn.requestRejection(req)
        } catch (err) {
          return deny(403, '宿主信任栅栏抛异常，按拒绝处理（fail-closed）') // 栅栏自己抛 → 拒
        }
        if (code === undefined || code === null || code === false) return false
        return deny(typeof code === 'number' ? code : 403)
      }

      function registerRoute(pathname, handler) {
        const wrapped = {
          kind: 'exact',
          path: pathname,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              return await handler(req, res)
            } catch (err) {
              // 兜底：任何未捕获异常都不许把连接吊死
              sendJson(res, 500, { ok: false, error: msgOf(err) })
            }
          },
        }
        const dispose = webServer.register(wrapped)
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      }

      // widget.js —— 按 mtime 缓存
      let widgetCache = null
      function loadWidgetJs() {
        try {
          const st = fs.statSync(WIDGET_FILE)
          if (widgetCache && widgetCache.mtimeMs === st.mtimeMs) return widgetCache.text
          const text = fs.readFileSync(WIDGET_FILE, 'utf8')
          widgetCache = { mtimeMs: st.mtimeMs, text }
          return text
        } catch (err) {
          return widgetCache ? widgetCache.text : ''
        }
      }

      registerRoute(WIDGET_PATH, (req, res) => {
        const text = loadWidgetJs()
        if (!text) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end('widget.js 读取失败：' + WIDGET_FILE)
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(text)
      })

      // status —— 只读
      registerRoute(PREFIX + '/status', async (req, res) => {
        const pets = readPets()
        const scan = await scanImages(pets, false)
        const rows = []
        for (const pet of pets) rows.push(await petView(pet, scan, port))
        sendJson(res, 200, {
          ok: true,
          port,
          ts: Date.now(),
          scan: { ok: scan.ok, error: scan.error || '' },
          pets: rows,
        })
      })

      // start / stop —— 写，已由 rejected() 守住；方法不对直接 405（别让 GET 也能起进程）
      const action = (want) => async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST（收到 ' + method + '）' })
        let id = ''
        try {
          id = new URL(String(req.url || '/'), 'http://localhost').searchParams.get('id') || ''
        } catch (err) {}
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id 参数' })
        const pet = findPet(id)
        if (!pet) return sendJson(res, 404, { ok: false, error: '未定义的宠物 id：' + id })
        if (!pet.enabled) return sendJson(res, 400, { ok: false, error: '该宠物在 pets.json 里 enabled=false' })
        const pets = readPets()
        const scan = await scanImages(pets, true)
        try {
          const result = want === 'start' ? await startPet(pet, scan, port) : await stopPet(pet, scan, port)
          // 动作后再看一眼真实状态，回给前端（前端也会自己刷新）
          const after = await scanImages(readPets(), true)
          const view = await petView(pet, after, port)
          sendJson(res, 200, Object.assign({ ok: true }, result, { pet: view }))
        } catch (err) {
          lastError.set(pet.id, msgOf(err))
          sendJson(res, 500, { ok: false, id: pet.id, error: msgOf(err) })
        }
      }
      registerRoute(PREFIX + '/start', action('start'))
      registerRoute(PREFIX + '/stop', action('stop'))

      // web 形态的兜底（桌面端 tapIndex 不生效，桌面端靠上面那行 index-inject）
      try {
        const dispose = webServer.tapIndex((html) => {
          if (html.indexOf(WIDGET_PATH) !== -1) return html
          const tag = '<script defer src="' + WIDGET_PATH + '"></script>'
          if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
          return html + tag
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (err) {
        try {
          console.warn('[pet-launcher] tapIndex 不可用（web 形态注入跳过）：' + msgOf(err))
        } catch (e2) {}
      }

      // ③ 宿主启动时，把标了 `hideOnHostStart` 的那只收回隐藏。
      // 为什么需要它：dsh-pet 自己会把 `display` 持久化在 main-config.jsonc 里，所以"上次你点过显示"
      // 就意味着"下次开 DSH 它自己冒出来"。用户要的是**不随 DSH 自启**，所以每次宿主启动检查一次：
      // 已经是 none 就什么都不做；还是 desktop/both 就 PUT 回 none。
      // display 为 none 时 dsh-pet 的 startHelper() 会直接 return —— 连 Electron helper 都不拉（零进程）。
      // 想回到 dsh-pet 原本的"记住上次状态"：把 pets.json 里那只的 hideOnHostStart 改成 false。
      let autoHideTimer = 0
      let autoHideDone = false
      let disposed = false
      const AUTO_HIDE_DELAYS = [0, 700, 1800, 3500, 7000, 12000] // 覆盖"本插件比 dsh-pet 先加载"的那段
      const autoHideStep = (i) => {
        if (disposed || autoHideDone) return
        let pets = []
        try {
          pets = readPets()
        } catch (err) {
          pets = []
        }
        const targets = pets.filter((p) => p.kind === 'dshpet' && p.hideOnHostStart)
        if (!targets.length) {
          autoHideDone = true
          return
        }
        let pending = false
        for (const pet of targets) {
          const st = readDshPetState(pet, null)
          if (st.showing === false) continue // 已经是隐藏，收工
          pending = true
          if (st.showing === null) continue // 配置读不出来 → 下一轮再看（不瞎写）
          setDshPetDisplay(pet, 'none', port)
            .then(() => {
              try {
                console.warn('[pet-launcher] 宿主启动：已把 ' + pet.id + ' 收回隐藏（display → none）')
              } catch (e2) {}
            })
            .catch((err) => {
              try {
                console.warn('[pet-launcher] 宿主启动自动隐藏 ' + pet.id + ' 失败：' + msgOf(err))
              } catch (e2) {}
            })
        }
        if (!pending) {
          autoHideDone = true
          return
        }
        if (i + 1 < AUTO_HIDE_DELAYS.length) {
          autoHideTimer = setTimeout(() => autoHideStep(i + 1), AUTO_HIDE_DELAYS[i + 1])
          try {
            if (autoHideTimer && typeof autoHideTimer.unref === 'function') autoHideTimer.unref()
          } catch (e2) {}
        }
      }
      try {
        autoHideTimer = setTimeout(() => autoHideStep(0), AUTO_HIDE_DELAYS[0])
        if (autoHideTimer && typeof autoHideTimer.unref === 'function') autoHideTimer.unref()
      } catch (err) {
        try {
          console.warn('[pet-launcher] 启动自动隐藏调度失败：' + msgOf(err))
        } catch (e2) {}
      }

      ctx.effect(() => () => {
        disposed = true
        if (autoHideTimer) {
          try {
            clearTimeout(autoHideTimer)
          } catch (err) {}
        }
        for (const d of disposers) {
          try {
            d()
          } catch (err) {}
        }
        // 最后一步（同步）：关 DSH 就把桌宠一起收掉。
        // 放在释放路由之后，是因为 killPetsOnShutdown 只读 pets.json + 扫进程，不依赖任何路由。
        try {
          killPetsOnShutdown('宿主退出')
        } catch (err) {
          try {
            console.warn('[pet-launcher] 宿主退出时收桌宠失败：' + msgOf(err))
          } catch (e2) {}
        }
      })
    })
  },
}

// 仅供本地自检脚本使用（DSH 只认 default export）。见 .scratch/test-pet-launcher.mjs。
export const __test = {
  parseJsonc,
  normPath,
  readPets,
  matchProcesses,
  imagesOf,
  scanImages,
  psProcessList,
  psProcessListSync,
  killPetsOnShutdown,
}
