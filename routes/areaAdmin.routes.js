const express = require('express');
const { isObjectIdOrHexString } = require('mongoose');
const Area = require('../models/area.model');
const Hospital = require('../models/hospital.model');
const User = require('../models/user.model');
const Device = require('../models/device.model');
const { authenticate, requireAdministrator, requireWebAdmin, listHospitalAreas } = require('../access');
const { withAreas } = require('../areaChanges');

const router = express.Router();
const nameOf = req => typeof req.body?.name === 'string' ? req.body.name.trim().normalize('NFC') : '';
const nameKey = name => name.toLowerCase();
const duplicateName = filter => Area.exists(filter).collation({ locale: 'es', strength: 2 });

function areaError(res, err) {
    if (err.status === 404 || err.code === 11000) {
        return res.status(err.status ?? 409).json({ message: err.status ? err.message : 'An area with this name already exists' });
    }
    throw err;
}

async function references(areaId, hospitalId, session) {
    const hospital = hospitalId ? { hospital_id: hospitalId } : {};
    const devices = { ...hospital, area_id: areaId };
    const activeDevices = await Device.countDocuments({ ...devices, archived_at: null }).session(session);
    const archivedDevices = await Device.countDocuments({ ...devices, archived_at: { $ne: null } }).session(session);
    const userAccess = await User.countDocuments({
        ...hospital, $or: [{ area_ids: areaId }, { area_ids: null, area_id: areaId }],
    }).session(session);
    const pendingRequests = await User.countDocuments({ ...hospital, requested_area_id: areaId }).session(session);
    const hospitals = hospitalId ? 0 : await Hospital.countDocuments({ area_ids: areaId }).session(session);
    return { activeDevices, archivedDevices, userAccess, pendingRequests, hospitals };
}

router.get('/areas', authenticate, requireAdministrator, async (req, res) => {
    res.json(await Area.find().select('name').sort({ name: 1 }).lean());
});

router.post('/areas', authenticate, requireWebAdmin, async (req, res) => {
    const name = nameOf(req);
    if (!name) return res.status(400).json({ message: 'Enter the area name' });
    try {
        if (await duplicateName({ name })) return res.status(409).json({ message: 'An area with this name already exists' });
        const area = await Area.create({ name, nameKey: nameKey(name) });
        res.status(201).json({ _id: area._id, name: area.name });
    } catch (err) {
        return areaError(res, err);
    }
});

router.patch('/areas/:id', authenticate, requireWebAdmin, async (req, res) => {
    if (!isObjectIdOrHexString(req.params.id)) return res.status(404).json({ message: 'Area not found' });
    const name = nameOf(req);
    if (!name) return res.status(400).json({ message: 'Enter the area name' });
    try {
        if (await duplicateName({ _id: { $ne: req.params.id }, name })) {
            return res.status(409).json({ message: 'An area with this name already exists' });
        }
        const area = await Area.findByIdAndUpdate(req.params.id, { $set: { name, nameKey: nameKey(name) } }, { new: true })
            .select('name').lean();
        if (!area) return res.status(404).json({ message: 'Area not found' });
        res.json(area);
    } catch (err) {
        return areaError(res, err);
    }
});

router.get('/areas/:id/references', authenticate, requireWebAdmin, async (req, res) => {
    const { id } = req.params;
    if (!isObjectIdOrHexString(id) || !await Area.exists({ _id: id })) {
        return res.status(404).json({ message: 'Area not found' });
    }
    res.json(await references(id, null, null));
});

router.delete('/areas/:id', authenticate, requireWebAdmin, async (req, res) => {
    const { id } = req.params;
    if (!isObjectIdOrHexString(id)) return res.status(404).json({ message: 'Area not found' });
    try {
        const blockers = await withAreas([id], async session => {
            const counts = await references(id, null, session);
            if (Object.values(counts).some(Boolean)) return counts;
            await User.updateMany({ area_id: id, area_ids: { $ne: null } }, { $unset: { area_id: '' } }, { session });
            await Area.deleteOne({ _id: id }, { session });
            return null;
        });
        if (blockers) return res.status(409).json({ message: 'This area is still in use.', blockers });
        res.status(204).end();
    } catch (err) {
        return areaError(res, err);
    }
});

router.patch('/hospitals/:hospitalId/areas/:id', authenticate, requireAdministrator, async (req, res) => {
    const { hospitalId, id } = req.params;
    if (!isObjectIdOrHexString(hospitalId) || !isObjectIdOrHexString(id)) {
        return res.status(404).json({ message: 'Hospital or area not found' });
    }
    if (req.account.role !== 'web-admin' && hospitalId.toLowerCase() !== String(req.account.hospital_id)) {
        return res.status(403).json({ message: 'Hospital access required' });
    }
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ message: 'Invalid area status' });
    try {
        const blockers = await withAreas([id], async session => {
            const counts = !enabled && await references(id, hospitalId, session);
            if (counts && Object.values(counts).some(Boolean)) return counts;
            const update = enabled ? { $addToSet: { area_ids: id } } : { $pull: { area_ids: id } };
            const hospital = await Hospital.updateOne({ _id: hospitalId }, update, { session });
            if (!hospital.matchedCount) throw Object.assign(new Error('Hospital not found'), { status: 404 });
            return null;
        });
        if (blockers) return res.status(409).json({ message: 'This area is still in use at this hospital.', blockers });
        const catalog = await listHospitalAreas(hospitalId);
        res.json(catalog.areas);
    } catch (err) {
        return areaError(res, err);
    }
});

module.exports = router;
