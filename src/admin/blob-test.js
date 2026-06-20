import { put } from "@vercel/blob";

export default async function handler(
 req,
 res
)
{
    try
    {
        console.log(
            '[BLOB]',
            'START'
        )

        const now =
            Date.now()

        const text =
            `hello-${now}`

        const result =
            await put(
                'debug.txt',
                text,
                {
                    access:
                        'private',

                    addRandomSuffix:
                        false
                }
            )

        console.log(
            '[BLOB]',
            result
        )

        res.status(
            200
        ).json({

            ok:true,

            url:
                result.url
        })
    }
    catch(e)
    {
        console.error(
            '[BLOB]',
            e
        )

        res.status(
            500
        ).json({

            error:
                e.message
        })
    }
}
