const Device = require('./models/device.model');

async function withDeviceRecord(filter, write) {
    const device = await Device.findOneAndUpdate({ ...filter, archived_at: null },
        { $inc: { pendingRecordWrites: 1 } }).select('_id').lean();
    try {
        return await write(device?._id ?? null);
    } finally {
        if (device) await Device.updateOne({ _id: device._id }, { $inc: { pendingRecordWrites: -1 } });
    }
}

module.exports = withDeviceRecord;
