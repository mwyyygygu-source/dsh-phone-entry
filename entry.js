// 固定入口页逻辑：零依赖 ES module，浏览器直接加载，Node 测试直接 import。
// 这里只做“记住地址 → 读小 gist 拿当前公网地址 → 跳登录页”的编排，
// 不保存任何秘密；长期凭据 bt 只留在本页 origin 的 localStorage 里。
//
// 公开托管的页面：任何动态内容都要经过 escapeHtml 才能进 innerHTML；
// 本文件里所有状态文案都走 textContent。

export const GIST_PREFIX = 'https://gist.githubusercontent.com/'
export const STORAGE_KEY = 'dsh-browser-entry'
export const LAST_HOST_PROBE_MS = 8000
export const GIST_HOST_PROBE_MS = 15000
export const GIST_FETCH_TIMEOUT_MS = 8000
export const RETRY_INTERVAL_MS = 20_000
export const MAX_RETRIES = 10

const WHITESPACE = /[\s\u0000-\u001f\u007f]/

/**
 * 保存的打开方式：只认 'desktop'，其余（缺省、非法值）都回落 'phone'。
 */
export function normalizeMode(value) {
  return String(value || '').trim().toLowerCase() === 'desktop' ? 'desktop' : 'phone'
}

/**
 * fragment 里的 m：只认 phone/desktop；没带或非法返回空串，
 * 这样“恢复上次连接”时不会把用户已保存的电脑版覆盖回手机版。
 */
export function fragmentMode(value) {
  const text = String(value || '').trim().toLowerCase()
  return text === 'phone' || text === 'desktop' ? text : ''
}

/** 解析 location.hash（可带可不带 #）。 */
export function parseFragment(hash) {
  const empty = { g: '', c: '', bt: '', fresh: false, m: '' }
  const raw = String(hash || '').replace(/^#/, '').trim()
  if (!raw) return empty
  let params
  try {
    params = new URLSearchParams(raw)
  } catch {
    return empty
  }
  const read = (key) => {
    const value = params.get(key)
    return typeof value === 'string' ? value.trim() : ''
  }
  return {
    g: read('g'),
    c: read('c'),
    bt: read('bt'),
    fresh: read('fresh') === '1',
    m: fragmentMode(read('m')),
  }
}

/** 只接受 gist raw 的 https 地址；其他一律当没填。 */
export function sanitizeGistUrl(value) {
  const text = String(value || '').trim()
  if (!text || WHITESPACE.test(text)) return ''
  if (!text.toLowerCase().startsWith(GIST_PREFIX)) return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return ''
    if (url.hostname !== 'gist.githubusercontent.com') return ''
    return url.href
  } catch {
    return ''
  }
}

/** 从 gist 的 JSON（对象或文本）里取 host，必须是 https 公网源。 */
export function hostFromGistPayload(payload) {
  let data = payload
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return ''
    }
  }
  if (!data || typeof data !== 'object') return ''
  return normalizeHost(data.host)
}

/** 规范成 https origin；非法/本地地址返回空串。 */
export function normalizeHost(value) {
  const text = String(value || '').trim()
  if (!text || WHITESPACE.test(text)) return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return ''
    if (!url.hostname || !url.hostname.includes('.')) return ''
    if (url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

/** gist raw 有 CDN 缓存，读的时候加个时间戳绕开。 */
export function gistFetchUrl(gistUrl, now = Date.now()) {
  const base = String(gistUrl || '')
  const stamp = Number(now)
  const value = Number.isFinite(stamp) ? stamp : Date.now()
  return `${base}${base.includes('?') ? '&' : '?'}t=${value}`
}

export function loginUrl(host, { code = '', token = '', mode = '' } = {}) {
  const origin = normalizeHost(host)
  if (!origin) return ''
  // 电脑版由隧道登录页决定最终目的地；码登录以后会回到入口页，仍带上无害。
  const suffix = normalizeMode(mode) === 'desktop' ? '&m=desktop' : ''
  if (code) {
    return `${origin}/phone/browser-login#c=${encodeURIComponent(String(code))}${suffix}`
  }
  if (token) {
    return `${origin}/phone/browser-login#t=${encodeURIComponent(String(token))}${suffix}`
  }
  return ''
}

export function appUrl(host) {
  const origin = normalizeHost(host)
  return origin ? `${origin}/phone/app/` : ''
}

/** dsh 自带的电脑版完整界面（同源，不需要额外的鉴权）。 */
export function desktopUrl(host) {
  const origin = normalizeHost(host)
  return origin ? `${origin}/pair-app` : ''
}

/** 自动重试节拍：返回下一次的 attempt 与等待时间；超过上限返回 null。 */
export function nextRetry(attempt, { max = MAX_RETRIES, intervalMs = RETRY_INTERVAL_MS } = {}) {
  const current = Math.max(0, Math.floor(Number(attempt) || 0))
  if (current >= Math.max(0, Math.floor(Number(max) || 0))) return null
  return { attempt: current + 1, delayMs: Math.max(0, Number(intervalMs) || 0) }
}

/**
 * CORS 探测 `<host>/phone/hello`：只有拿到 2xx 才算在线（530/断网/超时都是 false）。
 * 超时（默认 4 秒）或网络错误返回 false，绝不抛错。
 */
export async function probeHost(fetchImpl, host, {
  timeoutMs = LAST_HOST_PROBE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const origin = normalizeHost(host)
  if (!origin || typeof fetchImpl !== 'function') return false
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => {
      if (controller) {
        try {
          controller.abort()
        } catch {
          // 忽略。
        }
      }
      resolve(false)
    }, Math.max(0, Number(timeoutMs) || 0))
  })
  const request = (async () => {
    try {
      // 必须是能读状态的 CORS 请求：no-cors 下 Cloudflare 的 530 错误页也算“有响应”，
      // 会把已经失效的旧隧道地址误判成在线。
      const response = await fetchImpl(`${origin}/phone/hello`, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller ? controller.signal : undefined,
      })
      return !!response && response.ok === true
    } catch {
      return false
    }
  })()
  const ok = await Promise.race([request, timeout])
  if (timer !== null) clearTimeoutFn(timer)
  return ok === true
}

export function readState(storage) {
  const empty = { g: '', bt: '', lastHost: '', mode: 'phone' }
  if (!storage || typeof storage.getItem !== 'function') return empty
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return empty
    return {
      g: sanitizeGistUrl(data.g),
      bt: typeof data.bt === 'string' ? data.bt : '',
      lastHost: normalizeHost(data.lastHost),
      mode: normalizeMode(data.mode),
    }
  } catch {
    return empty
  }
}

export function writeState(storage, state) {
  if (!storage || typeof storage.setItem !== 'function') return false
  const value = state && typeof state === 'object' ? state : {}
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      g: sanitizeGistUrl(value.g),
      bt: typeof value.bt === 'string' ? value.bt : '',
      lastHost: normalizeHost(value.lastHost),
      mode: normalizeMode(value.mode),
    }))
    return true
  } catch {
    return false
  }
}

/** 接受整条连接、带 # 的 fragment 或裸参数串。 */
export function parsePastedLink(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const index = raw.indexOf('#')
  const fragment = index >= 0 ? raw.slice(index + 1) : raw.replace(/^#/, '')
  const parsed = parseFragment(fragment)
  return parsed.g || parsed.c || parsed.bt ? parsed : null
}

/** 这次打开入口页应该走哪条路。 */
export function entryIntent(fragment, state = {}) {
  const saved = state && typeof state === 'object' ? state : {}
  const incoming = fragment && typeof fragment === 'object' ? fragment : {}
  const g = sanitizeGistUrl(incoming.g) || sanitizeGistUrl(saved.g)
  if (incoming.c) return { kind: 'code', code: incoming.c, token: '', g }
  if (incoming.bt) {
    return { kind: incoming.fresh ? 'fresh' : 'token', code: '', token: incoming.bt, g }
  }
  if (saved.bt) return { kind: 'resume', code: '', token: saved.bt, g }
  return { kind: 'input', code: '', token: '', g }
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(
    /[&<>"']/g,
    (char) => HTML_ESCAPES[char],
  )
}

// ---------------------------------------------------------------------------
// 浏览器侧编排。Node 测试只 import 上面的纯函数，不会执行到这里。
// ---------------------------------------------------------------------------

function safeStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function boot() {
  const titleNode = document.getElementById('title')
  const messageNode = document.getElementById('message')
  const hintNode = document.getElementById('hint')
  const retryButton = document.getElementById('retry')
  const pasteForm = document.getElementById('paste')
  const linkInput = document.getElementById('link')
  if (!titleNode || !messageNode || !hintNode || !retryButton || !pasteForm || !linkInput) return

  const modeButtons = Array.from(document.querySelectorAll('[data-mode]'))

  const storage = safeStorage()
  let state = readState(storage)
  let attempt = 0
  let timer = null
  let activeRun = 0
  let action = null
  let retryHandler = null
  let restartFlow = null

  function syncMode() {
    for (const button of modeButtons) {
      const on = button.dataset.mode === state.mode
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
  }

  function chooseMode(mode) {
    if (mode !== 'phone' && mode !== 'desktop') return
    if (state.mode === mode) return
    state = { ...state, mode }
    writeState(storage, state)
    syncMode()
    // 重新开始当前流程；activeRun 会让之前那一次运行自然失效，避免并发。
    if (typeof restartFlow === 'function') void restartFlow()
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function setRetryHandler(fn) {
    retryHandler = typeof fn === 'function' ? fn : null
    retryButton.hidden = !retryHandler
  }

  function setView({ heading, text, hint = '', tone = '', paste = false, onRetry = null }) {
    titleNode.textContent = heading
    messageNode.textContent = text
    hintNode.textContent = hint
    hintNode.hidden = !hint
    hintNode.className = tone === 'bad' ? 'hint is-bad' : 'hint'
    document.body.dataset.tone = tone
    pasteForm.hidden = !paste
    setRetryHandler(onRetry)
  }

  function showInput(text) {
    clearTimer()
    activeRun += 1
    restartFlow = null
    setView({
      heading: '打开手机里的连接',
      text: text || '请在手机 App 的设置里点“添加浏览器”，把连接粘贴到这里打开。',
      paste: true,
    })
    setTimeout(() => {
      try {
        linkInput.focus()
      } catch {
        // 忽略。
      }
    }, 0)
  }

  function go(url) {
    if (!url) {
      setView({
        heading: '地址不可用',
        text: '这条连接里的电脑地址无效，请回手机重新生成连接。',
        tone: 'bad',
        paste: true,
      })
      return
    }
    setView({ heading: '正在打开…', text: '马上就好。' })
    try {
      location.replace(url)
    } catch {
      location.href = url
    }
  }

  async function readGist(gistUrl) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let fetchTimer = null
    if (controller) fetchTimer = setTimeout(() => controller.abort(), GIST_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(gistFetchUrl(gistUrl, Date.now()), {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller ? controller.signal : undefined,
      })
      if (!response || !response.ok) return ''
      return hostFromGistPayload(await response.text())
    } catch {
      return ''
    } finally {
      if (fetchTimer !== null) clearTimeout(fetchTimer)
    }
  }

  function scheduleRetry() {
    clearTimer()
    const next = nextRetry(attempt)
    if (!next) {
      setView({
        heading: '还没连上电脑',
        text: '入口地址可能还没更新。可以稍后再点“重试”，或回手机重新生成连接。',
        hint: `已经自动重试 ${MAX_RETRIES} 次。`,
        tone: 'warn',
        paste: true,
        onRetry: () => {
          attempt = 0
          void runResolve()
        },
      })
      return
    }
    attempt = next.attempt
    const seconds = Math.round(next.delayMs / 1000)
    setView({
      heading: '地址可能还没更新',
      text: `正在等电脑的地址生效，${seconds} 秒后自动重试（${attempt}/${MAX_RETRIES}）。`,
      hint: '如果一直不行，回手机上重新“添加浏览器”。',
      tone: 'warn',
      paste: true,
      onRetry: () => {
        attempt = 0
        void runResolve()
      },
    })
    timer = setTimeout(() => {
      timer = null
      void runResolve()
    }, next.delayMs)
  }

  async function runResolve() {
    const id = ++activeRun
    clearTimer()
    if (!state.g) {
      setView({
        heading: '需要新的连接',
        text: '找不到入口地址，请在手机上重新“添加浏览器”，把连接粘贴到这里。',
        tone: 'warn',
        paste: true,
      })
      return
    }
    setView({ heading: '正在连接…', text: '正在读取电脑的当前地址。' })
    let host = ''
    try {
      host = await readGist(state.g)
    } catch {
      host = ''
    }
    if (id !== activeRun) return
    if (host) {
      setView({ heading: '正在连接…', text: '正在确认电脑是否在线。' })
      const ok = await probeHost(fetch, host, { timeoutMs: GIST_HOST_PROBE_MS })
      if (id !== activeRun) return
      if (!ok) host = ''
    }
    if (host) {
      state = { ...state, lastHost: host }
      writeState(storage, state)
      if (typeof action === 'function') action(host)
      return
    }
    scheduleRetry()
  }

  function resolveWithRetry(useHost) {
    action = useHost
    attempt = 0
    return runResolve()
  }

  function enterApp(host) {
    return state.mode === 'desktop' ? desktopUrl(host) : appUrl(host)
  }

  async function startCodeLogin(code) {
    if (!state.g) {
      setView({
        heading: '连接不完整',
        text: '这条连接缺少入口地址，请在手机上重新生成连接。',
        tone: 'bad',
        paste: true,
      })
      return
    }
    await resolveWithRetry((host) => go(loginUrl(host, { code, mode: state.mode })))
  }

  async function startTokenLogin() {
    const id = ++activeRun
    clearTimer()
    if (!state.bt) {
      showInput('登录状态已失效，请在手机上重新“添加浏览器”，把连接粘贴到这里打开。')
      return
    }
    if (state.lastHost) {
      setView({ heading: '正在连接…', text: '正在确认上次的电脑地址。' })
      const ok = await probeHost(fetch, state.lastHost, { timeoutMs: LAST_HOST_PROBE_MS })
      if (id !== activeRun) return
      if (ok) {
        go(loginUrl(state.lastHost, { token: state.bt, mode: state.mode }))
        return
      }
    }
    if (!state.g) {
      setView({
        heading: '登录已失效',
        text: '找不到电脑地址，请在手机上重新“添加浏览器”，把连接粘贴到这里。',
        tone: 'warn',
        paste: true,
      })
      return
    }
    await resolveWithRetry((host) => go(loginUrl(host, { token: state.bt, mode: state.mode })))
  }

  async function startFresh() {
    // 登录页刚在这个 host 上写了 cookie，直接进已选好的界面即可。
    if (state.lastHost) {
      go(enterApp(state.lastHost))
      return
    }
    if (!state.g) {
      setView({
        heading: '登录成功',
        text: '但找不到电脑地址，请回手机重新“添加浏览器”。',
        tone: 'warn',
        paste: true,
      })
      return
    }
    await resolveWithRetry((host) => go(enterApp(host)))
  }

  async function handleFragment(fragment) {
    activeRun += 1
    clearTimer()
    const intent = entryIntent(fragment, state)

    // fragment 里的 m 优先于已保存的 mode；没带/非法则不覆盖已保存的选择。
    if (fragment.m === 'phone' || fragment.m === 'desktop') {
      state = { ...state, mode: fragment.m }
      writeState(storage, state)
      syncMode()
    }

    if (fragment.g) {
      const gist = sanitizeGistUrl(fragment.g)
      if (gist) {
        state = { ...state, g: gist }
      } else if (fragment.c) {
        setView({
          heading: '连接无效',
          text: '连接里的入口地址不是有效的 gist 地址，请从手机重新复制整条连接。',
          tone: 'bad',
          paste: true,
        })
        return
      }
    }
    if (fragment.bt) state = { ...state, bt: fragment.bt }
    writeState(storage, state)

    if (intent.kind === 'code') {
      restartFlow = () => handleFragment(fragment)
      return startCodeLogin(intent.code)
    }
    if (intent.kind === 'fresh') {
      restartFlow = () => handleFragment(fragment)
      return startFresh()
    }
    if (intent.kind === 'token' || intent.kind === 'resume') {
      restartFlow = () => handleFragment(fragment)
      return startTokenLogin()
    }
    restartFlow = null
    showInput('')
    return undefined
  }

  retryButton.addEventListener('click', () => {
    const handler = retryHandler
    if (handler) handler()
  })

  pasteForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const parsed = parsePastedLink(linkInput.value)
    if (!parsed) {
      setView({
        heading: '连接无法识别',
        text: '请粘贴手机生成的完整连接（以 https:// 开头，包含 #g= 和 #c=）。',
        tone: 'bad',
        paste: true,
      })
      return
    }
    linkInput.value = ''
    void handleFragment(parsed)
  })

  function takeFragment() {
    const parsed = parseFragment(location.hash)
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      // 个别 WebView 不允许改历史；hash 留着也不影响已经解析出的值。
    }
    return parsed
  }

  for (const button of modeButtons) {
    button.addEventListener('click', () => chooseMode(button.dataset.mode))
  }
  syncMode()

  const fragment = takeFragment()
  if (fragment.c || fragment.bt || fragment.g || fragment.m) {
    void handleFragment(fragment)
    return
  }
  if (state.bt) {
    restartFlow = () => startTokenLogin()
    void startTokenLogin()
    return
  }
  showInput('')
}

if (typeof document !== 'undefined' && document.getElementById('title')) {
  boot()
}
