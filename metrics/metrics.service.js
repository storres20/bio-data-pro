// metrics/metrics.service.js

const { performance } = require("node:perf_hooks");

// ---------------------------------------------------------
// CONFIGURACIÓN GENERAL
// ---------------------------------------------------------

const MAX_SAMPLES = 50_000;
const MAX_API_RESPONSE_SAMPLES = 10_000;

// Experimento 3: memoria del backend
const MAX_MEMORY_SAMPLES = 10_000;
const MEMORY_SAMPLE_INTERVAL_MS = 2000;

const NOMINAL_INTERVAL_MS = 2000;

// Umbrales del experimento WebSocket.
const ON_TIME_MAXIMUM_MS = 3000;
const DELAYED_MAXIMUM_MS = 4000;

// Dispositivos considerados en el experimento de API.
const API_TEST_USERNAMES = new Set([
    "MHT-25-001",
    "MHTv2-25-001",
]);

// ---------------------------------------------------------
// ESTADO DE LA SESIÓN EXPERIMENTAL
// ---------------------------------------------------------

let metricsEnabled = false;
let startedAt = null;
let stoppedAt = null;
let sessionId = null;

// Guarda la llegada anterior de cada dispositivo WebSocket.
const lastArrivalByDevice = new Map();

// Experimento 1: intervalos observados en WebSocket.
const updateIntervals = [];

// Experimento 2: tiempos de respuesta de API.
const apiResponseSamples = [];

// Experimento 3: muestras de memoria del proceso Node.js
const memoryUsageSamples = [];

let memorySamplerId = null;
let currentMemoryPhase = "baseline";

// ---------------------------------------------------------
// CONTROL DE LA SESIÓN
// ---------------------------------------------------------

/**
 * Genera un identificador sencillo para cada sesión.
 *
 * @returns {string}
 */
function generateSessionId() {
    return `session-${Date.now()}`;
}

/**
 * Inicia una nueva sesión experimental.
 *
 * Al iniciar:
 * - elimina todas las muestras anteriores;
 * - elimina referencias temporales anteriores;
 * - activa la captura;
 * - genera un nuevo ID de sesión.
 *
 * @returns {object}
 */
function startMetricsSession() {
    updateIntervals.length = 0;
    apiResponseSamples.length = 0;
    memoryUsageSamples.length = 0;

    lastArrivalByDevice.clear();

    metricsEnabled = true;
    startedAt = new Date().toISOString();
    stoppedAt = null;
    sessionId = generateSessionId();

    currentMemoryPhase = "baseline";

    startMemorySampler();

    return getMetricsStatus();
}

/**
 * Detiene la sesión experimental.
 *
 * Las muestras permanecen disponibles para:
 * - consultar el summary;
 * - consultar datos RAW;
 * - exportar CSV.
 *
 * @returns {object}
 */
function stopMetricsSession() {
    /*
     * Toma una última muestra antes de desactivar
     * la sesión.
     */
    recordMemoryUsage();
    stopMemorySampler();

    metricsEnabled = false;
    stoppedAt = new Date().toISOString();

    lastArrivalByDevice.clear();

    return getMetricsStatus();
}

/**
 * Devuelve el estado actual del módulo de métricas.
 *
 * @returns {object}
 */
function getMetricsStatus() {
    return {
        enabled: metricsEnabled,
        sessionId,
        startedAt,
        stoppedAt,

        /*
         * Se mantiene sampleCount para compatibilidad con
         * el código anterior del Experimento 1.
         */
        sampleCount: updateIntervals.length,

        totalSamples:
            updateIntervals.length +
            apiResponseSamples.length +
            memoryUsageSamples.length,

        experiments: {
            websocketUpdateInterval: {
                samples: updateIntervals.length,
                maximumSamples: MAX_SAMPLES,
            },

            apiResponseTime: {
                samples: apiResponseSamples.length,
                maximumSamples:
                MAX_API_RESPONSE_SAMPLES,
                testedUsernames:
                    Array.from(API_TEST_USERNAMES),
            },

            backendMemoryUsage: {
                samples:
                memoryUsageSamples.length,

                maximumSamples:
                MAX_MEMORY_SAMPLES,

                sampleIntervalMs:
                MEMORY_SAMPLE_INTERVAL_MS,

                currentPhase:
                currentMemoryPhase,

                samplerActive:
                    memorySamplerId !== null,
            },
        },

        activeDevices: [
            ...new Set(
                updateIntervals.map(
                    (sample) => sample.deviceId
                )
            ),
        ],

        maximumSamples: {
            websocketUpdateInterval: MAX_SAMPLES,
            apiResponseTime:
            MAX_API_RESPONSE_SAMPLES,
            backendMemoryUsage:
            MAX_MEMORY_SAMPLES,
        },
    };
}

/**
 * Elimina todos los resultados actuales.
 *
 * Después del reset, la captura queda desactivada.
 *
 * @returns {object}
 */
function resetMetricsSession() {
    stopMemorySampler();

    metricsEnabled = false;
    startedAt = null;
    stoppedAt = null;
    sessionId = null;

    updateIntervals.length = 0;
    apiResponseSamples.length = 0;
    memoryUsageSamples.length = 0;

    currentMemoryPhase = "baseline";

    lastArrivalByDevice.clear();

    return getMetricsStatus();
}

// ---------------------------------------------------------
// EXPERIMENTO 1:
// REGISTRO DEL INTERVALO WEBSOCKET
// ---------------------------------------------------------

/**
 * Registra la llegada de un mensaje válido de WebSocket.
 *
 * Solo registra cuando metricsEnabled === true.
 *
 * El primer mensaje de cada dispositivo establece la
 * referencia temporal y no genera una muestra.
 *
 * @param {string} deviceId
 * @returns {number|null}
 */
function recordMessageArrival(deviceId) {
    if (!metricsEnabled) {
        return null;
    }

    if (
        typeof deviceId !== "string" ||
        deviceId.trim() === ""
    ) {
        return null;
    }

    const normalizedDeviceId =
        deviceId.trim();

    /*
     * performance.now() es monotónico y es apropiado
     * para calcular diferencias temporales internas.
     */
    const nowMonotonic = performance.now();
    const nowIso = new Date().toISOString();

    const previousArrival =
        lastArrivalByDevice.get(
            normalizedDeviceId
        );

    lastArrivalByDevice.set(
        normalizedDeviceId,
        nowMonotonic
    );

    /*
     * El primer mensaje solamente crea la referencia.
     */
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

    /*
     * Mantiene un máximo controlado de muestras.
     * Si se supera, elimina las muestras más antiguas.
     */
    if (updateIntervals.length > MAX_SAMPLES) {
        updateIntervals.splice(
            0,
            updateIntervals.length - MAX_SAMPLES
        );
    }

    return intervalMs;
}

// ---------------------------------------------------------
// EXPERIMENTO 2:
// REGISTRO DEL TIEMPO DE RESPUESTA API
// ---------------------------------------------------------

/**
 * Registra una muestra de tiempo de respuesta de API.
 *
 * La medición debe ser generada desde el middleware cuando
 * finaliza una solicitud GET válida.
 *
 * @param {object} data
 * @param {string} data.method
 * @param {string} data.route
 * @param {string} data.requestUrl
 * @param {string} data.username
 * @param {number} data.statusCode
 * @param {number} data.responseTimeMs
 * @param {number|null} data.payloadBytes
 * @param {number|null} data.recordsReturned
 * @param {Date} data.recordedAt
 * @returns {object|null}
 */
function recordApiResponse({
                               method,
                               route,
                               requestUrl,
                               username,
                               statusCode,
                               responseTimeMs,
                               payloadBytes,
                               recordsReturned,
                               recordedAt = new Date(),
                           }) {
    if (!metricsEnabled) {
        return null;
    }

    if (
        typeof username !== "string" ||
        !API_TEST_USERNAMES.has(
            username.trim()
        )
    ) {
        return null;
    }

    const normalizedUsername =
        username.trim();

    const numericResponseTime =
        Number(responseTimeMs);

    const numericPayloadBytes =
        payloadBytes === null ||
        payloadBytes === undefined
            ? null
            : Number(payloadBytes);

    const numericRecordsReturned =
        recordsReturned === null ||
        recordsReturned === undefined
            ? null
            : Number(recordsReturned);

    const numericStatusCode =
        Number(statusCode);

    if (
        !Number.isFinite(
            numericResponseTime
        ) ||
        numericResponseTime < 0
    ) {
        return null;
    }

    const validPayloadBytes =
        numericPayloadBytes !== null &&
        Number.isFinite(
            numericPayloadBytes
        ) &&
        numericPayloadBytes >= 0
            ? numericPayloadBytes
            : null;

    const validRecordsReturned =
        numericRecordsReturned !== null &&
        Number.isFinite(
            numericRecordsReturned
        ) &&
        numericRecordsReturned >= 0
            ? numericRecordsReturned
            : null;

    const sample = {
        sessionId,

        username: normalizedUsername,

        method:
            typeof method === "string"
                ? method
                : null,

        /*
         * Ruta general:
         * /api/v1/datas/username/:username
         */
        route:
            typeof route === "string"
                ? route
                : null,

        /*
         * Ruta exacta utilizada:
         * /api/v1/datas/username/MHT-25-001
         */
        requestUrl:
            typeof requestUrl === "string"
                ? requestUrl
                : null,

        statusCode:
            Number.isFinite(
                numericStatusCode
            )
                ? numericStatusCode
                : null,

        recordedAt:
            recordedAt instanceof Date
                ? recordedAt.toISOString()
                : new Date(
                    recordedAt
                ).toISOString(),

        responseTimeMs:
        numericResponseTime,

        payloadBytes:
        validPayloadBytes,

        payloadKilobytes:
            validPayloadBytes === null
                ? null
                : validPayloadBytes / 1024,

        payloadMegabytes:
            validPayloadBytes === null
                ? null
                : validPayloadBytes /
                (1024 * 1024),

        recordsReturned:
        validRecordsReturned,
    };

    apiResponseSamples.push(sample);

    /*
     * Mantiene un máximo de muestras y elimina las
     * más antiguas si se supera.
     */
    if (
        apiResponseSamples.length >
        MAX_API_RESPONSE_SAMPLES
    ) {
        apiResponseSamples.splice(
            0,
            apiResponseSamples.length -
            MAX_API_RESPONSE_SAMPLES
        );
    }

    return sample;
}

// ---------------------------------------------------------
// FUNCIONES ESTADÍSTICAS GENERALES
// ---------------------------------------------------------

/**
 * Calcula un percentil mediante interpolación lineal.
 *
 * El percentile debe expresarse entre 0 y 1:
 * - 0.50 = mediana;
 * - 0.95 = P95;
 * - 0.99 = P99.
 *
 * @param {number[]} sortedValues
 * @param {number} percentile
 * @returns {number|null}
 */
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
        (sortedValues.length - 1) *
        percentile;

    const lowerIndex =
        Math.floor(position);

    const upperIndex =
        Math.ceil(position);

    if (lowerIndex === upperIndex) {
        return sortedValues[lowerIndex];
    }

    const weight =
        position - lowerIndex;

    return (
        sortedValues[lowerIndex] *
        (1 - weight) +
        sortedValues[upperIndex] *
        weight
    );
}

/**
 * Calcula la media aritmética.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function calculateMean(values) {
    if (values.length === 0) {
        return null;
    }

    const sum = values.reduce(
        (total, value) =>
            total + value,
        0
    );

    return sum / values.length;
}

/**
 * Calcula la desviación estándar muestral.
 *
 * Se utiliza n - 1 porque las mediciones representan una
 * muestra del comportamiento posible del servidor.
 *
 * @param {number[]} values
 * @param {number|null} providedMean
 * @returns {number|null}
 */
function calculateSampleStandardDeviation(
    values,
    providedMean = null
) {
    const count = values.length;

    if (count === 0) {
        return null;
    }

    if (count === 1) {
        return 0;
    }

    const mean =
        providedMean !== null
            ? providedMean
            : calculateMean(values);

    const squaredDifferences =
        values.reduce(
            (total, value) =>
                total +
                Math.pow(
                    value - mean,
                    2
                ),
            0
        );

    const variance =
        squaredDifferences /
        (count - 1);

    return Math.sqrt(variance);
}

/**
 * Redondea los valores numéricos de un objeto.
 *
 * @param {object} statistics
 * @returns {object}
 */
function formatStatistics(statistics) {
    const formatted = {};

    for (
        const [key, value]
        of Object.entries(statistics)
        ) {
        formatted[key] =
            typeof value === "number" &&
            Number.isFinite(value)
                ? Number(
                    value.toFixed(3)
                )
                : value;
    }

    return formatted;
}

// ---------------------------------------------------------
// ESTADÍSTICAS DEL EXPERIMENTO 1
// ---------------------------------------------------------

/**
 * Calcula estadísticas de intervalos WebSocket.
 *
 * @param {object[]} samples
 * @returns {object}
 */
function calculateUpdateIntervalStatistics(
    samples
) {
    const values = samples
        .map(
            (sample) =>
                sample.intervalMs
        )
        .filter(
            (value) =>
                Number.isFinite(value)
        )
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
            potentialMissedUpdateRatePercent:
                null,
        };
    }

    const mean =
        calculateMean(values);

    const standardDeviation =
        calculateSampleStandardDeviation(
            values,
            mean
        );

    const onTimeCount =
        values.filter(
            (value) =>
                value <=
                ON_TIME_MAXIMUM_MS
        ).length;

    const delayedCount =
        values.filter(
            (value) =>
                value >
                ON_TIME_MAXIMUM_MS &&
                value <=
                DELAYED_MAXIMUM_MS
        ).length;

    const potentialMissedCount =
        values.filter(
            (value) =>
                value >
                DELAYED_MAXIMUM_MS
        ).length;

    return {
        count,

        meanMs: mean,

        standardDeviationMs:
        standardDeviation,

        medianMs:
            calculatePercentile(
                values,
                0.5
            ),

        p95Ms:
            calculatePercentile(
                values,
                0.95
            ),

        minMs: values[0],

        maxMs:
            values[count - 1],

        onTimeRatePercent:
            (onTimeCount / count) *
            100,

        delayedRatePercent:
            (delayedCount / count) *
            100,

        potentialMissedUpdateRatePercent:
            (
                potentialMissedCount /
                count
            ) * 100,
    };
}

// ---------------------------------------------------------
// SUMMARY DEL EXPERIMENTO 1
// ---------------------------------------------------------

/**
 * Devuelve el resumen del intervalo WebSocket.
 *
 * @returns {object}
 */
function getUpdateIntervalSummary() {
    const devices = {};

    const deviceIds = [
        ...new Set(
            updateIntervals.map(
                (sample) =>
                    sample.deviceId
            )
        ),
    ];

    for (const deviceId of deviceIds) {
        const deviceSamples =
            updateIntervals.filter(
                (sample) =>
                    sample.deviceId ===
                    deviceId
            );

        devices[deviceId] =
            formatStatistics(
                calculateUpdateIntervalStatistics(
                    deviceSamples
                )
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
            calculateUpdateIntervalStatistics(
                updateIntervals
            )
        ),

        devices,

        firstRecordedAt:
            updateIntervals.length > 0
                ? updateIntervals[0]
                    .recordedAt
                : null,

        lastRecordedAt:
            updateIntervals.length > 0
                ? updateIntervals[
                updateIntervals.length -
                1
                    ].recordedAt
                : null,
    };
}

// ---------------------------------------------------------
// RAW DEL EXPERIMENTO 1
// ---------------------------------------------------------

/**
 * Devuelve muestras individuales del experimento WebSocket.
 *
 * @param {object} options
 * @param {string|null} options.deviceId
 * @param {number} options.limit
 * @returns {object[]}
 */
function getRawUpdateIntervals({
                                   deviceId = null,
                                   limit = 1000,
                               } = {}) {
    const parsedLimit =
        Number.parseInt(limit, 10);

    const safeLimit = Math.min(
        Math.max(
            Number.isFinite(
                parsedLimit
            )
                ? parsedLimit
                : 1000,
            1
        ),
        10_000
    );

    const normalizedDeviceId =
        typeof deviceId === "string"
            ? deviceId.trim()
            : null;

    const filteredSamples =
        normalizedDeviceId
            ? updateIntervals.filter(
                (sample) =>
                    sample.deviceId ===
                    normalizedDeviceId
            )
            : updateIntervals;

    return filteredSamples.slice(
        -safeLimit
    );
}

/**
 * Devuelve las muestras WebSocket para exportación.
 *
 * @param {object} options
 * @param {string|null} options.deviceId
 * @returns {object[]}
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

    return [...updateIntervals];
}

// ---------------------------------------------------------
// ESTADÍSTICAS DEL EXPERIMENTO 2
// ---------------------------------------------------------

/**
 * Calcula el resumen del tiempo de respuesta para un
 * conjunto de muestras pertenecientes a un username.
 *
 * @param {object[]} samples
 * @param {string} username
 * @returns {object}
 */
function summarizeApiResponseSamples(
    samples,
    username
) {
    if (samples.length === 0) {
        return {
            username,
            count: 0,
            method: "GET",
            route:
                "/api/v1/datas/username/:username",

            successfulRequests: 0,
            failedRequests: 0,
            successRatePercent: null,

            recordsReturned: null,

            averagePayloadBytes: null,
            averagePayloadKilobytes: null,
            averagePayloadMegabytes: null,

            meanResponseTimeMs: null,
            standardDeviationMs: null,
            medianMs: null,
            p95Ms: null,
            p99Ms: null,
            minMs: null,
            maxMs: null,

            firstRecordedAt: null,
            lastRecordedAt: null,
        };
    }

    const responseTimes = samples
        .map(
            (sample) =>
                sample.responseTimeMs
        )
        .filter(
            (value) =>
                Number.isFinite(value)
        )
        .sort((a, b) => a - b);

    const payloadValues = samples
        .map(
            (sample) =>
                sample.payloadBytes
        )
        .filter(
            (value) =>
                Number.isFinite(value)
        );

    const recordsValues = samples
        .map(
            (sample) =>
                sample.recordsReturned
        )
        .filter(
            (value) =>
                Number.isFinite(value)
        );

    const successfulRequests =
        samples.filter(
            (sample) =>
                Number.isFinite(
                    sample.statusCode
                ) &&
                sample.statusCode >= 200 &&
                sample.statusCode < 300
        ).length;

    const failedRequests =
        samples.length -
        successfulRequests;

    const meanResponseTime =
        calculateMean(
            responseTimes
        );

    const standardDeviation =
        calculateSampleStandardDeviation(
            responseTimes,
            meanResponseTime
        );

    const averagePayloadBytes =
        calculateMean(payloadValues);

    const averageRecordsReturned =
        calculateMean(recordsValues);

    const minPayloadBytes =
        payloadValues.length > 0
            ? Math.min(...payloadValues)
            : null;

    const maxPayloadBytes =
        payloadValues.length > 0
            ? Math.max(...payloadValues)
            : null;

    const minRecordsReturned =
        recordsValues.length > 0
            ? Math.min(...recordsValues)
            : null;

    const maxRecordsReturned =
        recordsValues.length > 0
            ? Math.max(...recordsValues)
            : null;

    /*
     * Throughput aproximado del payload.
     *
     * MB/s =
     * payload promedio en MB /
     * tiempo promedio en segundos.
     */
    const averageThroughputMbps =
        averagePayloadBytes !== null &&
        meanResponseTime !== null &&
        meanResponseTime > 0
            ? (
                averagePayloadBytes /
                (1024 * 1024)
            ) /
            (
                meanResponseTime /
                1000
            )
            : null;

    return formatStatistics({
        username,
        count: samples.length,

        method:
            samples[0]?.method ??
            "GET",

        route:
            samples[0]?.route ??
            "/api/v1/datas/username/:username",

        successfulRequests,
        failedRequests,

        successRatePercent:
            (
                successfulRequests /
                samples.length
            ) * 100,

        recordsReturned:
        averageRecordsReturned,

        minimumRecordsReturned:
        minRecordsReturned,

        maximumRecordsReturned:
        maxRecordsReturned,

        averagePayloadBytes,

        averagePayloadKilobytes:
            averagePayloadBytes === null
                ? null
                : averagePayloadBytes /
                1024,

        averagePayloadMegabytes:
            averagePayloadBytes === null
                ? null
                : averagePayloadBytes /
                (1024 * 1024),

        minimumPayloadBytes:
        minPayloadBytes,

        maximumPayloadBytes:
        maxPayloadBytes,

        averageThroughputMBps:
        averageThroughputMbps,

        meanResponseTimeMs:
        meanResponseTime,

        standardDeviationMs:
        standardDeviation,

        medianMs:
            calculatePercentile(
                responseTimes,
                0.5
            ),

        p95Ms:
            calculatePercentile(
                responseTimes,
                0.95
            ),

        p99Ms:
            calculatePercentile(
                responseTimes,
                0.99
            ),

        minMs:
            responseTimes.length > 0
                ? responseTimes[0]
                : null,

        maxMs:
            responseTimes.length > 0
                ? responseTimes[
                responseTimes.length -
                1
                    ]
                : null,

        firstRecordedAt:
            samples[0]?.recordedAt ??
            null,

        lastRecordedAt:
            samples[
            samples.length - 1
                ]?.recordedAt ?? null,
    });
}

// ---------------------------------------------------------
// SUMMARY DEL EXPERIMENTO 2
// ---------------------------------------------------------

/**
 * Devuelve el resumen general del experimento de API.
 *
 * @returns {object}
 */
function getApiResponseSummary() {
    const results = {};

    for (
        const username
        of API_TEST_USERNAMES
        ) {
        const usernameSamples =
            apiResponseSamples.filter(
                (sample) =>
                    sample.username ===
                    username
            );

        results[username] =
            summarizeApiResponseSamples(
                usernameSamples,
                username
            );
    }

    const allResponseTimes =
        apiResponseSamples
            .map(
                (sample) =>
                    sample.responseTimeMs
            )
            .filter(
                (value) =>
                    Number.isFinite(value)
            )
            .sort((a, b) => a - b);

    const globalMean =
        calculateMean(
            allResponseTimes
        );

    const globalStandardDeviation =
        calculateSampleStandardDeviation(
            allResponseTimes,
            globalMean
        );

    const successfulRequests =
        apiResponseSamples.filter(
            (sample) =>
                Number.isFinite(
                    sample.statusCode
                ) &&
                sample.statusCode >= 200 &&
                sample.statusCode < 300
        ).length;

    return {
        metric:
            "api_response_time",

        measurementScope:
            "Server-side request processing time from middleware entry until HTTP response finish",

        endpoint:
            "/api/v1/datas/username/:username",

        session: {
            sessionId,
            enabled: metricsEnabled,
            startedAt,
            stoppedAt,
        },

        testedUsernames:
            Array.from(
                API_TEST_USERNAMES
            ),

        totalSamples:
        apiResponseSamples.length,

        global:
            allResponseTimes.length === 0
                ? {
                    count: 0,
                    successfulRequests: 0,
                    failedRequests: 0,
                    successRatePercent:
                        null,
                    meanResponseTimeMs:
                        null,
                    standardDeviationMs:
                        null,
                    medianMs: null,
                    p95Ms: null,
                    p99Ms: null,
                    minMs: null,
                    maxMs: null,
                }
                : formatStatistics({
                    count:
                    apiResponseSamples.length,

                    successfulRequests,

                    failedRequests:
                        apiResponseSamples.length -
                        successfulRequests,

                    successRatePercent:
                        (
                            successfulRequests /
                            apiResponseSamples.length
                        ) * 100,

                    meanResponseTimeMs:
                    globalMean,

                    standardDeviationMs:
                    globalStandardDeviation,

                    medianMs:
                        calculatePercentile(
                            allResponseTimes,
                            0.5
                        ),

                    p95Ms:
                        calculatePercentile(
                            allResponseTimes,
                            0.95
                        ),

                    p99Ms:
                        calculatePercentile(
                            allResponseTimes,
                            0.99
                        ),

                    minMs:
                        allResponseTimes[0],

                    maxMs:
                        allResponseTimes[
                        allResponseTimes.length -
                        1
                            ],
                }),

        results,

        firstRecordedAt:
            apiResponseSamples.length > 0
                ? apiResponseSamples[0]
                    .recordedAt
                : null,

        lastRecordedAt:
            apiResponseSamples.length > 0
                ? apiResponseSamples[
                apiResponseSamples.length -
                1
                    ].recordedAt
                : null,
    };
}

// ---------------------------------------------------------
// RAW DEL EXPERIMENTO 2
// ---------------------------------------------------------

/**
 * Devuelve muestras individuales del experimento API.
 *
 * @param {object} options
 * @param {string|null} options.username
 * @param {number} options.limit
 * @returns {object[]}
 */
function getApiResponseRawSamples({
                                      username = null,
                                      limit = 1000,
                                  } = {}) {
    const parsedLimit =
        Number.parseInt(limit, 10);

    const safeLimit = Math.min(
        Math.max(
            Number.isFinite(
                parsedLimit
            )
                ? parsedLimit
                : 1000,
            1
        ),
        MAX_API_RESPONSE_SAMPLES
    );

    const normalizedUsername =
        typeof username === "string"
            ? username.trim()
            : null;

    const filteredSamples =
        normalizedUsername
            ? apiResponseSamples.filter(
                (sample) =>
                    sample.username ===
                    normalizedUsername
            )
            : apiResponseSamples;

    return filteredSamples.slice(
        -safeLimit
    );
}

/**
 * Devuelve todas las muestras API disponibles para CSV.
 *
 * @param {string|null} username
 * @returns {object[]}
 */
function getApiResponseSamplesForExport(
    username = null
) {
    if (
        typeof username === "string" &&
        username.trim() !== ""
    ) {
        const normalizedUsername =
            username.trim();

        return apiResponseSamples.filter(
            (sample) =>
                sample.username ===
                normalizedUsername
        );
    }

    return [...apiResponseSamples];
}

// =========================================================
// EXPERIMENTO 3:
// BACKEND MEMORY USAGE
// =========================================================

function bytesToMegabytes(bytes) {
    return bytes / (1024 * 1024);
}

/**
 * Toma una muestra de memoria del proceso Node.js.
 */
function recordMemoryUsage() {
    if (!metricsEnabled) {
        return null;
    }

    const memory = process.memoryUsage();

    const elapsedMs =
        startedAt
            ? Date.now() -
            new Date(startedAt).getTime()
            : null;

    const sample = {
        sessionId,
        sampleNumber:
            memoryUsageSamples.length + 1,

        recordedAt:
            new Date().toISOString(),

        elapsedMs,

        elapsedSeconds:
            elapsedMs === null
                ? null
                : elapsedMs / 1000,

        phase: currentMemoryPhase,

        rssBytes: memory.rss,
        rssMegabytes:
            bytesToMegabytes(memory.rss),

        heapTotalBytes:
        memory.heapTotal,
        heapTotalMegabytes:
            bytesToMegabytes(
                memory.heapTotal
            ),

        heapUsedBytes:
        memory.heapUsed,
        heapUsedMegabytes:
            bytesToMegabytes(
                memory.heapUsed
            ),

        externalBytes:
        memory.external,
        externalMegabytes:
            bytesToMegabytes(
                memory.external
            ),

        arrayBuffersBytes:
            memory.arrayBuffers ?? 0,
        arrayBuffersMegabytes:
            bytesToMegabytes(
                memory.arrayBuffers ?? 0
            ),
    };

    memoryUsageSamples.push(sample);

    if (
        memoryUsageSamples.length >
        MAX_MEMORY_SAMPLES
    ) {
        memoryUsageSamples.splice(
            0,
            memoryUsageSamples.length -
            MAX_MEMORY_SAMPLES
        );
    }

    return sample;
}

/**
 * Inicia el muestreo automático cada 2 segundos.
 */
function startMemorySampler() {
    stopMemorySampler();

    currentMemoryPhase = "baseline";

    // Muestra inicial en t ≈ 0
    recordMemoryUsage();

    memorySamplerId = setInterval(
        recordMemoryUsage,
        MEMORY_SAMPLE_INTERVAL_MS
    );
}

/**
 * Detiene el muestreo automático.
 */
function stopMemorySampler() {
    if (memorySamplerId !== null) {
        clearInterval(memorySamplerId);
        memorySamplerId = null;
    }
}

/**
 * Permite cambiar manualmente la fase experimental.
 */
function setMemoryPhase(phase) {
    const allowedPhases = new Set([
        "baseline",
        "api_load",
        "recovery",
        "post_load",
    ]);

    if (
        typeof phase !== "string" ||
        !allowedPhases.has(phase.trim())
    ) {
        throw new Error(
            "Invalid memory phase"
        );
    }

    currentMemoryPhase = phase.trim();

    /*
     * Registra inmediatamente una muestra para marcar
     * con precisión el cambio de fase.
     */
    recordMemoryUsage();

    return {
        phase: currentMemoryPhase,
        changedAt:
            new Date().toISOString(),
        memorySamples:
        memoryUsageSamples.length,
    };
}

function calculateMemoryMetricStatistics(
    samples,
    property
) {
    const values = samples
        .map((sample) => sample[property])
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    if (values.length === 0) {
        return {
            count: 0,
            mean: null,
            standardDeviation: null,
            median: null,
            p95: null,
            min: null,
            max: null,
        };
    }

    const mean = calculateMean(values);

    return formatStatistics({
        count: values.length,
        mean,
        standardDeviation:
            calculateSampleStandardDeviation(
                values,
                mean
            ),
        median:
            calculatePercentile(
                values,
                0.5
            ),
        p95:
            calculatePercentile(
                values,
                0.95
            ),
        min: values[0],
        max:
            values[values.length - 1],
    });
}

function summarizeMemoryGroup(samples) {
    if (samples.length === 0) {
        return {
            count: 0,
            rssMegabytes: null,
            heapUsedMegabytes: null,
            heapTotalMegabytes: null,
            externalMegabytes: null,
            arrayBuffersMegabytes: null,
        };
    }

    return {
        count: samples.length,

        rssMegabytes:
            calculateMemoryMetricStatistics(
                samples,
                "rssMegabytes"
            ),

        heapUsedMegabytes:
            calculateMemoryMetricStatistics(
                samples,
                "heapUsedMegabytes"
            ),

        heapTotalMegabytes:
            calculateMemoryMetricStatistics(
                samples,
                "heapTotalMegabytes"
            ),

        externalMegabytes:
            calculateMemoryMetricStatistics(
                samples,
                "externalMegabytes"
            ),

        arrayBuffersMegabytes:
            calculateMemoryMetricStatistics(
                samples,
                "arrayBuffersMegabytes"
            ),
    };
}

/**
 * Calcula cambio entre la primera y última muestra.
 */
function calculateMemoryChange(
    firstSample,
    lastSample
) {
    if (!firstSample || !lastSample) {
        return null;
    }

    return formatStatistics({
        rssChangeMegabytes:
            lastSample.rssMegabytes -
            firstSample.rssMegabytes,

        heapUsedChangeMegabytes:
            lastSample.heapUsedMegabytes -
            firstSample.heapUsedMegabytes,

        heapTotalChangeMegabytes:
            lastSample.heapTotalMegabytes -
            firstSample.heapTotalMegabytes,

        externalChangeMegabytes:
            lastSample.externalMegabytes -
            firstSample.externalMegabytes,

        arrayBuffersChangeMegabytes:
            lastSample.arrayBuffersMegabytes -
            firstSample.arrayBuffersMegabytes,
    });
}

function getMemoryUsageSummary() {
    const phases = {};

    const phaseNames = [
        "baseline",
        "api_load",
        "recovery",
        "post_load",
    ];

    for (const phase of phaseNames) {
        const phaseSamples =
            memoryUsageSamples.filter(
                (sample) =>
                    sample.phase === phase
            );

        phases[phase] =
            summarizeMemoryGroup(
                phaseSamples
            );
    }

    const firstSample =
        memoryUsageSamples[0] ?? null;

    const lastSample =
        memoryUsageSamples[
        memoryUsageSamples.length - 1
            ] ?? null;

    return {
        metric:
            "backend_memory_usage",

        measurementScope:
            "Node.js process memory measured using process.memoryUsage()",

        sampleIntervalMs:
        MEMORY_SAMPLE_INTERVAL_MS,

        session: {
            sessionId,
            enabled: metricsEnabled,
            startedAt,
            stoppedAt,
        },

        currentPhase:
        currentMemoryPhase,

        totalSamples:
        memoryUsageSamples.length,

        global:
            summarizeMemoryGroup(
                memoryUsageSamples
            ),

        phases,

        changeFromFirstToLast:
            calculateMemoryChange(
                firstSample,
                lastSample
            ),

        firstRecordedAt:
            firstSample?.recordedAt ??
            null,

        lastRecordedAt:
            lastSample?.recordedAt ??
            null,
    };
}

function getMemoryUsageRawSamples({
                                      phase = null,
                                      limit = 1000,
                                  } = {}) {
    const parsedLimit =
        Number.parseInt(limit, 10);

    const safeLimit = Math.min(
        Math.max(
            Number.isFinite(parsedLimit)
                ? parsedLimit
                : 1000,
            1
        ),
        MAX_MEMORY_SAMPLES
    );

    const normalizedPhase =
        typeof phase === "string" &&
        phase.trim() !== ""
            ? phase.trim()
            : null;

    const filteredSamples =
        normalizedPhase
            ? memoryUsageSamples.filter(
                (sample) =>
                    sample.phase ===
                    normalizedPhase
            )
            : memoryUsageSamples;

    return filteredSamples.slice(
        -safeLimit
    );
}

function getMemoryUsageSamplesForExport(
    phase = null
) {
    if (
        typeof phase === "string" &&
        phase.trim() !== ""
    ) {
        const normalizedPhase =
            phase.trim();

        return memoryUsageSamples.filter(
            (sample) =>
                sample.phase ===
                normalizedPhase
        );
    }

    return [...memoryUsageSamples];
}

// ---------------------------------------------------------
// EXPORTACIONES
// ---------------------------------------------------------

module.exports = {
    // Control de sesión
    startMetricsSession,
    stopMetricsSession,
    resetMetricsSession,
    getMetricsStatus,

    // Experimento 1: WebSocket
    recordMessageArrival,
    getUpdateIntervalSummary,
    getRawUpdateIntervals,
    getUpdateIntervalsForExport,

    // Experimento 2: API response time
    recordApiResponse,
    getApiResponseSummary,
    getApiResponseRawSamples,
    getApiResponseSamplesForExport,

    // Experimento 3: Backend Memory Usage
    setMemoryPhase,
    getMemoryUsageSummary,
    getMemoryUsageRawSamples,
    getMemoryUsageSamplesForExport,
};