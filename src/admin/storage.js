import fs from 'fs'
import path from 'path'

let blob = null

async function getBlob()
{
    if (blob)
        return blob

    try
    {
        blob =
            await import(
                '@vercel/blob'
            )

        console.log(
            '[STORAGE]',
            'Blob Enabled'
        )
    }
    catch(e)
    {
        console.log(
            '[STORAGE]',
            'Blob Disabled'
        )
    }

    return blob
}

export async function readJson(
    filepath
)
{
    const filename =
        path.basename(
            filepath
        )

    try
    {
        const b =
            await getBlob()

        if (b)
        {
            const result =
                await b.list()

            const file =
                result.blobs.find(
                    x=>
                    x.pathname===
                    filename
                )

            if(file)
            {
                console.log(
                    '[BLOB READ]',
                    filename
                )

                const r =
                    await fetch(
                        file.url
                    )

                return JSON.parse(
                    await r.text()
                )
            }
        }
    }
    catch(e)
    {
        console.log(
            '[BLOB READ FAIL]',
            e.message
        )
    }

    try
    {
        if(
            fs.existsSync(
                filepath
            )
        )
        {
            console.log(
                '[FILE READ]',
                filename
            )

            return JSON.parse(
                fs.readFileSync(
                    filepath,
                    'utf8'
                )
            )
        }
    }
    catch(e)
    {
        console.log(
            '[FILE READ FAIL]',
            e.message
        )
    }

    return null
}

export async function writeJson(
    filepath,
    data
)
{
    const filename =
        path.basename(
            filepath
        )

    const json =
        JSON.stringify(
            data,
            null,
            2
        )

    try
    {
        fs.writeFileSync(
            filepath,
            json
        )

        console.log(
            '[FILE WRITE]',
            filename
        )
    }
    catch(e)
    {
        console.log(
            '[FILE WRITE FAIL]',
            e.message
        )
    }

    try
    {
        const b =
            await getBlob()

        if (b)
        {
            await b.put(
                filename,
                json,
                {
                    access:
                        'private',
                    addRandomSuffix:
                        false
                }
            )

            console.log(
                '[BLOB WRITE]',
                filename
            )
        }
    }
    catch(e)
    {
        console.log(
            '[BLOB WRITE FAIL]',
            e.message
        )
    }
}
