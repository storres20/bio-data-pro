// metrics/metrics.routes.js

const express = require("express");

const {
    startMetricsSession,
    stopMetricsSession,
    resetMetricsSession,
    getMetricsStatus,

    // Experimento 1
    getUpdateIntervalSummary,
    getRawUpdateIntervals,
    getUpdateIntervalsForExport,

    // Experimento 2
    getApiResponseSummary,
    getApiResponseRawSamples,
    getApiResponseSamplesForExport,

    // Experimento 3
    setMemoryPhase,
    getMemoryUsageSummary,
    getMemoryUsageRawSamples,
    getMemoryUsageSamplesForExport,
} = require("./metrics.service");

const router = express.Router();

// ---------------------------------------------------------
// FUNCIONES AUXILIARES PARA CSV
// ---------------------------------------------------------

function escapeCsvValue(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    const stringValue = String(value);

    if (
        stringValue.includes(",") ||
        stringValue.includes('"') ||
        stringValue.includes("\n") ||
        stringValue.includes("\r")
    ) {
        return `"${stringValue.replace(
            /"/g,
            '""'
        )}"`;
    }

    return stringValue;
}

function sanitizeFilename(value) {
    return String(value)
        .replace(
            /[^a-zA-Z0-9_-]/g,
            "_"
        )
        .substring(0, 80);
}

// ---------------------------------------------------------
// CONTROL DE LA SESIÓN
// ---------------------------------------------------------

router.post("/start", (req, res) => {
    try {
        const status =
            startMetricsSession();

        return res.json({
            success: true,
            message:
                "Metrics collection started",
            data: status,
        });
    } catch (error) {
        console.error(
            "Error starting metrics:",
            error
        );

        return res.status(500).json({
            success: false,
            error:
                "Unable to start metrics collection",
        });
    }
});

router.post("/stop", (req, res) => {
    try {
        const status =
            stopMetricsSession();

        return res.json({
            success: true,
            message:
                "Metrics collection stopped",
            data: status,
        });
    } catch (error) {
        console.error(
            "Error stopping metrics:",
            error
        );

        return res.status(500).json({
            success: false,
            error:
                "Unable to stop metrics collection",
        });
    }
});

router.get("/status", (req, res) => {
    try {
        return res.json({
            success: true,
            generatedAt:
                new Date().toISOString(),
            data: getMetricsStatus(),
        });
    } catch (error) {
        console.error(
            "Error reading metrics status:",
            error
        );

        return res.status(500).json({
            success: false,
            error:
                "Unable to read metrics status",
        });
    }
});

router.post("/reset", (req, res) => {
    try {
        const status =
            resetMetricsSession();

        return res.json({
            success: true,
            message:
                "Metrics session was reset",
            data: status,
        });
    } catch (error) {
        console.error(
            "Error resetting metrics:",
            error
        );

        return res.status(500).json({
            success: false,
            error:
                "Unable to reset metrics",
        });
    }
});

// =========================================================
// EXPERIMENTO 1
// OBSERVED WEBSOCKET UPDATE INTERVAL
// =========================================================

// ---------------------------------------------------------
// RESUMEN DEL INTERVALO WEBSOCKET
// ---------------------------------------------------------

router.get(
    "/update-interval/summary",
    (req, res) => {
        try {
            return res.json({
                success: true,
                generatedAt:
                    new Date().toISOString(),
                data:
                    getUpdateIntervalSummary(),
            });
        } catch (error) {
            console.error(
                "Error generating update interval summary:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to generate update interval summary",
            });
        }
    }
);

// ---------------------------------------------------------
// MUESTRAS CRUDAS DEL INTERVALO WEBSOCKET
// ---------------------------------------------------------

router.get(
    "/update-interval/raw",
    (req, res) => {
        try {
            const {
                deviceId = null,
                limit = 1000,
            } = req.query;

            const samples =
                getRawUpdateIntervals({
                    deviceId,
                    limit,
                });

            return res.json({
                success: true,
                count: samples.length,
                data: samples,
            });
        } catch (error) {
            console.error(
                "Error reading raw update interval metrics:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to read raw update interval metrics",
            });
        }
    }
);

// ---------------------------------------------------------
// EXPORTACIÓN CSV DEL INTERVALO WEBSOCKET
// ---------------------------------------------------------

router.get(
    "/update-interval/export.csv",
    (req, res) => {
        try {
            const { deviceId = null } =
                req.query;

            const samples =
                getUpdateIntervalsForExport({
                    deviceId,
                });

            const status =
                getMetricsStatus();

            const header = [
                "session_id",
                "device_id",
                "sample_number",
                "recorded_at_utc",
                "interval_ms",
                "interval_seconds",
                "classification",
            ];

            const rows = samples.map(
                (sample, index) => {
                    let classification =
                        "on_time";

                    if (
                        sample.intervalMs > 4000
                    ) {
                        classification =
                            "potential_missed_update";
                    } else if (
                        sample.intervalMs > 3000
                    ) {
                        classification =
                            "delayed";
                    }

                    return [
                        sample.sessionId,
                        sample.deviceId,
                        index + 1,
                        sample.recordedAt,
                        sample.intervalMs.toFixed(3),
                        (
                            sample.intervalMs / 1000
                        ).toFixed(6),
                        classification,
                    ]
                        .map(escapeCsvValue)
                        .join(",");
                }
            );

            const csvContent =
                "\uFEFF" +
                [
                    header.join(","),
                    ...rows,
                ].join("\r\n");

            const sessionName =
                status.sessionId
                    ? sanitizeFilename(
                        status.sessionId
                    )
                    : "no-session";

            const deviceName =
                deviceId
                    ? `-${sanitizeFilename(
                        deviceId
                    )}`
                    : "-all-devices";

            const filename =
                `websocket-update-interval-` +
                `${sessionName}` +
                `${deviceName}.csv`;

            res.setHeader(
                "Content-Type",
                "text/csv; charset=utf-8"
            );

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${filename}"`
            );

            res.setHeader(
                "Cache-Control",
                "no-store"
            );

            return res.status(200).send(
                csvContent
            );
        } catch (error) {
            console.error(
                "Error exporting update interval CSV:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to export update interval CSV",
            });
        }
    }
);

// =========================================================
// EXPERIMENTO 2
// API RESPONSE TIME
// =========================================================

// ---------------------------------------------------------
// RESUMEN DEL TIEMPO DE RESPUESTA API
// ---------------------------------------------------------

router.get(
    "/api-response/summary",
    (req, res) => {
        try {
            return res.json({
                success: true,
                generatedAt:
                    new Date().toISOString(),
                data:
                    getApiResponseSummary(),
            });
        } catch (error) {
            console.error(
                "Error generating API response summary:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to generate API response summary",
            });
        }
    }
);

// ---------------------------------------------------------
// MUESTRAS CRUDAS DEL TIEMPO DE RESPUESTA API
// ---------------------------------------------------------

router.get(
    "/api-response/raw",
    (req, res) => {
        try {
            const {
                username = null,
                limit = 1000,
            } = req.query;

            const samples =
                getApiResponseRawSamples({
                    username,
                    limit,
                });

            return res.json({
                success: true,
                count: samples.length,
                filters: {
                    username,
                    limit: Number(limit),
                },
                data: samples,
            });
        } catch (error) {
            console.error(
                "Error reading raw API response metrics:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to read raw API response metrics",
            });
        }
    }
);

// ---------------------------------------------------------
// EXPORTACIÓN CSV DEL TIEMPO DE RESPUESTA API
// ---------------------------------------------------------

router.get(
    "/api-response/export.csv",
    (req, res) => {
        try {
            const { username = null } =
                req.query;

            const samples =
                getApiResponseSamplesForExport(
                    username
                );

            const status =
                getMetricsStatus();

            const header = [
                "session_id",
                "sample_number",
                "username",
                "method",
                "route",
                "request_url",
                "status_code",
                "recorded_at_utc",
                "response_time_ms",
                "response_time_seconds",
                "payload_bytes",
                "payload_kilobytes",
                "payload_megabytes",
                "records_returned",
                "request_success",
            ];

            const rows = samples.map(
                (sample, index) => {
                    const requestSuccess =
                        Number.isFinite(
                            sample.statusCode
                        ) &&
                        sample.statusCode >= 200 &&
                        sample.statusCode < 300;

                    return [
                        sample.sessionId,
                        index + 1,
                        sample.username,
                        sample.method,
                        sample.route,
                        sample.requestUrl,
                        sample.statusCode,
                        sample.recordedAt,

                        Number.isFinite(
                            sample.responseTimeMs
                        )
                            ? sample.responseTimeMs.toFixed(
                                3
                            )
                            : "",

                        Number.isFinite(
                            sample.responseTimeMs
                        )
                            ? (
                                sample.responseTimeMs /
                                1000
                            ).toFixed(6)
                            : "",

                        sample.payloadBytes ?? "",

                        Number.isFinite(
                            sample.payloadKilobytes
                        )
                            ? sample.payloadKilobytes.toFixed(
                                3
                            )
                            : "",

                        Number.isFinite(
                            sample.payloadMegabytes
                        )
                            ? sample.payloadMegabytes.toFixed(
                                6
                            )
                            : "",

                        sample.recordsReturned ?? "",

                        requestSuccess
                            ? "true"
                            : "false",
                    ]
                        .map(escapeCsvValue)
                        .join(",");
                }
            );

            const csvContent =
                "\uFEFF" +
                [
                    header.join(","),
                    ...rows,
                ].join("\r\n");

            const sessionName =
                status.sessionId
                    ? sanitizeFilename(
                        status.sessionId
                    )
                    : "no-session";

            const usernameName =
                username
                    ? `-${sanitizeFilename(
                        username
                    )}`
                    : "-all-usernames";

            const filename =
                `api-response-time-` +
                `${sessionName}` +
                `${usernameName}.csv`;

            res.setHeader(
                "Content-Type",
                "text/csv; charset=utf-8"
            );

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${filename}"`
            );

            res.setHeader(
                "Cache-Control",
                "no-store"
            );

            return res.status(200).send(
                csvContent
            );
        } catch (error) {
            console.error(
                "Error exporting API response CSV:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to export API response CSV",
            });
        }
    }
);


// =========================================================
// EXPERIMENTO 3
// BACKEND MEMORY USAGE
// =========================================================

router.post(
    "/memory/phase",
    (req, res) => {
        try {
            const { phase } = req.body;

            const result =
                setMemoryPhase(phase);

            return res.json({
                success: true,
                message:
                    "Memory experiment phase updated",
                data: result,
            });
        } catch (error) {
            return res.status(400).json({
                success: false,
                error: error.message,
                allowedPhases: [
                    "baseline",
                    "api_load",
                    "recovery",
                    "post_load",
                ],
            });
        }
    }
);

router.get(
    "/memory/summary",
    (req, res) => {
        try {
            return res.json({
                success: true,
                generatedAt:
                    new Date().toISOString(),
                data:
                    getMemoryUsageSummary(),
            });
        } catch (error) {
            console.error(
                "Error generating memory summary:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to generate memory summary",
            });
        }
    }
);

router.get(
    "/memory/raw",
    (req, res) => {
        try {
            const {
                phase = null,
                limit = 1000,
            } = req.query;

            const samples =
                getMemoryUsageRawSamples({
                    phase,
                    limit,
                });

            return res.json({
                success: true,
                count: samples.length,
                filters: {
                    phase,
                    limit: Number(limit),
                },
                data: samples,
            });
        } catch (error) {
            console.error(
                "Error reading memory samples:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to read memory samples",
            });
        }
    }
);

router.get(
    "/memory/export.csv",
    (req, res) => {
        try {
            const { phase = null } =
                req.query;

            const samples =
                getMemoryUsageSamplesForExport(
                    phase
                );

            const status =
                getMetricsStatus();

            const header = [
                "session_id",
                "sample_number",
                "recorded_at_utc",
                "elapsed_ms",
                "elapsed_seconds",
                "phase",
                "rss_bytes",
                "rss_megabytes",
                "heap_total_bytes",
                "heap_total_megabytes",
                "heap_used_bytes",
                "heap_used_megabytes",
                "external_bytes",
                "external_megabytes",
                "array_buffers_bytes",
                "array_buffers_megabytes",
            ];

            const rows = samples.map(
                (sample, index) => [
                    sample.sessionId,
                    index + 1,
                    sample.recordedAt,
                    sample.elapsedMs,
                    Number.isFinite(
                        sample.elapsedSeconds
                    )
                        ? sample.elapsedSeconds.toFixed(
                            3
                        )
                        : "",
                    sample.phase,
                    sample.rssBytes,
                    sample.rssMegabytes.toFixed(
                        6
                    ),
                    sample.heapTotalBytes,
                    sample.heapTotalMegabytes.toFixed(
                        6
                    ),
                    sample.heapUsedBytes,
                    sample.heapUsedMegabytes.toFixed(
                        6
                    ),
                    sample.externalBytes,
                    sample.externalMegabytes.toFixed(
                        6
                    ),
                    sample.arrayBuffersBytes,
                    sample.arrayBuffersMegabytes.toFixed(
                        6
                    ),
                ]
                    .map(escapeCsvValue)
                    .join(",")
            );

            const csvContent =
                "\uFEFF" +
                [
                    header.join(","),
                    ...rows,
                ].join("\r\n");

            const sessionName =
                status.sessionId
                    ? sanitizeFilename(
                        status.sessionId
                    )
                    : "no-session";

            const phaseName =
                phase
                    ? `-${sanitizeFilename(
                        phase
                    )}`
                    : "-all-phases";

            const filename =
                `backend-memory-usage-` +
                `${sessionName}` +
                `${phaseName}.csv`;

            res.setHeader(
                "Content-Type",
                "text/csv; charset=utf-8"
            );

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${filename}"`
            );

            res.setHeader(
                "Cache-Control",
                "no-store"
            );

            return res
                .status(200)
                .send(csvContent);
        } catch (error) {
            console.error(
                "Error exporting memory CSV:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to export memory CSV",
            });
        }
    }
);

module.exports = router;