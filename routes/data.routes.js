const express = require('express');
const Model = require('../models/fourh-data.model');
const Device = require('../models/device.model');
const { isObjectIdOrHexString } = require('mongoose');
const { authenticate, deviceScope, requireWebAdmin } = require('../access');

const router = express.Router();

// ✅ POST Method - create data (optionally include device_id)
router.post('/data', async (req, res) => {
    const data = new Model({
        temperature: req.body.temperature,
        humidity: req.body.humidity,
        dsTemperature: req.body.dsTemperature,
        username: req.body.username,
        datetime: req.body.datetime,
        device_id: req.body.device_id || null  // optional field
    });

    try {
        const dataToSave = await data.save();
        res.status(200).json(dataToSave);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// ✅ GET all Method - include device info
router.get('/', authenticate, requireWebAdmin, async (req, res) => {
    try {
        const data = await Model.find().populate('device_id');
        res.json(data);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ GET data by username - include device info
router.get('/username/:username', authenticate, requireWebAdmin, async (req, res) => {
    try {
        const username = req.params.username;
        const data = await Model.find({ username }).populate('device_id');

        if (data.length === 0) {
            return res.status(404).json({ message: 'No data found for this username' });
        }

        res.json(data);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ DELETE all data
router.delete('/', authenticate, requireWebAdmin, async (req, res) => {
    try {
        await Model.deleteMany({});
        res.status(200).json({ message: 'All data deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ DELETE data by username
router.delete('/:username', authenticate, requireWebAdmin, async (req, res) => {
    const { username } = req.params;
    try {
        const result = await Model.deleteMany({ username });
        if (result.deletedCount > 0) {
            res.status(200).json({ message: `All data for user ${username} deleted successfully` });
        } else {
            res.status(404).json({ message: `No data found for user ${username}` });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ GET all unique usernames
router.get('/usernames', authenticate, requireWebAdmin, async (req, res) => {
    try {
        const usernames = await Model.distinct('username');
        res.status(200).json(usernames);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.get('/by-device/:deviceId', authenticate, async (req, res) => {
    const { deviceId } = req.params;
    const { from, to } = req.query;

    if (!isObjectIdOrHexString(deviceId)) return res.status(404).json({ message: 'Device not found' });
    const filter = { device_id: deviceId };
    if (from || to) {
        const start = from ? new Date(from) : null;
        const end = to ? new Date(to) : null;
        if ((start && isNaN(start.getTime())) || (end && isNaN(end.getTime())) || (start && end && start > end)) {
            return res.status(400).json({ message: 'Invalid date range' });
        }
        filter.datetime = { ...(start && { $gte: start }), ...(end && { $lte: end }) };
    }

    try {
        if (!await Device.exists({ _id: deviceId, ...deviceScope(req.account) })) {
            return res.status(404).json({ message: 'Device not found' });
        }
        const results = await Model.find(filter).sort({ datetime: 1 });
        res.json(results);
    } catch (err) {
        console.error('❌ Error fetching data by device:', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
});



module.exports = router;
