/**
 * dsh-pet-launcher —— 注入到 DSH 页面里的浮窗（纯浏览器 JS，无 import）。
 *
 * 由宿主 lib/index.js 通过 `webserver/index-inject` 的内联 script 行拉起：
 * 那一行自己 createElement('script') 去加载 /pet-launcher/widget.js，所以这里拿到执行机会时
 * document.body 已经在了。
 *
 * 约定：
 *   - 所有请求都是**相对路径**（宿主端口每次启动都可能变，绝不写死）；
 *   - 所有 DOM 挂在唯一容器 #pl-root 里，类名统一 pl- 前缀，样式只写一次；
 *   - 宠物路径一律由 pets.json 经 /pet-launcher/status 提供，这里不写死任何路径；
 *   - localStorage 可能被沙箱 iframe 拒绝 → 全部 try/catch。
 */
(function () {
  if (window.__dshPetLauncherMounted) return
  window.__dshPetLauncherMounted = true

  var API = '/pet-launcher'
  var POS_KEY = 'dsh-pet-launcher:pos'
  var COLLAPSE_KEY = 'dsh-pet-launcher:collapsed'
  // 宿主侧每次状态查询都可能要扫一遍进程（PowerShell 冷启动 250–500ms），所以别轮太快：
  // 展开 8 秒、折叠 30 秒；点按钮后另有 250ms / 2.5s 的即时补刷，操作反馈不受影响。
  var POLL_OPEN_MS = 8000
  var POLL_CLOSED_MS = 30000

  function lsGet(key) {
    try {
      return window.localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }
  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch (e) {
      /* 沙箱里可能被拒 —— 忽略即可 */
    }
  }

  var style = [
    '#pl-root{position:fixed;left:24px;bottom:24px;z-index:2147483000;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.45;color:#e7e9ef;-webkit-font-smoothing:antialiased}',
    '#pl-root *{box-sizing:border-box;box-sizing:border-box}',
    '#pl-root .pl-card{width:236px;background:rgba(20,23,31,.94);border:1px solid rgba(255,255,255,.10);border-radius:12px;box-shadow:0 14px 36px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.30);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);overflow:hidden}',
    '#pl-root .pl-head{display:flex;align-items:center;gap:6px;padding:8px 8px 8px 10px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));border-bottom:1px solid rgba(255,255,255,.07);cursor:grab;user-select:none;-webkit-user-select:none}',
    '#pl-root .pl-head.pl-dragging{cursor:grabbing}',
    '#pl-root .pl-title{flex:1;font-size:12px;font-weight:600;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#pl-root .pl-dot-total{width:6px;height:6px;border-radius:50%;background:#4b5563;flex:none;box-shadow:0 0 0 3px rgba(75,85,99,.22)}',
    '#pl-root .pl-dot-total.on{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.22)}',
    '#pl-root .pl-min{flex:none;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:6px;background:transparent;color:#9ca3af;font-size:13px;line-height:1;cursor:pointer;padding:0}',
    '#pl-root .pl-min:hover{background:rgba(255,255,255,.08);color:#e5e7eb}',
    '#pl-root .pl-body{padding:6px}',
    '#pl-root.pl-collapsed .pl-body{display:none}',
    '#pl-root .pl-item{border-radius:8px;padding:4px 4px 4px 6px}',
    '#pl-root .pl-item:hover{background:rgba(255,255,255,.045)}',
    '#pl-root .pl-row{display:flex;align-items:center;gap:7px;min-height:26px}',
    '#pl-root .pl-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#6b7280;box-shadow:0 0 0 3px rgba(107,114,128,.18)}',
    '#pl-root .pl-dot.on{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.20)}',
    '#pl-root .pl-dot.err{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.20)}',
    '#pl-root .pl-name{flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d8dbe3}',
    '#pl-root .pl-name.pl-off{color:#6f7683}',
    '#pl-root .pl-btn{flex:none;height:22px;padding:0 9px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e5e7eb;transition:background .12s ease,border-color .12s ease,opacity .12s ease;white-space:nowrap}',
    '#pl-root .pl-btn:hover:not(:disabled){background:rgba(255,255,255,.13)}',
    '#pl-root .pl-btn.pl-go{border-color:rgba(59,130,246,.55);background:rgba(37,99,235,.26);color:#bfdbfe}',
    '#pl-root .pl-btn.pl-go:hover:not(:disabled){background:rgba(37,99,235,.42)}',
    '#pl-root .pl-btn.pl-halt{border-color:rgba(239,68,68,.42);background:rgba(239,68,68,.16);color:#fca5a5}',
    '#pl-root .pl-btn.pl-halt:hover:not(:disabled){background:rgba(239,68,68,.28)}',
    '#pl-root .pl-btn:disabled{opacity:.45;cursor:default}',
    '#pl-root .pl-msg{display:none;margin:1px 0 3px 15px;font-size:10.5px;line-height:1.4;color:#f87171;word-break:break-word}',
    '#pl-root .pl-msg.show{display:block}',
    '#pl-root .pl-foot{display:flex;align-items:center;gap:6px;padding:4px 6px 2px;border-top:1px solid rgba(255,255,255,.06);margin-top:4px;min-height:18px}',
    '#pl-root .pl-hint{flex:1;font-size:10px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#pl-root .pl-hint.pl-bad{color:#f87171}',
    '#pl-root .pl-reload{flex:none;border:0;background:transparent;color:#6b7280;font-size:10px;cursor:pointer;padding:1px 3px;border-radius:4px}',
    '#pl-root .pl-reload:hover{color:#d1d5db;background:rgba(255,255,255,.07)}',
  ].join('\n')

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  var root = el('div')
  root.id = 'pl-root'

  var card = el('div', 'pl-card')
  var head = el('div', 'pl-head')
  var totalDot = el('span', 'pl-dot-total')
  var title = el('span', 'pl-title', '桌宠启动器')
  var minBtn = el('button', 'pl-min', '–')
  minBtn.type = 'button'
  minBtn.title = '折叠 / 展开'
  head.appendChild(totalDot)
  head.appendChild(title)
  head.appendChild(minBtn)

  var body = el('div', 'pl-body')
  var rows = el('div', 'pl-rows')
  var foot = el('div', 'pl-foot')
  var hint = el('span', 'pl-hint', '连接中…')
  var reload = el('button', 'pl-reload', '刷新')
  reload.type = 'button'
  foot.appendChild(hint)
  foot.appendChild(reload)

  body.appendChild(rows)
  body.appendChild(foot)
  card.appendChild(head)
  card.appendChild(body)
  root.appendChild(card)

  var styleNode = el('style')
  styleNode.textContent = style
  ;(document.head || document.documentElement).appendChild(styleNode)

  function mount() {
    var host = document.body || document.documentElement
    if (!host) {
      window.setTimeout(mount, 60)
      return
    }
    host.appendChild(root)
    restoreState()
    refresh()
    schedulePoll()
  }

  // ————————————————— 折叠 / 位置 —————————————————
  var collapsed = lsGet(COLLAPSE_KEY) === '1'
  function applyCollapsed() {
    if (collapsed) root.classList.add('pl-collapsed')
    else root.classList.remove('pl-collapsed')
    minBtn.textContent = collapsed ? '+' : '–'
    schedulePoll()
  }

  function restoreState() {
    var raw = lsGet(POS_KEY)
    if (raw) {
      try {
        var pos = JSON.parse(raw)
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
          setPos(pos.left, pos.top)
        }
      } catch (e) {}
    }
    applyCollapsed()
  }

  function setPos(left, top) {
    var w = root.offsetWidth || 236
    var h = root.offsetHeight || 120
    var maxLeft = Math.max(0, (window.innerWidth || 1280) - w - 4)
    var maxTop = Math.max(0, (window.innerHeight || 720) - h - 4)
    var x = Math.min(Math.max(0, left), maxLeft)
    var y = Math.min(Math.max(0, top), maxTop)
    root.style.left = x + 'px'
    root.style.top = y + 'px'
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    return { left: x, top: y }
  }

  minBtn.addEventListener('click', function (ev) {
    ev.stopPropagation()
    collapsed = !collapsed
    lsSet(COLLAPSE_KEY, collapsed ? '1' : '0')
    applyCollapsed()
    refresh()
  })

  reload.addEventListener('click', function () {
    refresh()
  })

  // 拖动（只认标题栏，不抢按钮）
  var drag = null
  head.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0) return
    if (ev.target === minBtn) return
    var box = root.getBoundingClientRect()
    drag = { dx: ev.clientX - box.left, dy: ev.clientY - box.top }
    head.classList.add('pl-dragging')
    document.addEventListener('mousemove', onDragMove, true)
    document.addEventListener('mouseup', onDragUp, true)
    ev.preventDefault()
  })
  function onDragMove(ev) {
    if (!drag) return
    setPos(ev.clientX - drag.dx, ev.clientY - drag.dy)
  }
  function onDragUp() {
    if (!drag) return
    drag = null
    head.classList.remove('pl-dragging')
    document.removeEventListener('mousemove', onDragMove, true)
    document.removeEventListener('mouseup', onDragUp, true)
    var box = root.getBoundingClientRect()
    lsSet(POS_KEY, JSON.stringify({ left: Math.round(box.left), top: Math.round(box.top) }))
  }
  window.addEventListener('resize', function () {
    if (!root.style.left) return
    var box = root.getBoundingClientRect()
    setPos(box.left, box.top)
  })

  // ————————————————— 轮询 —————————————————
  var pollTimer = 0
  var polling = false
  function schedulePoll() {
    if (pollTimer) {
      window.clearTimeout(pollTimer)
      pollTimer = 0
    }
    var delay = collapsed ? POLL_CLOSED_MS : POLL_OPEN_MS
    pollTimer = window.setTimeout(function () {
      pollTimer = 0
      refresh().then(schedulePoll, schedulePoll)
    }, delay)
  }

  function setHint(text, bad) {
    hint.textContent = text
    if (bad) hint.classList.add('pl-bad')
    else hint.classList.remove('pl-bad')
  }

  // ————————————————— 渲染 —————————————————
  var rowMap = {} // id -> { item, dot, name, btn, msg, running, busy, enabled, kind }
  // 本地点一下失败的原因要留到下一次操作/状态变化为止 —— 否则 250ms 后的状态轮询一刷就不见了
  var actionError = {}
  var lastFailure = ''

  function buildRow(pet) {
    var item = el('div', 'pl-item')
    var row = el('div', 'pl-row')
    var dot = el('span', 'pl-dot')
    var name = el('span', 'pl-name', pet.label)
    var btn = el('button', 'pl-btn')
    btn.type = 'button'
    row.appendChild(dot)
    row.appendChild(name)
    row.appendChild(btn)
    var msg = el('div', 'pl-msg')
    item.appendChild(row)
    item.appendChild(msg)

    btn.addEventListener('click', function () {
      var current = rowMap[pet.id]
      if (!current || current.busy) return
      act(pet.id, current.running, btn)
    })

    rowMap[pet.id] = {
      item: item,
      row: row,
      dot: dot,
      name: name,
      btn: btn,
      msg: msg,
      running: false,
      busy: false,
      enabled: pet.enabled !== false,
      kind: pet.kind,
    }
    rows.appendChild(item)
  }

  function labelFor(kind, running) {
    if (kind === 'dshpet') return running ? '隐藏' : '显示'
    return running ? '结束' : '启动'
  }

  function paintRow(pet) {
    var r = rowMap[pet.id]
    if (!r) return
    var running = pet.running === true
    var unknown = pet.running === null || pet.running === undefined
    r.running = running
    r.enabled = pet.enabled !== false
    r.kind = pet.kind

    if (r.busy) {
      r.dot.className = 'pl-dot'
      r.btn.disabled = true
      r.btn.textContent = '…'
      return
    }

    var err = actionError[pet.id] || pet.error || ''
    r.dot.className = 'pl-dot' + (err ? ' err' : running ? ' on' : '')
    r.name.className = 'pl-name' + (r.enabled ? '' : ' pl-off')
    r.name.textContent = pet.label
    r.name.title = pet.label

    r.msg.className = err ? 'pl-msg show' : 'pl-msg'
    r.msg.textContent = err

    var tip = pet.label
    if (err) tip += '\n⚠ ' + err
    if (pet.pid) tip += '\npid ' + pet.pid + (pet.source === 'scan' ? '（扫描认出，不是本插件起的）' : '')
    if (pet.kind === 'dshpet') {
      if (pet.display) tip += '\ndisplay = ' + pet.display
      if (pet.helperRunning === false) tip += '\n桌面 helper（electron.exe）没在跑'
      if (pet.helperRunning === true) tip += '\n桌面 helper 在跑'
    }
    r.item.title = tip

    if (!r.enabled) {
      r.btn.disabled = true
      r.btn.textContent = '已禁用'
      r.btn.className = 'pl-btn'
      return
    }
    if (unknown) {
      r.btn.disabled = true
      r.btn.textContent = '状态未知'
      r.btn.className = 'pl-btn'
      return
    }
    r.btn.disabled = false
    r.btn.textContent = labelFor(pet.kind, running)
    r.btn.className = 'pl-btn ' + (running ? 'pl-halt' : 'pl-go')
    r.btn.title = pet.kind === 'dshpet'
      ? (running ? '把 dsh-pet 桌面桌宠隐藏（display → none）' : '把 dsh-pet 桌面桌宠显示出来（display → desktop）')
      : (running ? '结束这只桌宠' : '启动这只桌宠')
  }

  function render(data) {
    var pets = data && Array.isArray(data.pets) ? data.pets : []
    // 先按服务端顺序补齐/删除行
    var seen = {}
    for (var i = 0; i < pets.length; i++) {
      var pet = pets[i]
      seen[pet.id] = true
      if (!rowMap[pet.id]) buildRow(pet)
    }
    Object.keys(rowMap).forEach(function (id) {
      if (!seen[id]) {
        var r = rowMap[id]
        if (r && r.item && r.item.parentNode) r.item.parentNode.removeChild(r.item)
        delete rowMap[id]
      }
    })
    var runningCount = 0
    for (var j = 0; j < pets.length; j++) {
      paintRow(pets[j])
      if (pets[j].running === true) runningCount++
    }
    totalDot.className = 'pl-dot-total' + (runningCount ? ' on' : '')
    title.textContent = '桌宠启动器' + (runningCount ? ' · ' + runningCount + ' 在跑' : '')
    setHint(lastFailure ? '操作失败：' + lastFailure : pets.length + ' 只 · ' + (collapsed ? '已折叠' : '点名称看详情'), !!lastFailure)
  }

  function renderFatal(errText) {
    var text = String(errText || '接口不可用')
    setHint(text, true)
    hint.title = text
    Object.keys(rowMap).forEach(function (id) {
      var r = rowMap[id]
      r.dot.className = 'pl-dot err'
      r.msg.className = 'pl-msg show'
      r.msg.textContent = text
      r.item.title = text
      r.btn.disabled = true
    })
    totalDot.className = 'pl-dot-total'
  }

  // ————————————————— 网络 —————————————————
  function request(pathname, method) {
    return fetch(API + pathname, {
      method: method || 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch (e) {}
        if (!res.ok) {
          var detail = (json && (json.error || json.message)) || text || res.statusText
          var err = new Error('HTTP ' + res.status + '：' + String(detail).slice(0, 300))
          err.payload = json
          throw err
        }
        return json || {}
      })
    })
  }

  function refresh() {
    if (polling) return Promise.resolve()
    polling = true
    return request('/status')
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error((data && data.error) || 'status 返回异常')
        render(data)
        return data
      })
      .catch(function (err) {
        renderFatal(err && err.message ? err.message : err)
      })
      .then(function () {
        polling = false
      })
  }

  function act(id, running, btn) {
    var r = rowMap[id]
    if (!r) return
    var path = running ? '/stop' : '/start'
    delete actionError[id]
    lastFailure = ''
    r.busy = true
    r.btn.disabled = true
    r.btn.textContent = '…'
    setHint(running ? '正在结束…' : '正在拉起…', false)

    request(path + '?id=' + encodeURIComponent(id), 'POST')
      .then(function (data) {
        if (data && data.ok === false) throw new Error(data.error || '操作失败')
        delete actionError[id]
        lastFailure = ''
        r.busy = false
        var pet = data && data.pet
        if (pet && pet.id === id) {
          if (!rowMap[id]) buildRow(pet)
          paintRow(pet)
        }
        setHint((data && data.already ? '本来就是这个状态' : '已' + (running ? '结束' : '启动')) + '：' + id, false)
      })
      .catch(function (err) {
        var text = err && err.message ? err.message : String(err)
        // 行内可见：红点 + 错误文本（不只在 console 里报），并留到下一次操作
        actionError[id] = text
        lastFailure = text
        r.busy = false
        r.btn.disabled = r.enabled === false
        r.dot.className = 'pl-dot err'
        r.msg.className = 'pl-msg show'
        r.msg.textContent = text
        r.item.title = text
        r.btn.textContent = labelFor(r.kind, running)
        r.btn.className = 'pl-btn ' + (running ? 'pl-halt' : 'pl-go')
        setHint('操作失败：' + text, true)
      })
      .then(function () {
        // 「1 秒内刷新状态」：立刻补一次，2.5 秒后再补一次（桌宠起得慢）。
        // 刷新只更新"在跑/没跑"那一半，actionError 会一直留到下次点按钮。
        window.setTimeout(refresh, 250)
        window.setTimeout(refresh, 2500)
      })
  }

  mount()
})()
