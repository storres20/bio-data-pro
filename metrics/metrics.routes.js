// metrics/metrics.routes.js

const express = require("express");

const {
    startMetricsSession,
    stopMetricsSession,
    resetMetricsSession,
    getMetricsStatus,
    getUpdateIntervalSummary,
    getRawUpdateIntervals,
    getUpdateIntervalsForExport,
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
                "Error generating metrics summary:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to generate metrics summary",
            });
        }
    }
);

// ---------------------------------------------------------
// MUESTRAS CRUDAS EN JSON
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
                "Error reading raw metrics:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to read raw metrics",
            });
        }
    }
);

// ---------------------------------------------------------
// EXPORTACIÓN CSV
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
                "Error exporting CSV metrics:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Unable to export metrics CSV",
            });
        }
    }
);

module.exports = router;