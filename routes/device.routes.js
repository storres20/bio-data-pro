const express = require('express');
const router = express.Router();
const Device = require('../models/device.model');
const mongoose = require('mongoose');
const { authenticate, deviceScope, requireWebAdmin } = require('../access');
const Area = require('../models/area.model');
const Hospital = require('../models/hospital.model');
const { withAreas } = require('../areaChanges');
const recordModels = [require('../models/fourh-data.model'), require('../models/tenmin-data.model'),
    require('../models/data.model'), require('../models/door-event.model')];

const fields = ['name', 'brand', 'model', 'serie'];
const invalidId = id => !mongoose.isObjectIdOrHexString(id);
const populateLocation = query => query.populate('hospital_id area_id', 'name');

async function deviceDetails(body, hospitalId, session) {
    if (invalidId(hospitalId) || invalidId(body.area_id)) return null;
    const details = Object.fromEntries(fields.map(field => [field,
        typeof body[field] === 'string' ? body[field].trim() : '']));
    if (Object.values(details).some(value => !value)) return null;
    const hospital = await Hospital.updateOne({ _id: hospitalId }, { $addToSet: { area_ids: body.area_id } }, { session });
    return hospital.matchedCount ? { ...details, area_id: body.area_id } : null;
}

router.get('/area-catalog', authenticate, requireWebAdmin, async (req, res) => {
    res.json(await Area.find().select('name').sort({ name: 1 }).lean());
});

// ✅ Get devices by hospital ID (with hospital and area populated)
router.get('/hospital/:id', authenticate, async (req, res) => {
    try {
        const hospitalId = req.params.id;

        // Asegúrate de que sea un ObjectId válido
        if (!mongoose.Types.ObjectId.isValid(hospitalId)) {
            return res.status(400).json({ message: 'Invalid hospital ID format' });
        }

        if (req.account.role !== 'web-admin' && hospitalId !== String(req.account.hospital_id)) {
            return res.status(403).json({ message: 'Hospital access required' });
        }
        const active = req.query.includeArchived === 'true' ? {} : { archived_at: null };
        const devices = await Device.find({ ...deviceScope(req.account), hospital_id: hospitalId, ...active })
            .populate('hospital_id', 'name')
            .populate('area_id', 'name');

        res.status(200).json(devices);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ Get all devices (admin or debug use)
router.get('/', authenticate, requireWebAdmin, async (req, res) => {
    try {
        const devices = await Device.find()
            .populate('hospital_id', 'name')
            .populate('area_id', 'name');
        res.status(200).json(devices);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ Create new device
router.post('/', authenticate, requireWebAdmin, async (req, res) => {
    const { hospital_id } = req.body;
    try {
        if (invalidId(req.body.area_id)) return res.status(400).json({ message: 'Invalid area' });
        const savedDevice = await withAreas([req.body.area_id], async session => {
            const details = await deviceDetails(req.body, hospital_id, session);
            if (!details) return null;
            const [created] = await Device.create([{ ...details, hospital_id }], { session });
            return created;
        });
        if (!savedDevice) return res.status(400).json({ message: 'Enter valid device details, hospital and area' });
        savedDevice.$session(null);
        await savedDevice.populate('hospital_id area_id', 'name');
        res.status(201).json(savedDevice);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// ✅ PATCH: Assign sensor username to a device
router.patch('/:id', authenticate, requireWebAdmin, async (req, res) => {
    if (invalidId(req.params.id)) return res.status(404).json({ message: 'Device not found' });
    const existing = await Device.findById(req.params.id).select('hospital_id').lean();
    if (!existing) return res.status(404).json({ message: 'Device not found' });
    if (invalidId(req.body.area_id)) return res.status(400).json({ message: 'Invalid area' });
    let device;
    try {
        device = await withAreas([req.body.area_id], async session => {
            const details = await deviceDetails(req.body, existing.hospital_id, session);
            if (!details) throw Object.assign(new Error('Enter valid device details and area'), { status: 400 });
            const updated = await populateLocation(Device.findByIdAndUpdate(existing._id, { $set: details }, { new: true, session }));
            if (!updated) throw Object.assign(new Error('Device not found'), { status: 404 });
            return updated;
        });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ message: error.message });
        throw error;
    }
    if (!device) return res.status(404).json({ message: 'Device not found' });
    res.json(device);
});

router.patch('/:id/archive', authenticate, requireWebAdmin, async (req, res) => {
    if (invalidId(req.params.id)) return res.status(404).json({ message: 'Device not found' });
    const { archived } = req.body;
    if (typeof archived !== 'boolean') return res.status(400).json({ message: 'Invalid archive state' });
    const filter = { _id: req.params.id, archived_at: archived ? null : { $ne: null } };
    const update = { archived_at: archived ? new Date() : null, assigned_sensor_username: null };
    const device = await populateLocation(Device.findOneAndUpdate(filter, { $set: update, $inc: { archiveVersion: 1 } }, { new: true }));
    if (device) return res.json(device);
    const current = await populateLocation(Device.findById(req.params.id));
    if (!current) return res.status(404).json({ message: 'Device not found' });
    if (Boolean(current.archived_at) !== archived) return res.status(409).json({ message: 'Device status changed. Retry the operation.' });
    res.json(current);
});

router.delete('/:id', authenticate, requireWebAdmin, async (req, res) => {
    if (invalidId(req.params.id)) return res.status(404).json({ message: 'Device not found' });
    const device = await Device.findById(req.params.id).select('archived_at archiveVersion pendingRecordWrites').lean();
    if (!device) return res.status(404).json({ message: 'Device not found' });
    if (!device.archived_at) return res.status(409).json({ message: 'Archive this device before deleting it' });
    if (device.pendingRecordWrites > 0) return res.status(409).json({ message: 'A record write is pending. Retry later.' });
    const records = await Promise.all(recordModels.map(model => model.exists({ device_id: device._id })));
    if (records.some(Boolean)) {
        return res.status(409).json({ message: 'This device has history and must remain archived to keep its records available' });
    }
    const result = await Device.deleteOne({ _id: device._id, archived_at: device.archived_at, archiveVersion: device.archiveVersion,
        $or: [{ pendingRecordWrites: 0 }, { pendingRecordWrites: { $exists: false } }] });
    if (!result.deletedCount) return res.status(409).json({ message: 'Device status changed. Retry the operation.' });
    res.status(204).end();
});

router.patch('/:id/assign-sensor', authenticate, requireWebAdmin, async (req, res) => {
    const deviceId = req.params.id;
    const { username } = req.body;

    try {
        const device = await Device.findOne({ _id: deviceId, ...deviceScope(req.account) });
        if (!device) {
            return res.status(404).json({ message: 'Device not found' });
        }

        if (typeof username !== 'string') return res.status(400).json({ message: 'Invalid sensor' });
        if (username && await Device.exists({ _id: { $ne: device._id }, assigned_sensor_username: username })) {
            return res.status(409).json({ message: 'Sensor already assigned' });
        }
        const updated = await populateLocation(Device.findOneAndUpdate({ _id: device._id, archived_at: null },
            { $set: { assigned_sensor_username: username || null } }, { new: true }));
        if (!updated) return res.status(409).json({ message: 'Restore this device before assigning a sensor' });
        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ Get device assigned to a sensor username
router.get('/by-sensor/:username', authenticate, async (req, res) => {
    try {
        const device = await Device.findOne({ ...deviceScope(req.account), archived_at: null, assigned_sensor_username: req.params.username })
            .populate('hospital_id', 'name')
            .populate('area_id', 'name');

        if (!device) {
            return res.status(404).json({ message: 'Device not found for this sensor' });
        }

        res.json(device);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
