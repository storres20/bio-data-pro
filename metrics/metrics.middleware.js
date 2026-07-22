const {
    recordApiResponse,
} = require("./metrics.service");

const TARGET_USERNAMES = new Set([
    "MHT-25-001",
    "MHTv2-25-001",
]);

/**
 * Extrae el username de:
 *
 * /api/v1/datas/username/MHT-25-001
 * /api/v1/datas/username/MHTv2-25-001
 *
 * También elimina los query parameters.
 */
function extractUsernameFromPath(req) {
    const requestPath =
        req.originalUrl.split("?")[0];

    const match = requestPath.match(
        /^\/api\/v1\/datas\/username\/([^/]+)\/?$/
    );

    if (!match) {
        return null;
    }

    try {
        return decodeURIComponent(
            match[1]
        ).trim();
    } catch {
        return match[1].trim();
    }
}

function apiResponseMetricsMiddleware(
    req,
    res,
    next
) {
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
                recordsReturned =
                    body.length;
            } else if (
                body &&
                Array.isArray(body.data)
            ) {
                recordsReturned =
                    body.data.length;
            } else if (
                body &&
                Array.isArray(body.results)
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
        try {
            const endTime =
                process.hrtime.bigint();

            const responseTimeMs =
                Number(
                    endTime - startTime
                ) / 1_000_000;

            const contentLengthHeader =
                res.getHeader(
                    "content-length"
                );

            const contentLength =
                contentLengthHeader !==
                undefined
                    ? Number(
                        contentLengthHeader
                    )
                    : null;

            const finalPayloadBytes =
                Number.isFinite(
                    payloadBytes
                )
                    ? payloadBytes
                    : Number.isFinite(
                        contentLength
                    )
                        ? contentLength
                        : null;

            recordApiResponse({
                method: req.method,
                route:
                    "/api/v1/datas/username/:username",
                requestUrl:
                req.originalUrl,
                username,
                statusCode:
                res.statusCode,
                responseTimeMs,
                payloadBytes:
                finalPayloadBytes,
                recordsReturned,
                recordedAt:
                    new Date(),
            });

            console.log(
                `📊 API metric recorded: ` +
                `${username} | ` +
                `${responseTimeMs.toFixed(3)} ms | ` +
                `${recordsReturned ?? "unknown"} records | ` +
                `${finalPayloadBytes ?? "unknown"} bytes`
            );
        } catch (error) {
            console.error(
                "Unable to record API response metric:",
                error.message
            );
        }
    });

    return next();
}

module.exports = {
    apiResponseMetricsMiddleware,
};