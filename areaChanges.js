const { connection } = require('mongoose');
const Area = require('./models/area.model');

async function withAreas(ids, change, existingSession) {
    const orderedIds = [...new Set(ids.map(id => String(id).toLowerCase()))].sort();
    async function run(session) {
        // Serialize assignments and removal through the same area documents.
        for (const id of orderedIds) {
            const area = await Area.updateOne({ _id: id }, { $inc: { referenceVersion: 1 } }, { session });
            if (!area.matchedCount) throw Object.assign(new Error('Area not found'), { status: 404 });
        }
        return change(session);
    }
    if (existingSession || !orderedIds.length) return run(existingSession ?? null);
    return connection.transaction(run);
}

module.exports = { withAreas };
