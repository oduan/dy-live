// 在 Node 无头环境运行抖音 webmssdk.es5.js（byted_acrawler 提供者），
// 目标：调用 byted_acrawler.frontierSign(查询串) 生成 IM WSS 的 signature 参数。
// 思路：提供最小 window/document/navigator 桩，脚本对环境的探测失败应被其内部 try/catch 容忍。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

function makeEnv() {
  const noop = () => {}
  const elem = () => ({
    style: {},
    appendChild: noop,
    removeChild: noop,
    setAttribute: noop,
    getAttribute: () => null,
    getContext: () => ({
      fillText: noop,
      measureText: () => ({ width: 0 }),
      getImageData: () => ({ data: new Uint8Array(4) }),
      canvas: { toDataURL: () => '' },
      arc: noop,
      rect: noop,
      fill: noop,
      stroke: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
    }),
    addEventListener: noop,
    removeEventListener: noop,
    attachEvent: noop,
    detachEvent: noop,
    contentWindow: null,
  })
  const document = {
    cookie: '',
    referrer: '',
    title: '',
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    documentElement: elem(),
    head: elem(),
    body: elem(),
    createElement: elem,
    createTextNode: () => ({}),
    getElementsByTagName: () => [elem()],
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    attachEvent: noop,
  }
  const window = {
    location: {
      href: 'https://live.douyin.com/',
      protocol: 'https:',
      host: 'live.douyin.com',
      hostname: 'live.douyin.com',
      pathname: '/',
      search: '',
      hash: '',
      origin: 'https://live.douyin.com',
      reload: noop,
      toString: () => 'https://live.douyin.com/',
    },
    navigator: {
      userAgent: UA,
      appName: 'Netscape',
      appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh'],
      cookieEnabled: true,
      hardwareConcurrency: 16,
      deviceMemory: 8,
      maxTouchPoints: 0,
      plugins: { length: 0 },
      mimeTypes: { length: 0 },
      webdriver: false,
      doNotTrack: null,
      vendor: 'Google Inc.',
    },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    history: { length: 2, pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop },
    document,
    location: null, // 下面与 location 同引用
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    performance: { now: () => Date.now(), timing: { navigationStart: Date.now() - 1000 } },
    crypto: { getRandomValues: (a) => (a.forEach?.((_, i) => (a[i] = Math.floor(Math.random() * 256))), a) },
    addEventListener: noop,
    removeEventListener: noop,
    attachEvent: noop,
    detachEvent: noop,
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    cancelAnimationFrame: clearTimeout,
    XMLHttpRequest: function () {
      this.open = noop
      this.send = noop
      this.setRequestHeader = noop
      this.getAllResponseHeaders = () => ''
      this.getResponseHeader = () => null
      this.addEventListener = noop
    },
    fetch: () => Promise.reject(new Error('no-network-in-signer')),
    WebSocket: function () {
      this.close = noop
      this.send = noop
      this.addEventListener = noop
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    indexedDB: { open: () => ({}) },
    RTCPeerConnection: undefined,
    webkitRTCPeerConnection: undefined,
    canvas: undefined,
  }
  window.window = window
  window.top = window
  window.parent = window
  window.self = window
  window.globalThis = window
  window.location = window.location
  document.window = window
  return { window, document }
}

export function loadWebmssdk(scriptPath = 'webmssdk.es5.js') {
  const code = readFileSync(scriptPath, 'utf8')
  const { window, document } = makeEnv()
  const sandbox = { window, document, navigator: window.navigator, location: window.location, screen: window.screen, setTimeout, clearTimeout, setInterval, clearInterval }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  try {
    vm.runInContext(code, sandbox, { timeout: 15000 })
  } catch (e) {
    // 脚本尾部的采集逻辑失败不影响已挂载的签名函数；但顶层抛错可能导致初始化中断，需上报判断
    const err = new Error('webmssdk top-level error: ' + (e?.message ?? e))
    err.partial = true
    // 继续：检查 byted_acrawler 是否已挂载
  }
  const ba = sandbox.byted_acrawler || window.byted_acrawler
  return { window, byted_acrawler: ba }
}

export function frontierSign(qs) {
  const { byted_acrawler } = loadWebmssdk()
  if (!byted_acrawler || typeof byted_acrawler.frontierSign !== 'function') return null
  return byted_acrawler.frontierSign(qs)
}

// 直接运行：node sign_node.mjs "查询串"
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const qs = process.argv[2] || 'test=1'
  const t0 = Date.now()
  const { byted_acrawler } = loadWebmssdk()
  console.log('load ms:', Date.now() - t0)
  console.log('byted_acrawler keys:', byted_acrawler ? Object.keys(byted_acrawler) : null)
  if (byted_acrawler?.frontierSign) {
    const out = byted_acrawler.frontierSign(qs)
    console.log('frontierSign:', JSON.stringify(out))
  }
}
