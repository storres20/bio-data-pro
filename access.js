const jwt = require('jsonwebtoken');
const { isObjectIdOrHexString } = require('mongoose');
const User = require('./models/user.model');
const Hospital = require('./models/hospital.model');
const Area = require('./models/area.model');
const Device = require('./models/device.model');

function allowedAreaIds(user) {
    return user.area_ids ?? (user.area_id ? [user.area_id] : []);
}

function deviceScope(user) {
    if (user.role === 'web-admin') return {};
    return { hospital_id: user.hospital_id, area_id: { $in: allowedAreaIds(user) } };
}

function canViewDevice(user, device) {
    return device && String(device.hospital_id) === String(user.hospital_id)
        && allowedAreaIds(user).some(id => String(id) === String(device.area_id));
}

function signSession(user) {
    return jwt.sign({ id: user._id.toString(), username: user.username, version: user.sessionVersion ?? 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function verifySession(token) {
    try {
        const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        return isObjectIdOrHexString(claims.id) && Number.isFinite(claims.exp) ? claims : null;
    } catch {
        return null;
    }
}

function isSessionCurrent(user, claims) {
    return Boolean(user && !user.disabledAt && (user.sessionVersion ?? 0) === (claims.version ?? 0));
}

async function authenticate(req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    const match = req.get('authorization')?.match(/^Bearer (\S+)$/i);
    const claims = match && verifySession(match[1]);
    if (!claims) return res.status(401).json({ message: 'Authentication required' });
    try {
        const user = await User.findById(claims.id).select('-password').lean();
        if (!isSessionCurrent(user, claims)) return res.status(401).json({ message: 'Authentication required' });
        req.account = user;
        next();
    } catch (error) {
        next(error);
    }
}

function requireAdministrator(req, res, next) {
    if (['hospital-admin', 'web-admin'].includes(req.account.role)) return next();
    res.status(403).json({ message: 'Administrator access required' });
}

function requireWebAdmin(req, res, next) {
    if (req.account.role === 'web-admin') return next();
    res.status(403).json({ message: 'Web administrator access required' });
}

async function listHospitalAreas(hospitalId, session = null) {
    const hospital = await Hospital.findById(hospitalId).select('name area_ids').session(session).lean();
    if (!hospital) return null;
    const deviceAreas = await Device.distinct('area_id', { hospital_id: hospitalId }).session(session);
    const legacyAreas = await User.distinct('area_id', { hospital_id: hospitalId, area_ids: null }).session(session);
    const userAreas = await User.distinct('area_ids', { hospital_id: hospitalId }).session(session);
    const pendingAreas = await User.distinct('requested_area_id', { hospital_id: hospitalId }).session(session);
    const ids = new Set([...(hospital.area_ids ?? []), ...deviceAreas, ...legacyAreas, ...userAreas, ...pendingAreas]
        .filter(Boolean).map(String));
    const areas = await Area.find({ _id: { $in: [...ids] } }).select('name').sort({ name: 1 }).session(session).lean();
    return { hospital: { _id: hospital._id, name: hospital.name }, areas };
}

async function profileFor(user) {
    const catalog = await listHospitalAreas(user.hospital_id);
    if (!catalog) return null;
    const ids = new Set(allowedAreaIds(user).map(String));
    const areas = catalog.areas.filter(area => ids.has(String(area._id)));
    return {
        username: user.username,
        hospital: catalog.hospital,
        area: areas.find(area => String(area._id) === String(user.area_id)) ?? areas[0] ?? null,
        role: user.role ?? 'user',
        allowedAreas: areas,
        hospitalAreas: catalog.areas,
        requestedArea: catalog.areas.find(area => String(area._id) === String(user.requested_area_id)) ?? null,
    };
}

module.exports = {
    allowedAreaIds, authenticate, canViewDevice, deviceScope, listHospitalAreas,
    isSessionCurrent, profileFor, requireAdministrator, requireWebAdmin, signSession, verifySession,
};
