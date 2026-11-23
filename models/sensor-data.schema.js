const mongoose = require('mongoose');

function createSensorDataSchema() {
    const schema = new mongoose.Schema({
        temperature: { type: Number, required: false, default: null },
        humidity: { type: Number, required: false, default: null },
        dsTemperature: { type: Number, required: false, default: null },
        username: { type: String, required: true },
        datetime: { type: Date, required: true },
        device_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' },
        doorStatus: { type: String, enum: ['open', 'closed'], default: 'closed' },
        time_slot: { type: Date, required: true }
    }, {
        timestamps: true
    });

    schema.index({ username: 1, time_slot: 1 }, { unique: true });

    return schema;
}

module.exports = createSensorDataSchema;
