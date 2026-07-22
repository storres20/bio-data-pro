// metrics/metrics.service.js

const { performance } = require("node:perf_hooks");

// ---------------------------------------------------------
// CONFIGURACIÓN GENERAL
// ---------------------------------------------------------

const MAX_SAMPLES = 50_000;
const NOMINAL_INTERVAL_MS = 2000;

// Umbrales experimentales.
const ON_TIME_MAXIMUM_MS = 3000;
const DELAYED_MAXIMUM_MS = 4000;

// ---------------------------------------------------------
// ESTADO DE LA SESIÓN EXPERIMENTAL
// ---------------------------------------------------------

let metricsEnabled = false;
let startedAt = null;
let stoppedAt = null;
let sessionId = null;

// Guarda la llegada anterior de cada dispositivo.
const lastArrivalByDevice = new Map();

// Guarda las muestras de la sesión actual.
const updateIntervals = [];

// ---------------------------------------------------------
// CONTROL DE LA SESIÓN
// ---------------------------------------------------------

/**
 * Genera un identificador sencillo para cada sesión experimental.
 */
function generateSessionId() {
    return `session-${Date.now()}`;
}

/**
 * Inicia una nueva sesión experimental.
 *
 * Al iniciar:
 * - elimina muestras anteriores;
 * - elimina referencias temporales anteriores;
 * - activa la captura;
 * - genera un nuevo ID de sesión.
 */
function startMetricsSession() {
    updateIntervals.length = 0;
    lastArrivalByDevice.clear();

    metricsEnabled = true;
    startedAt = new Date().toISOString();
    stoppedAt = null;
    sessionId = generateSessionId();

    return getMetricsStatus();
}

/**
 * Detiene la sesión experimental.
 *
 * Las muestras obtenidas permanecen disponibles.
 */
function stopMetricsSession() {
    metricsEnabled = false;
    stoppedAt = new Date().toISOString();

    // Evita utilizar como referencia temporal un mensaje
    // recibido antes de una futura reanudación.
    lastArrivalByDevice.clear();

    return getMetricsStatus();
}

/**
 * Devuelve el estado actual del módulo.
 */
function getMetricsStatus() {
    return {
        enabled: metricsEnabled,
        sessionId,
        startedAt,
        stoppedAt,
        sampleCount: updateIntervals.length,
        activeDevices: [
            ...new Set(
                updateIntervals.map((sample) => sample.deviceId)
            ),
        ],
        maximumSamples: MAX_SAMPLES,
    };
}

/**
 * Elimina completamente los resultados actuales.
 *
 * Después del reset, la captura queda desactivada.
 */
function resetMetricsSession() {
    metricsEnabled = false;
    startedAt = null;
    stoppedAt = null;
    sessionId = null;

    updateIntervals.length = 0;
    lastArrivalByDevice.clear();

    return getMetricsStatus();
}

// ---------------------------------------------------------
// REGISTRO DEL INTERVALO WEBSOCKET
// ---------------------------------------------------------

/**
 * Registra la llegada de un mensaje válido.
 *
 * Solo funciona cuando metricsEnabled === true.
 *
 * @param {string} deviceId Identificador del dispositivo.
 * @returns {number|null} Intervalo en milisegundos.
 */
function recordMessageArrival(deviceId) {
    // No registrar nada si la sesión está detenida.
    if (!metricsEnabled) {
        return null;
    }

    if (
        typeof deviceId !== "string" ||
        deviceId.trim() === ""
    ) {
        return null;
    }

    const normalizedDeviceId = deviceId.trim();

    // performance.now() es monotónico y adecuado para
    // calcular diferencias temporales internas.
    const nowMonotonic = performance.now();
    const nowIso = new Date().toISOString();

    const previousArrival =
        lastArrivalByDevice.get(normalizedDeviceId);

    lastArrivalByDevice.set(
        normalizedDeviceId,
        nowMonotonic
    );

    // El primer mensaje establece únicamente la referencia.
    if (previousArrival === undefined) {
        return null;
    }

    const intervalMs =
        nowMonotonic - previousArrival;

    if (
        !Number.isFinite(intervalMs) ||
        intervalMs < 0
    ) {
        return null;
    }

    updateIntervals.push({
        sessionId,
        deviceId: normalizedDeviceId,
        intervalMs,
        recordedAt: nowIso,
    });

    // Mantener un máximo controlado de muestras.
    if (updateIntervals.length > MAX_SAMPLES) {
        updateIntervals.splice(
            0,
            updateIntervals.length - MAX_SAMPLES
        );
    }

    return intervalMs;
}

// ---------------------------------------------------------
// FUNCIONES ESTADÍSTICAS
// ---------------------------------------------------------

function calculatePercentile(
    sortedValues,
    percentile
) {
    if (sortedValues.length === 0) {
        return null;
    }

    if (sortedValues.length === 1) {
        return sortedValues[0];
    }

    const position =
        (sortedValues.length - 1) * percentile;

    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);

    if (lowerIndex === upperIndex) {
        return sortedValues[lowerIndex];
    }

    const weight = position - lowerIndex;

    return (
        sortedValues[lowerIndex] * (1 - weight) +
        sortedValues[upperIndex] * weight
    );
}

function calculateStatistics(samples) {
    const values = samples
        .map((sample) => sample.intervalMs)
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);

    const count = values.length;

    if (count === 0) {
        return {
            count: 0,
            meanMs: null,
            standardDeviationMs: null,
            medianMs: null,
            p95Ms: null,
            minMs: null,
            maxMs: null,
            onTimeRatePercent: null,
            delayedRatePercent: null,
            potentialMissedUpdateRatePercent: null,
        };
    }

    const sum = values.reduce(
        (total, value) => total + value,
        0
    );

    const mean = sum / count;

    const variance =
        count > 1
            ? values.reduce((total, value) => {
                return (
                    total +
                    Math.pow(value - mean, 2)
                );
            }, 0) /
            (count - 1)
            : 0;

    const standardDeviation =
        Math.sqrt(variance);

    const onTimeCount = values.filter(
        (value) =>
            value <= ON_TIME_MAXIMUM_MS
    ).length;

    const delayedCount = values.filter(
        (value) =>
            value > ON_TIME_MAXIMUM_MS &&
            value <= DELAYED_MAXIMUM_MS
    ).length;

    const potentialMissedCount =
        values.filter(
            (value) =>
                value > DELAYED_MAXIMUM_MS
        ).length;

    return {
        count,
        meanMs: mean,
        standardDeviationMs:
        standardDeviation,
        medianMs: calculatePercentile(
            values,
            0.5
        ),
        p95Ms: calculatePercentile(
            values,
            0.95
        ),
        minMs: values[0],
        maxMs: values[count - 1],
        onTimeRatePercent:
            (onTimeCount / count) * 100,
        delayedRatePercent:
            (delayedCount / count) * 100,
        potentialMissedUpdateRatePercent:
            (potentialMissedCount / count) *
            100,
    };
}

/**
 * Redondea únicamente los valores decimales.
 */
function formatStatistics(statistics) {
    const formatted = {};

    for (const [key, value] of Object.entries(
        statistics
    )) {
        formatted[key] =
            typeof value === "number"
                ? Number(value.toFixed(3))
                : value;
    }

    return formatted;
}

// ---------------------------------------------------------
// CONSULTA DE RESULTADOS
// ---------------------------------------------------------

function getUpdateIntervalSummary() {
    const devices = {};

    const deviceIds = [
        ...new Set(
            updateIntervals.map(
                (sample) => sample.deviceId
            )
        ),
    ];

    for (const deviceId of deviceIds) {
        const deviceSamples =
            updateIntervals.filter(
                (sample) =>
                    sample.deviceId === deviceId
            );

        devices[deviceId] =
            formatStatistics(
                calculateStatistics(deviceSamples)
            );
    }

    return {
        metric:
            "observed_websocket_update_interval",

        session: {
            sessionId,
            enabled: metricsEnabled,
            startedAt,
            stoppedAt,
        },

        nominalIntervalMs:
        NOMINAL_INTERVAL_MS,

        thresholds: {
            onTimeMaximumMs:
            ON_TIME_MAXIMUM_MS,

            delayedMaximumMs:
            DELAYED_MAXIMUM_MS,

            potentialMissedUpdateAboveMs:
            DELAYED_MAXIMUM_MS,
        },

        global: formatStatistics(
            calculateStatistics(updateIntervals)
        ),

        devices,

        firstRecordedAt:
            updateIntervals.length > 0
                ? updateIntervals[0].recordedAt
                : null,

        lastRecordedAt:
            updateIntervals.length > 0
                ? updateIntervals[
                updateIntervals.length - 1
                    ].recordedAt
                : null,
    };
}

/**
 * Devuelve muestras individuales.
 */
function getRawUpdateIntervals({
                                   deviceId = null,
                                   limit = 1000,
                               } = {}) {
    const parsedLimit = Number.parseInt(
        limit,
        10
    );

    const safeLimit = Math.min(
        Math.max(
            Number.isFinite(parsedLimit)
                ? parsedLimit
                : 1000,
            1
        ),
        10_000
    );

    const filteredSamples = deviceId
        ? updateIntervals.filter(
            (sample) =>
                sample.deviceId === deviceId
        )
        : updateIntervals;

    return filteredSamples.slice(
        -safeLimit
    );
}

/**
 * Devuelve todas las muestras disponibles para exportación.
 *
 * A diferencia del endpoint RAW, esta función no limita
 * la cantidad a 10 000 muestras porque el propósito es
 * exportar la sesión experimental completa.
 *
 * @param {object} options
 * @param {string|null} options.deviceId
 * @returns {Array}
 */
function getUpdateIntervalsForExport({
                                         deviceId = null,
                                     } = {}) {
    if (
        typeof deviceId === "string" &&
        deviceId.trim() !== ""
    ) {
        const normalizedDeviceId =
            deviceId.trim();

        return updateIntervals.filter(
            (sample) =>
                sample.deviceId ===
                normalizedDeviceId
        );
    }

    // Se devuelve una copia para evitar que el código
    // externo pueda modificar el arreglo original.
    return [...updateIntervals];
}

module.exports = {
    startMetricsSession,
    stopMetricsSession,
    resetMetricsSession,
    getMetricsStatus,
    recordMessageArrival,
    getUpdateIntervalSummary,
    getRawUpdateIntervals,
    getUpdateIntervalsForExport,
};