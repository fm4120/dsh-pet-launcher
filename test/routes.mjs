/* 自检：不安装、不启动任何桌宠，把 apply() 挂到 mock 宿主上把路由跑一遍。
 *
 * 覆盖：注入行 / 4 条路由 / 写接口安全栅栏 / 参数校验 / JSONC 解析 / 路径归一化。
 * 只用 node 内置模块，不需要管理员，不需要 DSH 常驻。
 *
 *   node test/routes.mjs
 *
 * pets.json 是本机的真实配置（.gitignore）；不存在时本测试会从 pets.example.json
 * 临时生成一份，跑完删掉。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PETS = path.join(PKG, 'pets.json')
const EXAMPLE = path.join(PKG, 'pets.example.json')

let tempPets = false
if (!fs.existsSync(PETS)) {
  fs.copyFileSync(EXAMPLE, PETS)
  tempPets = true
}

const mod = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href)
const plugin = mod.default
const T = mod.__test

let pass = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    pass++
    console.log('  PASS  ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL  ' + name + '\n        ' + String((err && err.message) || err))
  }
}
async function okAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log('  PASS  ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL  ' + name + '\n        ' + String((err && err.message) || err))
  }
}

/* ---------- mock 宿主：只实现插件真正用到的那几个面 ---------- */
const routes = new Map()
const tapIndexFns = []
const injectSubs = []
const disposers = []
const connection = { requestRejection: () => null }

const ctx = {
  webServer: {
    port: 19387,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(fn) {
      tapIndexFns.push(fn)
      return () => tapIndexFns.splice(tapIndexFns.indexOf(fn), 1)
    },
  },
  get(name) {
    if (name === 'connection') return connection
    throw new Error('unknown service ' + name)
  },
  effect(fn) {
    disposers.push(fn())
  },
}

const root = {
  on(evt, cb) {
    if (evt === 'webserver/index-inject') injectSubs.push(cb)
    return () => injectSubs.splice(injectSubs.indexOf(cb), 1)
  },
  inject(deps, cb) {
    assert.deepEqual(deps, ['webServer'])
    cb(ctx)
  },
  effect(fn) {
    disposers.push(fn())
  },
}

function call(pathname, { method = 'GET', headers = {}, search = '' } = {}) {
  const route = routes.get(pathname)
  assert.ok(route, '没有注册路由 ' + pathname)
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, h) {
      this.statusCode = code
      this.headers = h || {}
    },
    end(b) {
      this.body = typeof b === 'string' ? b : b ? Buffer.from(b).toString('utf8') : ''
    },
  }
  const req = {
    method,
    url: pathname + search,
    headers: Object.assign({ host: '127.0.0.1:19387' }, headers),
  }
  return Promise.resolve(route.handler(req, res)).then(() => res)
}

/* ---------- [1] apply() / 注入行 ---------- */
console.log('\n[1] apply() / 注入行')
plugin.apply(root)

ok('插件名没变', () => assert.equal(plugin.name, 'dsh-pet-launcher'))
ok('订阅了 webserver/index-inject', () => assert.equal(injectSubs.length, 1))
ok('注入行是内联 script（不是 script-src 那套）', () => {
  const table = []
  injectSubs[0](table)
  assert.equal(table.length, 1)
  const row = table[0]
  assert.equal(row.kind, 'script')
  assert.equal(row.placement, 'body')
  assert.ok(row.text.includes('/pet-launcher/widget.js'))
  assert.ok(row.text.includes('createElement("script")'))
})
ok('去重：表里已有就不再推', () => {
  const table = []
  injectSubs[0](table)
  injectSubs[0](table)
  assert.equal(table.length, 1)
})
ok('去重：老版本 script-src 行也在时不重复', () => {
  const table = [{ kind: 'script-src', src: '/pet-launcher/widget.js' }]
  injectSubs[0](table)
  assert.equal(table.length, 1)
})
ok('web 形态有 tapIndex 兜底且幂等', () => {
  assert.equal(tapIndexFns.length, 1)
  const out = tapIndexFns[0]('<html><body></body></html>')
  assert.ok(out.includes('/pet-launcher/widget.js'))
  assert.equal(tapIndexFns[0](out), out)
})

/* ---------- [2] 路由注册 ---------- */
console.log('\n[2] 路由注册')
ok('4 条路由都在，且都是 exact 匹配', () => {
  for (const p of ['/pet-launcher/widget.js', '/pet-launcher/status', '/pet-launcher/start', '/pet-launcher/stop']) {
    assert.ok(routes.has(p), '缺 ' + p)
    assert.equal(routes.get(p).kind, 'exact', p + ' 必须是 exact')
  }
})
ok('释放器已挂（卸载时能全部撤掉）', () => {
  assert.ok(disposers.length >= 2)
  for (const d of disposers) assert.equal(typeof d, 'function')
})

/* ---------- [3] widget.js 路由 ---------- */
console.log('\n[3] widget.js 路由')
await okAsync('200 + application/javascript + no-store', async () => {
  const res = await call('/pet-launcher/widget.js')
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'], /application\/javascript/)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.ok(res.body.length > 2000, 'widget.js 太短？')
  assert.ok(res.body.includes('pl-root'), '浮窗根节点标记缺失')
  assert.ok(res.body.includes("'/pet-launcher'"), '必须用相对路径前缀（宿主端口每次启动都变）')
})
await okAsync('不许写死端口 / 主机', async () => {
  const res = await call('/pet-launcher/widget.js')
  assert.ok(!/:19387/.test(res.body))
  assert.ok(!/127\.0\.0\.1:/.test(res.body))
})

/* ---------- [4] 写接口的安全栅栏（这接口能起任意进程） ---------- */
console.log('\n[4] 安全栅栏')
await okAsync('非回环 Host 的 POST → 403', async () => {
  const res = await call('/pet-launcher/start', { method: 'POST', headers: { host: '192.168.1.20:19387' }, search: '?id=demo-exe' })
  assert.equal(res.statusCode, 403)
})
await okAsync('相似域名 127.0.0.1.evil.com → 403', async () => {
  const res = await call('/pet-launcher/start', { method: 'POST', headers: { host: '127.0.0.1.evil.com:19387' }, search: '?id=demo-exe' })
  assert.equal(res.statusCode, 403)
})
await okAsync('Sec-Fetch-Site: cross-site → 403', async () => {
  const res = await call('/pet-launcher/start', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, search: '?id=demo-exe' })
  assert.equal(res.statusCode, 403)
})
await okAsync('Origin 与 Host 不同源 → 403', async () => {
  const res = await call('/pet-launcher/start', { method: 'POST', headers: { origin: 'https://evil.example' }, search: '?id=demo-exe' })
  assert.equal(res.statusCode, 403)
})
await okAsync('宿主栅栏抛异常 → 403（fail-closed）', async () => {
  const original = connection.requestRejection
  connection.requestRejection = () => {
    throw new Error('boom')
  }
  try {
    const res = await call('/pet-launcher/start', { method: 'POST', search: '?id=demo-exe' })
    assert.equal(res.statusCode, 403)
  } finally {
    connection.requestRejection = original
  }
})
await okAsync('GET 读接口不设栅栏（只读）', async () => {
  const res = await call('/pet-launcher/status', { method: 'GET', headers: { host: '192.168.1.20:19387' } })
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.ok(Array.isArray(data.pets), 'status 必须回 pets 数组')
})

/* ---------- [5] 参数校验 ---------- */
console.log('\n[5] start / stop 的参数校验（不真的起停）')
await okAsync('缺 id → 400', async () => {
  const res = await call('/pet-launcher/start', { method: 'POST' })
  assert.equal(res.statusCode, 400)
})
await okAsync('未知 id → 404', async () => {
  const res = await call('/pet-launcher/stop', { method: 'POST', search: '?id=nope' })
  assert.equal(res.statusCode, 404)
})
await okAsync('GET 打 start → 405（不能靠 GET 起进程）', async () => {
  const res = await call('/pet-launcher/start', { method: 'GET', search: '?id=demo-exe' })
  assert.equal(res.statusCode, 405)
})

/* ---------- [6] JSONC / 路径归一化（纯函数） ---------- */
console.log('\n[6] JSONC 解析与路径归一化')
ok('行注释 / 块注释 / 尾逗号', () => {
  const obj = T.parseJsonc('{\n // 说明\n "pets": [ { "id": "main", "display": "none", /* 行内 */ }, ],\n /* 多行\n 注释 */ "notificationsEnabled": true,\n }')
  assert.equal(obj.pets[0].display, 'none')
  assert.equal(obj.notificationsEnabled, true)
})
ok('字符串里的 // 和 ,} 不许被当注释 / 尾逗号吃掉', () => {
  const obj = T.parseJsonc('{"a":"http://x/y","b":"逗号,}保留"}')
  assert.equal(obj.a, 'http://x/y')
  assert.equal(obj.b, '逗号,}保留')
})
ok('解析失败要抛（由调用方按"未知"处理，绝不瞎改）', () => {
  assert.throws(() => T.parseJsonc('{ bad json '))
})
ok('路径归一化：正斜杠 → 反斜杠 + 小写', () => {
  assert.equal(T.normPath('C:/Temp/A.EXE'), 'c:\\temp\\a.exe')
})

/* ---------- 收尾 ---------- */
if (tempPets) fs.rmSync(PETS, { force: true })
console.log('\n' + (failed === 0 ? 'PASSED  ' : 'FAILED  ') + pass + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
