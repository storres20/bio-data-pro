const express = require('express');
const bcrypt = require('bcrypt');
const { isObjectIdOrHexString } = require('mongoose');
const User = require('../models/user.model');
const Hospital = require('../models/hospital.model');
const { withAreas } = require('../areaChanges');
const {
    authenticate, listHospitalAreas, profileFor, requireAdministrator, signSession,
} = require('../access');

const router = express.Router();
router.use(require('./userAdmin.routes'));
router.use(require('./areaAdmin.routes'));

router.post('/register', async (req, res) => {
    const { username, password, hospital_id, area_id } = req.body;
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password
        || !isObjectIdOrHexString(hospital_id) || !isObjectIdOrHexString(area_id)) {
        return res.status(400).json({ message: 'Enter a username, password, hospital and area' });
    }

    const catalog = await listHospitalAreas(hospital_id);
    if (!catalog?.areas.some(area => String(area._id) === String(area_id))) {
        return res.status(400).json({ message: 'The area must belong to the selected hospital' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const created = await withAreas([area_id], async session => {
            const current = await listHospitalAreas(hospital_id, session);
            if (!current?.areas.some(area => String(area._id) === String(area_id))) return null;
            return User.create([{ username: username.trim(), password: passwordHash, hospital_id,
                area_ids: [], requested_area_id: area_id, trackLogin: true }], { session });
        });
        if (!created) return res.status(400).json({ message: 'The area must belong to the selected hospital' });
        res.status(201).json({ message: 'Account created. An administrator must approve your area access.', pendingApproval: true });
    } catch (error) {
        if (error.status === 404) return res.status(400).json({ message: 'The area is no longer available' });
        if (error.code === 11000) return res.status(409).json({ message: 'Username already exists' });
        throw error;
    }
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ message: 'Invalid username or password' });
    }
    const user = await User.findOne({ username: username.trim() }).lean();
    if (!user || user.disabledAt || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ message: 'Invalid username or password' });
    }
    const profile = await profileFor(user);
    if (!profile) return res.status(403).json({ message: 'No hospital assigned' });
    const recorded = await User.updateOne({ _id: user._id, password: user.password, disabledAt: null }, { $set: { lastLoginAt: new Date() } });
    if (!recorded.matchedCount) return res.status(400).json({ message: 'Invalid username or password' });
    res.set('Cache-Control', 'private, no-store');
    res.json({ token: signSession(user), user: profile });
});

router.get('/me', authenticate, async (req, res) => {
    const profile = await profileFor(req.account);
    if (!profile) return res.status(401).json({ message: 'No hospital assigned' });
    res.json(profile);
});

router.get('/hospitals', async (req, res) => {
    res.json(await Hospital.find().select('name').sort({ name: 1 }).lean());
});

router.get('/hospitals/:id/areas', async (req, res) => {
    if (!isObjectIdOrHexString(req.params.id)) return res.status(404).json({ message: 'Hospital not found' });
    const catalog = await listHospitalAreas(req.params.id);
    if (!catalog) return res.status(404).json({ message: 'Hospital not found' });
    res.json(catalog.areas);
});

router.patch('/users/:id/areas', authenticate, requireAdministrator, async (req, res) => {
    const { id } = req.params;
    const { areaIds } = req.body;
    if (!isObjectIdOrHexString(id) || !Array.isArray(areaIds) || !areaIds.every(isObjectIdOrHexString)) {
        return res.status(400).json({ message: 'Invalid user or areas' });
    }
    const filter = { _id: id, role: { $nin: ['hospital-admin', 'web-admin'] } };
    if (req.account.role === 'hospital-admin') filter.hospital_id = req.account.hospital_id;
    const target = await User.findOne(filter).select('hospital_id').lean();
    if (!target) return res.status(404).json({ message: 'User not found' });
    const uniqueIds = [...new Set(areaIds.map(String))];
    try {
        const updated = await withAreas(uniqueIds, async session => {
            const catalog = await listHospitalAreas(target.hospital_id, session);
            const ids = new Set(catalog?.areas.map(area => String(area._id)));
            if (!uniqueIds.every(areaId => ids.has(areaId))) return null;
            return User.updateOne({ ...filter, hospital_id: target.hospital_id }, {
                $set: { area_ids: uniqueIds },
                $unset: { requested_area_id: '', area_id: '' },
            }, { session });
        });
        if (!updated) return res.status(400).json({ message: 'Every area must belong to this hospital' });
        if (!updated.matchedCount) return res.status(404).json({ message: 'User not found' });
        res.json({ areaIds: uniqueIds });
    } catch (error) {
        if (error.status === 404) return res.status(400).json({ message: 'An area is no longer available' });
        throw error;
    }
});

module.exports = router;
