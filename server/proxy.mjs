/**
 * 通知代理服务
 * 解决浏览器 CORS 限制：前端 → 本代理 → 钉钉/飞书/Slack Webhook
 * 
 * 启动方式：
 *   node server/proxy.mjs
 *   或通过 Docker 自动启动（见 Dockerfile）
 */

import http from 'http'
import https from 'https'
import { URL } from 'url'

const PORT = process.env.PROXY_PORT || 3001

// 允许代理的目标域名白名单
const ALLOWED_HOSTS = new Set([
  'oapi.dingtalk.com',
  'open.feishu.cn',
  'open.larksuite.com',
  'hooks.slack.com',
  'hooks.slack.com',
])

function proxyRequest(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl)
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        ...headers,
        'host': url.hostname,
      },
    }

    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        })
      })
    })

    req.on('error', (err) => {
      reject(err)
    })

    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

const server = http.createServer(async (req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 健康检查
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }))
    return
  }

  // 通用 CORS 代理：GET/POST /cors-proxy?url=<encoded_target_url>
  // 解决浏览器跨域限制，透传目标资源
  if (req.url.startsWith('/cors-proxy')) {
    try {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`)
      const targetUrl = reqUrl.searchParams.get('url')

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing url parameter' }))
        return
      }

      // 收集请求体（POST 时）
      let body = null
      if (req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        body = Buffer.concat(chunks)
      }

      const url = new URL(targetUrl)
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: req.method,
        headers: {
          'host': url.hostname,
          'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
          ...(req.headers.range ? { range: req.headers.range } : {}),
          ...(req.headers['if-none-match'] ? { 'if-none-match': req.headers['if-none-match'] } : {}),
        },
      }

      const transport = url.protocol === 'https:' ? https : http
      const proxyReq = transport.request(options, (proxyRes) => {
        // 透传目标响应头，强制加 CORS
        const headers = { ...proxyRes.headers }
        headers['access-control-allow-origin'] = '*'
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
        headers['access-control-allow-headers'] = '*'
        delete headers['x-frame-options']
        delete headers['content-security-policy']

        res.writeHead(proxyRes.statusCode, headers)
        proxyRes.pipe(res)
      })

      proxyReq.on('error', (err) => {
        console.error('CORS proxy error:', err.message)
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })

      proxyReq.setTimeout(60000, () => {
        proxyReq.destroy()
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Gateway timeout' }))
        }
      })

      if (body) proxyReq.write(body)
      proxyReq.end()
    } catch (err) {
      console.error('CORS proxy error:', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    }
    return
  }

  // 代理接口：POST /proxy?url=<encoded_target_url>
  if (req.method === 'POST' && req.url.startsWith('/proxy')) {
    try {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`)
      const targetUrl = reqUrl.searchParams.get('url')

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing url parameter' }))
        return
      }

      // 验证目标域名
      const targetHost = new URL(targetUrl).hostname
      if (!ALLOWED_HOSTS.has(targetHost)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Host not allowed: ${targetHost}` }))
        return
      }

      // 读取请求体
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }

      // 转发请求
      const result = await proxyRequest(targetUrl, 'POST', {
        'Content-Type': 'application/json',
      }, body)

      res.writeHead(result.status, { 'Content-Type': 'application/json' })
      res.end(result.body)
    } catch (err) {
      console.error('Proxy error:', err.message)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔔 Proxy server running on http://0.0.0.0:${PORT}`)
  console.log(`   Health:     http://localhost:${PORT}/health`)
  console.log(`   CORS Proxy: http://localhost:${PORT}/cors-proxy?url=<target_url>`)
  console.log(`   Webhook:    POST http://localhost:${PORT}/proxy?url=<target_webhook_url>`)
})
