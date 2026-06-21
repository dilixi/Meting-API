import store from '../admin/store.js'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { validateCookie } from './cookie-validator.js'
import cookieMonitor from './cookie-monitor.js' 

const formatCookieForDisplay = (cookie) => {
    const { id, platform, note, createdAt, updatedAt, createdBy, isActive, isValid, validatedAt, userInfo, validationError } = cookie
    let cookiePreview = cookie.cookie
    if (cookiePreview.length > 50) {
        cookiePreview = cookiePreview.substring(0, 50) + '...'
    }
    return { id, platform, cookiePreview, note, createdAt, updatedAt, createdBy, isActive, isValid, validatedAt, userInfo, validationError }
}
const musicCache = new Map()
const MAX_CACHE = 10 * 1024 * 1024 // 10MB

function getCachedMusic(name) {
    const hit = musicCache.get(name)
    if (!hit) return null

    // 10分钟过期
    if (Date.now() - hit.ts > 10 * 60 * 1000) {
        musicCache.delete(name)
        return null
    }

    return hit.buffer
}

function setCachedMusic(name, buffer) {
    // 只缓存不超过 10MB 的完整音频
    if (!(buffer instanceof Buffer)) return
    if (buffer.length > MAX_CACHE) return

    musicCache.set(name, {
        buffer,
        ts: Date.now()
    })
}

async function getContentLength(url) {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) return null

    const len = res.headers.get('content-length')
    return len ? Number(len) : null
}

async function fetchRangeBuffer(url, start, end) {
    const res = await fetch(url, {
        headers: {
            Range: `bytes=${start}-${end}`
        }
    })

    if (!(res.ok || res.status === 206)) {
        throw new Error(`range fetch failed: ${res.status}`)
    }

    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
}

async function fetchRangeStream(url, start, end, controller, cacheState) {
    const res = await fetch(url, {
        headers: {
            Range: `bytes=${start}-${end}`
        }
    })

    if (!(res.ok || res.status === 206) || !res.body) {
        throw new Error(`stream fetch failed: ${res.status}`)
    }

    const reader = res.body.getReader()

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        controller.enqueue(value)

        if (cacheState.total < MAX_CACHE) {
            const remaining = MAX_CACHE - cacheState.total
            const take = Math.min(remaining, value.length)

            if (take > 0) {
                cacheState.chunks.push(Buffer.from(value.slice(0, take)))
                cacheState.total += take
            }
        }
    }
}


export const adminRoutes = (app) => {
    app.post('/admin/login', async (c) => {
        const body = await c.req.json()
        const { username, password, code } = body
        
        if (!username || !password) {
            return c.json({ success: false, error: '用户名和密码不能为空' }, 400)
        }
        
        const result = await store.authenticateUser(username, password)
        
        if (result.success && result.require2FA) {
            if (!code) {
                return c.json({ 
                    success: true, 
                    require2FA: true, 
                    data: { username: result.data.username, role: result.data.role }
                })
            }
            const twoFAResult = await store.verify2FALogin(username, code)
        if (twoFAResult.success) {
            return c.json(twoFAResult)
        } else {
            return c.json(twoFAResult, 400)
        }
        }
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 401)
        }
    })

    app.post('/admin/logout', async (c) => {
        const username = c.req.header('X-Auth-Username')
        if (username) {
            await store.logoutUser(username)
        }
        return c.json({ success: true })
    })

    app.get('/admin/check', authMiddleware, async (c) => {
        const username = c.get('username')
        const user = store.users.get(username)
        return c.json({ 
            success: true, 
            data: { 
                username: user.username, 
                role: user.role 
            } 
        })
    })

    app.get('/admin/cookies', authMiddleware, async (c) => {
       const platform = c.req.query('platform')
       const cookies = store.getCookies(platform).map(formatCookieForDisplay)
       return c.json({ success: true, data: cookies })
    })
    
    app.get('/admin/cookies/:id', authMiddleware, async (c) => {
        const id = c.req.param('id')
        const cookie = store.getCookie(id)
        
        if (!cookie) {
            return c.json({ success: false, error: 'Cookie不存在' }, 404)
        }
        
        return c.json({ success: true, data: formatCookieForDisplay(cookie) })
    })

    app.post('/admin/cookies', authMiddleware, async (c) => {
        const body = await c.req.json()
        const { platform, cookie, note, skipValidation } = body
        const username = c.get('username')
        
        const result = await store.addCookie(platform, cookie, note, username, skipValidation)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.put('/admin/cookies/:id', authMiddleware, async (c) => {
        const id = c.req.param('id')
        const body = await c.req.json()
        const username = c.get('username')
        const { skipValidation, ...updates } = body
        
        const result = await store.updateCookie(id, updates, username, skipValidation)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.delete('/admin/cookies/:id', authMiddleware, async (c) => {
        const id = c.req.param('id')
        const username = c.get('username')
        
        const result = await store.deleteCookie(id, username)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 404)
        }
    })

    app.post('/admin/cookies/:id/verify', authMiddleware, async (c) => {
        const id = c.req.param('id')
        const username = c.get('username')
        
        const result = await store.verifyCookie(id, username)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 404)
        }
    })

    app.post('/admin/cookies/validate', authMiddleware, async (c) => {
        const body = await c.req.json()
        const { platform, cookie } = body
        
        if (!platform || !cookie) {
            return c.json({ success: false, error: '平台和Cookie数据不能为空' }, 400)
        }
        
        const result = await validateCookie(platform, cookie)
        return c.json({ success: true, data: result })
    })

    app.get('/admin/users', authMiddleware, adminMiddleware, async (c) => {
        const users = store.getUsers()
        return c.json({ success: true, data: users })
    })

    app.post('/admin/users', authMiddleware, adminMiddleware, async (c) => {
        const body = await c.req.json()
        const { username: newUsername, password, role } = body
        const operator = c.get('username')
        
        if (!newUsername || !password) {
            return c.json({ success: false, error: '用户名和密码不能为空' }, 400)
        }
        
        const result = await store.addUser({ username: newUsername, password, role }, operator)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.put('/admin/users/:username', authMiddleware, adminMiddleware, async (c) => {
        const targetUsername = c.req.param('username')
        const body = await c.req.json()
        const operator = c.get('username')
        
        const result = await store.updateUser(targetUsername, body, operator)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.put('/admin/profile', authMiddleware, async (c) => {
        const currentUsername = c.get('username')
        const body = await c.req.json()
        
        const result = await store.updateUser(currentUsername, body, currentUsername)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.delete('/admin/users/:username', authMiddleware, adminMiddleware, async (c) => {
        const targetUsername = c.req.param('username')
        const operator = c.get('username')
        
        const result = await store.deleteUser(targetUsername, operator)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.get('/admin/logs', authMiddleware, async (c) => {
        const limit = parseInt(c.req.query('limit') || '100')
        const offset = parseInt(c.req.query('offset') || '0')
        const logs = store.getLogs(limit, offset)
        return c.json({ success: true, data: logs })
    })

    app.put('/admin/password', authMiddleware, async (c) => {
        const body = await c.req.json()
        const { oldPassword, newPassword } = body
        const username = c.get('username')
        
        if (!oldPassword || !newPassword) {
            return c.json({ success: false, error: '旧密码和新密码不能为空' }, 400)
        }
        
        const user = store.users.get(username)
        if (user.password !== store.hashPassword(oldPassword)) {
            return c.json({ success: false, error: '旧密码错误' }, 400)
        }
        
        const result = await store.updateUser(username, { password: newPassword }, username)
        return c.json(result)
    })

    app.get('/admin/config', authMiddleware, adminMiddleware, async (c) => {
        const config = store.getConfig()
        return c.json({ success: true, data: config })
    })

    app.put('/admin/config/admin-path', authMiddleware, adminMiddleware, async (c) => {
        const body = await c.req.json()
        const { adminPath } = body
        const operator = c.get('username')
        
        const result = await store.setAdminPath(adminPath, operator)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.get('/admin/webhook', authMiddleware, adminMiddleware, async (c) => {
        const config = store.getWebhookConfig()
        return c.json({ success: true, data: config })
    })

    app.put('/admin/webhook', authMiddleware, adminMiddleware, async (c) => {
        const body = await c.req.json()
        const operator = c.get('username')
        
        const result = await store.setWebhookConfig(body, operator)
        
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.post('/admin/webhook/test', authMiddleware, adminMiddleware, async (c) => {
        const result = await cookieMonitor.testWebhook()
        
        if (result.sent) {
            return c.json({ success: true, message: 'Webhook测试消息已发送' })
        } else {
            return c.json({ success: false, error: result.error || '发送失败' }, 400)
        }
    })

    app.get('/admin/monitor', authMiddleware, adminMiddleware, async (c) => {
        const config = store.getMonitorConfig()
        return c.json({ success: true, data: config })
    })

    app.put('/admin/monitor', authMiddleware, adminMiddleware, async (c) => {
        const body = await c.req.json()
        const operator = c.get('username')
        
        const result = await store.setMonitorConfig(body, operator)
        
        if (result.success) {
            if (body.enabled !== undefined || body.interval !== undefined) {
                cookieMonitor.restart()
            }
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.get('/admin/monitor/status', authMiddleware, adminMiddleware, async (c) => {
        const status = cookieMonitor.getStatus()
        return c.json({ success: true, data: status })
    })

    app.post('/admin/monitor/check', authMiddleware, adminMiddleware, async (c) => {
        const result = await cookieMonitor.checkNow()
        
        if (result.success) {
            return c.json({ success: true, message: '检查已完成' })
        } else {
            return c.json(result, 400)
        }
    })

    app.get('/admin/monitor/logs', authMiddleware, adminMiddleware, async (c) => {
        const limit = parseInt(c.req.query('limit') || '100')
        const offset = parseInt(c.req.query('offset') || '0')
        const logs = store.getMonitorLogs(limit, offset)
        return c.json({ success: true, data: logs })
    })

    app.get('/admin/2fa/status', authMiddleware, async (c) => {
        const username = c.get('username')
        const status = store.get2FAStatus(username)
        return c.json({ success: true, data: status })
    })

    app.post('/admin/2fa/setup', authMiddleware, async (c) => {
        const username = c.get('username')
        const result = store.setup2FA(username)
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.post('/admin/2fa/enable', authMiddleware, async (c) => {
        const body = await c.req.json()
        const { code } = body
        const username = c.get('username')

        if (!code) {
            return c.json({ success: false, error: '验证码不能为空' }, 400)
        }

        const result = await store.enable2FA(username, code)
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.post('/admin/2fa/disable', authMiddleware, async (c) => {
        const body = await c.req.json()
        const { password } = body
        const username = c.get('username')

        if (!password) {
            return c.json({ success: false, error: '密码不能为空' }, 400)
        }

        const result = await store.disable2FA(username, password)
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 400)
        }
    })

    app.get('/admin/tokens', authMiddleware, adminMiddleware, async (c) => {
        const tokens = store.getApiTokens()
        return c.json({ success: true, data: tokens })
    })

    app.post('/admin/tokens', authMiddleware, adminMiddleware, async (c) => {
        const body = await c.req.json()
        const { name, permissions } = body
        const operator = c.get('username')

        if (!name) {
            return c.json({ success: false, error: 'Token名称不能为空' }, 400)
        }

        const result = await store.createApiToken(name, permissions || [], operator)
        return c.json(result)
    })

    app.get('/admin/tokens/:id', authMiddleware, adminMiddleware, async (c) => {
        const id = c.req.param('id')
        const token = store.getApiToken(id)
        if (!token) {
            return c.json({ success: false, error: 'Token不存在' }, 404)
        }
        const { token: _, ...safeToken } = token
        return c.json({ success: true, data: safeToken })
    })

    app.put('/admin/tokens/:id', authMiddleware, adminMiddleware, async (c) => {
        const id = c.req.param('id')
        const body = await c.req.json()
        const operator = c.get('username')

        const result = await store.updateApiToken(id, body, operator)
        if (result.success) {
            const { token: _, ...safeToken } = result.data
            return c.json({ success: true, data: safeToken })
        } else {
            return c.json(result, 400)
        }
    })

    app.delete('/admin/tokens/:id', authMiddleware, adminMiddleware, async (c) => {
        const id = c.req.param('id')
        const operator = c.get('username')

        const result = await store.deleteApiToken(id, operator)
        if (result.success) {
            return c.json(result)
        } else {
            return c.json(result, 404)
        }
    })
    
    app.get('/admin/blob-test', async (c) => {
    
        try {
    
            console.log('[BLOB TEST] start')
    
            const blob =
                await import('@vercel/blob')
    
            const filename =
                `test-${Date.now()}.json`
    
            const writeResult =
                await blob.put(
                    filename,
                    JSON.stringify({
                        time: Date.now(),
                        hello: 'world'
                    }),
                    {
                        access: 'public'
                    }
                )
    
            console.log('[BLOB TEST] write ok:', writeResult.url)
    
            const listResult =
                await blob.list()
    
            console.log('[BLOB TEST] total:', listResult.blobs.length)
    
            return c.json({
                ok: true,
                url: writeResult.url,
                count: listResult.blobs.length
            })
    
        }
        catch (e) {
    
            console.error('[BLOB TEST ERROR]', e)
    
            return c.json({
                ok: false,
                error: e.message
            }, 500)
        }
    })

app.get('/admin/blob-debug', async (c) => {
    try {
        const { list, put } = await import('@vercel/blob')

        // ==============================
        // 1. 模拟 store.js 的真实 key
        // ==============================
        const testFiles = [
            'cookies.json',
            'users.json',
            'logs.json'
        ]

        // ==============================
        // 2. 写入测试（模拟 store 行为）
        // ==============================
        const writeResults = []

        for (const filename of testFiles) {
            const key = filename

            const res = await put(
                key,
                JSON.stringify({
                    test: true,
                    file: filename,
                    time: Date.now()
                }),
                {
                    access: 'public',
                    addRandomSuffix: false
                }
            )

            writeResults.push({
                key,
                url: res.url
            })
        }

        // ==============================
        // 3. 读取 Blob 列表
        // ==============================
        const all = await list()

        const blobKeys = all.blobs.map(b => b.pathname)

        // ==============================
        // 4. 验证匹配情况
        // ==============================
        const matchReport = testFiles.map(f => {
            return {
                file: f,
                existsInBlob: blobKeys.includes(f)
            }
        })

        // ==============================
        // 5. 模拟 store.js loadFromFile 逻辑验证
        // ==============================
        const loadTest = {}

        for (const f of testFiles) {
            const hit = all.blobs.find(b => b.pathname === f)

            loadTest[f] = {
                found: !!hit,
                url: hit?.url || null
            }
        }

        // ==============================
        // 6. 返回完整报告
        // ==============================
        return c.json({
            ok: true,

            summary: {
                totalBlobs: all.blobs.length,
                testFiles
            },

            writeResults,

            blobKeys,

            matchReport,

            loadTest
        })

    } catch (e) {
        return c.json({
            ok: false,
            error: e.message
        })
    }
})

app.get('/admin/test_cookies_get', async (c) => {
    try {
        console.log('[COOKIES DEBUG] start')

        const { list } = await import('@vercel/blob')

        const listResult = await list()

        console.log('[COOKIES DEBUG] total blobs:', listResult.blobs.length)

        // 找 cookies.json（兼容 fallback）
        const file = listResult.blobs.find(b =>
            b.pathname === 'cookies.json' ||
            b.pathname.endsWith('cookies.json')
        )

        if (!file) {
            return c.json({
                ok: false,
                error: 'cookies.json not found',
                blobs: listResult.blobs.map(b => b.pathname)
            })
        }

        console.log('[COOKIES DEBUG] found:', file.url)

        const res = await fetch(file.url)
        const data = await res.json()

        const cookieCount = Object.keys(data || {}).length

        return c.json({
            ok: true,
            file: {
                pathname: file.pathname,
                url: file.url
            },
            summary: {
                cookieCount
            },
            sample: Object.values(data || {}).slice(0, 3)
        })

    } catch (e) {
        console.error('[COOKIES DEBUG ERROR]', e)

        return c.json({
            ok: false,
            error: e.message
        }, 500)
    }
})

app.get('music', async (c) => {
    try {

        const name =
            decodeURIComponent(
                c.req.query('name') || ''
            )

        if (!name) {
            return c.text(
                'missing name',
                400
            )
        }

        const {
            default: fs
        } =
            await import('fs')

        const path =
            await import('path')

        const filePath =
            path.join(
                '.',
                'assets',
                'music',
                name
            )

        console.log(
            'read:',
            filePath
        )

        const file =
            fs.readFileSync(
                filePath+'.mp3'
            )

        return new Response(
            file,
            {
                headers: {
                    'Content-Type':
                        'audio/mpeg',

                    'Content-Disposition':
                        'inline',

                    'Cache-Control':
                        'public,max-age=86400'
                }
            }
        )

    } catch (e) {

        return c.json({
            ok:false,
            error:e.message
        },404)

    }
}) 
app.get('/my_music', async (c) => {
    try {
        const name = decodeURIComponent(c.req.query('name') || '')

        if (!name) {
            return c.text('missing name', 400)
        }

        // ========= 1. 特殊歌曲映射 =========
        const specialMap = {
            '瑶家儿童爱唱歌': 
                'https://hchmeejyhfpvoagootnf.supabase.co/storage/v1/object/public/my_package/12345.mp3'
        }

        let url = null

        if (specialMap[name]) {
            url = specialMap[name]
        }

        // ========= 2. 默认本地音乐 =========
        if (!url) {
            const fs = await import('fs')
            const path = await import('path')

            const filePath = path.join('.', 'assets', 'music', name + '.mp3')

            if (!fs.existsSync(filePath)) {
                return c.json({
                    ok: false,
                    error: 'music not found'
                }, 404)
            }

            const file = fs.readFileSync(filePath)

            return new Response(file, {
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Content-Disposition': 'inline',
                    'Cache-Control': 'public,max-age=86400'
                }
            })
        }

        // ========= 3. 远程音乐（Supabase等） =========
        const res = await fetch(url)

        if (!res.ok) {
            return c.json({
                ok: false,
                error: 'remote audio fetch failed'
            }, 500)
        }

        const arrayBuffer = await res.arrayBuffer()

        return new Response(arrayBuffer, {
            headers: {
                'Content-Type': 'audio/mpeg',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public,max-age=86400'
            }
        })

    } catch (e) {
        return c.json({
            ok: false,
            error: e.message
        }, 500)
    }
})
app.get('/my_music2', async (c) => {
    try {
        const name = decodeURIComponent(c.req.query('name') || '')

        if (!name) {
            return c.text('missing name', 400)
        }

        const specialMap = {
            '瑶家儿童爱唱歌':
                'https://hchmeejyhfpvoagootnf.supabase.co/storage/v1/object/public/my_package/12345.mp3'
        }

        const url = specialMap[name]

        // ===== 本地文件 =====
        if (!url) {
            const fs = await import('fs')
            const path = await import('path')

            const filePath = path.join('.', 'assets', 'music', name + '.mp3')

            if (!fs.existsSync(filePath)) {
                return c.json({ ok: false, error: 'music not found' }, 404)
            }

            const file = fs.readFileSync(filePath)

            return new Response(file, {
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Cache-Control': 'public,max-age=86400'
                }
            })
        }

        // ===== 命中内存缓存，直接返回 =====
        const cached = getCachedMusic(name)
        if (cached) {
            return new Response(cached, {
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': String(cached.length),
                    'Cache-Control': 'public,max-age=86400',
                    'X-Cache': 'HIT'
                }
            })
        }

        // ===== 先拿总长度，才能算 1/3 =====
        const totalLength = await getContentLength(url)
        if (!totalLength) {
            // 没拿到长度就退化成普通流式转发
            const res = await fetch(url)
            if (!res.ok || !res.body) {
                return c.json({ ok: false, error: 'remote audio fetch failed' }, 500)
            }

            return new Response(res.body, {
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Cache-Control': 'public,max-age=86400',
                    'X-Cache': 'MISS'
                }
            })
        }

        const firstThird = Math.max(1, Math.floor(totalLength / 3))
        const firstEnd = Math.min(totalLength - 1, firstThird - 1)

        const cacheState = {
            chunks: [],
            total: 0
        }

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // 1) 先下载 1/3，完整拿到后先发出去
                    const firstPart = await fetchRangeBuffer(url, 0, firstEnd)
                    controller.enqueue(firstPart)

                    if (cacheState.total < MAX_CACHE) {
                        const remaining = MAX_CACHE - cacheState.total
                        const take = Math.min(remaining, firstPart.length)
                        if (take > 0) {
                            cacheState.chunks.push(firstPart.slice(0, take))
                            cacheState.total += take
                        }
                    }

                    // 2) 再下载剩余部分，边下边发
                    if (firstEnd < totalLength - 1) {
                        await fetchRangeStream(
                            url,
                            firstEnd + 1,
                            totalLength - 1,
                            controller,
                            cacheState
                        )
                    }

                    // 3) 如果整个文件 <= 10MB，完整缓存起来
                    const fullBuffer = Buffer.concat(cacheState.chunks)
                    if (fullBuffer.length === totalLength && totalLength <= MAX_CACHE) {
                        setCachedMusic(name, fullBuffer)
                    }

                    controller.close()
                } catch (e) {
                    controller.error(e)
                }
            }
        })

        return new Response(stream, {
            headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Length': String(totalLength),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public,max-age=86400',
                'X-Cache': 'MISS'
            }
        })

    } catch (e) {
        return c.json({
            ok: false,
            error: e.message
        }, 500)
    }
})
app.get('/admin/debug/dump-all', async (c) => {
    const mapUser = (u) => ({
        username: u.username,
        role: u.role,
        createdAt: u.createdAt,
        lastLogin: u.lastLogin
    })

    const mapCookie = (c) => ({
        id: c.id,
        platform: c.platform,
        cookiePreview: (c.cookie || '').slice(0, 50),
        note: c.note,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        createdBy: c.createdBy,
        isActive: c.isActive,
        isValid: c.isValid,
        validatedAt: c.validatedAt,
        userInfo: c.userInfo,
        validationError: c.validationError
    })

    const mapLog = (l) => ({
        id: l.id,
        action: l.action,
        details: l.details,
        username: l.username,
        timestamp: l.timestamp
    })

    return c.json({
        success: true,

        cookies: Array.from(store.cookies.values()).map(mapCookie),

        users: Array.from(store.users.values()).map(mapUser),

        logs: store.logs.map(mapLog),

        security: {
            loginAttempts: Object.fromEntries(store.loginAttempts),
            lockedAccounts: Object.fromEntries(store.lockedAccounts)
        },

        config: store.config,

        monitor_logs: store.monitorLogs,

        api_tokens: Array.from(store.apiTokens.values()).map(t => ({
            id: t.id,
            name: t.name,
            permissions: t.permissions,
            createdAt: t.createdAt,
            createdBy: t.createdBy,
            usageCount: t.usageCount
        }))
    })
})
    
}

export default adminRoutes
