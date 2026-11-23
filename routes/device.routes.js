const express = require('express');
const router = express.Router();
const Device = require('../models/device.model');
const mongoose = require('mongoose');
const { authenticate, deviceScope, listHospitalAreas, requireWebAdmin } = require('../access');

// ✅ Get devices by hospital ID (with hospital and area populated)
router.get('/hospital/:id', authenticate, async (req, res) => {
    try {
        const hospitalId = req.params.id;

        // Asegúrate de que sea un ObjectId válido
        if (!mongoose.Types.ObjectId.isValid(hospitalId)) {
            return res.status(400).json({ message: 'Invalid hospital ID format' });
        }

        if (hospitalId !== String(req.account.hospital_id)) return res.status(403).json({ message: 'Hospital access required' });
        const devices = await Device.find(deviceScope(req.account))
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
    const { name, brand, model, serie, hospital_id, area_id } = req.body;

    const device = new Device({
        name,
        brand,
        model,
        serie,
        hospital_id,
        area_id
    });

    try {
        const catalog = await listHospitalAreas(hospital_id);
        if (!catalog?.areas.some(area => String(area._id) === String(area_id))) {
            return res.status(400).json({ message: 'Area must belong to the hospital' });
        }
        const savedDevice = await device.save();
        res.status(201).json(savedDevice);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// ✅ PATCH: Assign sensor username to a device
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
        device.assigned_sensor_username = username || null;
        await device.save();

        await device.populate('hospital_id area_id', 'name');
        res.status(200).json(device);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ✅ Get device assigned to a sensor username
router.get('/by-sensor/:username', authenticate, async (req, res) => {
    try {
        const device = await Device.findOne({ ...deviceScope(req.account), assigned_sensor_username: req.params.username })
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
