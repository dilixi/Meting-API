import { list, put } from '@vercel/blob'

/**
 * 写入 JSON 到 Blob
 */
export async function writeBlob(filename, data) {

    const json = JSON.stringify(data, null, 2)

    try {

        const result = await put(
            filename,
            json,
            {
                access: 'public',
                addRandomSuffix: false
            }
        )

        console.log('[BLOB WRITE]', filename)

        return result.url

    } catch (e) {

        console.log('[BLOB WRITE FAIL]', e.message)
        return null
    }
}

/**
 * 读取 Blob（按 key）
 */
export async function readBlob(filename) {

    try {

        const files = await list()

        const file = files.blobs.find(
            b => b.pathname === filename
        )

        if (!file) return null

        const res = await fetch(file.url)

        return await res.json()

    } catch (e) {

        console.log('[BLOB READ FAIL]', e.message)
        return null
    }
}

/**
 * 列出所有 blobs
 */
export async function listBlob() {

    const res = await list()
    return res.blobs
}
