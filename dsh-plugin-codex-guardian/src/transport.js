/**
 * Dependency-free HTTPS transport for the codex-auto-review route.
 *
 * Node's `fetch` only reaches the internet here when the host process installed a
 * proxy dispatcher (`@deepseek-ai/dsh-http-proxy` does that from the launch
 * environment). A plain direct `fetch` to `chatgpt.com` on this machine gets
 * ECONNREFUSED. So this module implements the same manual CONNECT tunnel the
 * reference probe uses, and treats the host's own proxy routing as the preferred
 * path when it is available:
 *
 *   auto   — use the host dispatcher when it says the URL is proxied, otherwise
 *            tunnel through `proxy`, and fall back to a direct `fetch` if the
 *            tunnel cannot even be established.
 *   tunnel — always tunnel through `proxy`.
 *   fetch  — always use the ambient `fetch` (host dispatcher / direct).
 *
 * Every request is bounded by a timeout and by the caller's AbortSignal.
 *
 * @module dsh-plugin-codex-guardian/transport
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

/** Default host:port of the local CONNECT proxy. */
export const DEFAULT_PROXY = { host: '127.0.0.1', port: 7897 }

/**
 * Is this error "the proxy/network is not there", i.e. worth a different route?
 * @param {unknown} error
 * @returns {boolean}
 */
function isConnectionError(error) {
  const code = /** @type {{code?: string}} */ (error)?.code
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  )
}

/** @param {import('node:events').EventEmitter} emitter */
function destroyQuietly(emitter) {
  try {
    emitter?.destroy?.()
  } catch {
    /* already gone */
  }
}

export class TransportError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'TransportError'
    this.code = details.code
    if (details.cause !== undefined) this.cause = details.cause
  }
}

/**
 * Build a transport bound to one proxy / timeout policy.
 *
 * @param {{mode?: 'auto'|'tunnel'|'fetch', proxy?: {host?: string, port?: number},
 *   timeoutMs?: number, logger?: {debug?: Function, warn?: Function}}} [config]
 */
export function createTransport(config = {}) {
  const mode = config.mode ?? 'auto'
  const proxy = { ...DEFAULT_PROXY, ...(config.proxy ?? {}) }
  const timeoutMs = config.timeoutMs ?? 20_000
  /** Cached answer to "does the host have a proxy dispatcher installed?". */
  let hostRoute
  let hostRouteProbed = false

  /**
   * Ask `@deepseek-ai/dsh-http-proxy` whether the host would proxy this URL. The
   * package is optional: a profile may not expose it to plugin resolution.
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async function hostProxies(url) {
    if (hostRouteProbed) return hostRoute === true
    hostRouteProbed = true
    hostRoute = false
    try {
      const mod = await import('@deepseek-ai/dsh-http-proxy')
      const route = mod?.proxyRouteFor?.(new URL(url))
      hostRoute = route?.proxied === true
    } catch {
      hostRoute = false
    }
    return hostRoute === true
  }

  /**
   * One request through the ambient `fetch`.
   * @param {{url: string, method: string, headers: Record<string,string>, body?: string, signal?: AbortSignal}} req
   */
  async function fetchSend(req) {
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: req.signal,
        redirect: 'follow',
      })
      const body = await response.text()
      const headers = {}
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      return { status: response.status, headers, body }
    } catch (error) {
      throw new TransportError(`fetch failed: ${error?.message ?? error}`, {
        code: error?.code ?? error?.cause?.code,
        cause: error,
      })
    }
  }

  /**
   * One request through a hand-built CONNECT tunnel.
   * @param {{url: string, method: string, headers: Record<string,string>, body?: string, signal?: AbortSignal}} req
   */
  async function tunnelSend(req) {
    const target = new URL(req.url)
    const host = target.hostname
    const port = target.port === '' ? 443 : Number(target.port)

    const tunnelSocket = await new Promise((resolve, reject) => {
      const connect = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: { Host: `${host}:${port}` },
        timeout: timeoutMs,
      })
      const fail = (error) => {
        destroyQuietly(connect)
        reject(
          error instanceof TransportError
            ? error
            : new TransportError(`proxy CONNECT failed: ${error?.message ?? error}`, {
                code: error?.code,
                cause: error,
              }),
        )
      }
      connect.on('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          destroyQuietly(socket)
          fail(new TransportError(`proxy CONNECT ${response.statusCode}`))
          return
        }
        resolve(socket)
      })
      connect.on('timeout', () => fail(new TransportError('proxy CONNECT timed out', { code: 'ETIMEDOUT' })))
      connect.on('error', fail)
      connect.end()
    })

    const secured = tls.connect({ socket: tunnelSocket, servername: host, ALPNProtocols: ['http/1.1'] })
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        destroyQuietly(secured)
        destroyQuietly(tunnelSocket)
        reject(new TransportError(`TLS handshake failed: ${error?.message ?? error}`, { code: error?.code, cause: error }))
      }
      secured.once('secureConnect', resolve)
      secured.once('error', fail)
      secured.once('timeout', () => fail(new TransportError('TLS handshake timed out', { code: 'ETIMEDOUT' })))
    })

    return await new Promise((resolve, reject) => {
      const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
      const originalCreate = agent.createConnection.bind(agent)
      let handed = false
      agent.createConnection = (...args) => {
        if (handed) return originalCreate(...args)
        handed = true
        return secured
      }
      const request = https.request(
        { host, port, path: `${target.pathname}${target.search}`, method: req.method, headers: req.headers, agent },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            destroyQuietly(secured)
            destroyQuietly(tunnelSocket)
            resolve({
              status: response.statusCode ?? 0,
              headers: /** @type {Record<string,string>} */ (response.headers),
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
          response.on('error', (error) => {
            destroyQuietly(secured)
            reject(new TransportError(`response failed: ${error?.message ?? error}`, { code: error?.code, cause: error }))
          })
        },
      )
      const fail = (error) => {
        destroyQuietly(request)
        destroyQuietly(secured)
        destroyQuietly(tunnelSocket)
        reject(
          error instanceof TransportError
            ? error
            : new TransportError(`request failed: ${error?.message ?? error}`, { code: error?.code, cause: error }),
        )
      }
      request.on('error', fail)
      request.on('timeout', () => fail(new TransportError('request timed out', { code: 'ETIMEDOUT' })))
      if (req.signal !== undefined) {
        if (req.signal.aborted) {
          fail(new TransportError('request aborted', { code: 'ABORT_ERR' }))
          return
        }
        req.signal.addEventListener(
          'abort',
          () => fail(new TransportError('request aborted', { code: 'ABORT_ERR' })),
          { once: true },
        )
      }
      if (req.body !== undefined) request.write(req.body)
      request.end()
    })
  }

  return {
    /** Effective mode for one URL, after the host-proxy probe. */
    async route(url) {
      if (mode !== 'auto') return mode
      return (await hostProxies(url)) ? 'fetch' : 'tunnel'
    },
    /**
     * Perform one request.
     * @param {{url: string, method?: string, headers?: Record<string,string>,
     *   body?: string, signal?: AbortSignal, timeoutMs?: number}} request
     * @returns {Promise<{status: number, headers: Record<string,string>, body: string, route: string}>}
     */
    async request(request) {
      const url = request.url
      const timeout = request.timeoutMs ?? timeoutMs
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new TransportError(`timed out after ${timeout}ms`, { code: 'ETIMEDOUT' })), timeout)
      const signal =
        request.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, request.signal])
      const common = {
        url,
        method: request.method ?? 'GET',
        headers: request.headers ?? {},
        body: request.body,
        signal,
      }
      const chosen = await this.route(url)
      try {
        if (chosen === 'fetch') return { ...(await fetchSend(common)), route: 'fetch' }
        try {
          return { ...(await tunnelSend(common)), route: 'tunnel' }
        } catch (error) {
          if (mode !== 'auto' || !isConnectionError(error)) throw error
          config.logger?.debug?.(`codex-guardian: tunnel unavailable (${error?.code ?? error?.message}); trying direct fetch`)
          return { ...(await fetchSend(common)), route: 'fetch-direct' }
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Parse one buffered SSE body into its `data:` payloads.
 * @param {string} body
 * @returns {string[]} payload strings, in order, `[DONE]` removed.
 */
export function parseSse(body) {
  const payloads = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    payloads.push(payload)
  }
  return payloads
}
