const {
    recordApiResponse,
} = require("./metrics.service");

const TARGET_USERNAMES = new Set([
    "MHT-25-001",
    "MHTv2-25-001",
]);

/**
 * Extrae el username de rutas con esta estructura:
 *
 * /api/v1/datas/username/MHT-25-001
 * /api/v1/datas/username/MHTv2-25-001
 */
function extractUsernameFromPath(req) {
    const match = req.path.match(
        /^\/api\/v1\/datas\/username\/([^/]+)\/?$/
    );

    if (!match) {
        return null;
    }

    try {
        return decodeURIComponent(match[1]).trim();
    } catch {
        return match[1].trim();
    }
}

function apiResponseMetricsMiddleware(req, res, next) {
    if (req.method !== "GET") {
        return next();
    }

    const username =
        extractUsernameFromPath(req);

    if (
        !username ||
        !TARGET_USERNAMES.has(username)
    ) {
        return next();
    }

    const startTime =
        process.hrtime.bigint();

    let payloadBytes = null;
    let recordsReturned = null;

    const originalJson =
        res.json.bind(res);

    res.json = function instrumentedJson(body) {
        try {
            const serializedBody =
                JSON.stringify(body);

            payloadBytes =
                Buffer.byteLength(
                    serializedBody,
                    "utf8"
                );

            if (Array.isArray(body)) {
                recordsReturned = body.length;
            } else if (
                Array.isArray(body?.data)
            ) {
                recordsReturned =
                    body.data.length;
            } else if (
                Array.isArray(body?.results)
            ) {
                recordsReturned =
                    body.results.length;
            }
        } catch (error) {
            console.error(
                "Unable to inspect API response:",
                error.message
            );
        }

        return originalJson(body);
    };

    res.once("finish", () => {
        const endTime =
            process.hrtime.bigint();

        const responseTimeMs =
            Number(endTime - startTime) /
            1_000_000;

        const contentLength =
            Number(
                res.getHeader(
                    "content-length"
                )
            );

        const finalPayloadBytes =
            Number.isFinite(payloadBytes)
                ? payloadBytes
                : Number.isFinite(contentLength)
                    ? contentLength
                    : null;

        recordApiResponse({
            method: req.method,

            /*
             * Guardamos una ruta general para que las
             * condiciones puedan compararse fácilmente.
             */
            route:
                "/api/v1/datas/username/:username",

            requestUrl: req.originalUrl,
            username,
            statusCode: res.statusCode,
            responseTimeMs,
            payloadBytes:
            finalPayloadBytes,
            recordsReturned,
            recordedAt: new Date(),
        });
    });

    next();
}

module.exports = {
    apiResponseMetricsMiddleware,
};