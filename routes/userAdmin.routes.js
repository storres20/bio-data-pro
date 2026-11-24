const express = require('express');
const bcrypt = require('bcrypt');
const { randomBytes, createHash } = require('node:crypto');
const { isObjectIdOrHexString, connection } = require('mongoose');
const User = require('../models/user.model');
const { withAreas } = require('../areaChanges');
const { allowedAreaIds, authenticate, listHospitalAreas, requireAdministrator } = require('../access');

const router = express.Router();
const roles = ['user', 'hospital-admin', 'web-admin'];
const resetExpiry = 60 * 60 * 1000;
const hashToken = token => createHash('sha256').update(token).digest('hex');

function setupToken() {
    const token = randomBytes(32).toString('hex');
    return {
        token,
        fields: { resetDigest: hashToken(token), resetExpiresAt: new Date(Date.now() + resetExpiry) },
    };
}

function accountInfo(user) {
    return {
        _id: user._id,
        username: user.username,
        hospitalId: user.hospital_id,
        role: user.role ?? 'user',
        areaIds: allowedAreaIds(user).map(String),
        requestedAreaId: user.requested_area_id,
        disabled: Boolean(user.disabledAt),
        canDelete: user.trackLogin === true && !user.lastLoginAt,
    };
}

function scope(actor) {
    return actor.role === 'web-admin' ? {} : {
        hospital_id: actor.hospital_id, role: { $nin: ['hospital-admin', 'web-admin'] },
    };
}

function targetFilter(req) {
    return { _id: req.params.id, ...scope(req.account) };
}

async function accountDetails(body, actor, existing, session = null) {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const webAdmin = actor.role === 'web-admin';
    const hospitalId = webAdmin ? body.hospitalId : actor.hospital_id;
    const role = webAdmin ? body.role : 'user';
    if (!username || !isObjectIdOrHexString(hospitalId) || !roles.includes(role)
        || !Array.isArray(body.areaIds) || !body.areaIds.every(isObjectIdOrHexString)) return null;
    const catalog = await listHospitalAreas(hospitalId, session);
    const areaIds = [...new Set(body.areaIds.map(String))];
    const allowed = new Set(catalog?.areas.map(area => String(area._id)));
    if (!catalog || !areaIds.every(id => allowed.has(id))) return null;
    if (existing && String(existing._id) === String(actor._id) && role !== actor.role) return null;
    return { username, hospital_id: hospitalId, role, area_ids: areaIds };
}

function transitionError(res, error) {
    if (error.code === 11000) return res.status(409).json({ message: 'Username already exists' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
}

async function protectWebAdmin(actor, target, change, apply) {
    if (target.role !== 'web-admin' || target.disabledAt || !change) return apply(null);
    return connection.transaction(async session => {
        // Pin the acting administrator so concurrent operations cannot disable each other.
        const stillAdmin = await User.updateOne({
            _id: actor._id, role: 'web-admin', disabledAt: null,
        }, { $inc: { managementRevision: 1 } }, { session });
        const count = await User.countDocuments({ role: 'web-admin', disabledAt: null }).session(session);
        if (!stillAdmin.matchedCount || count <= 1) {
            throw Object.assign(new Error('At least one active web administrator must remain'), { status: 409 });
        }
        return apply(session);
    });
}

function resetFilter(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    return { resetDigest: hashToken(token), resetExpiresAt: { $gt: new Date() }, disabledAt: null };
}

router.post('/reset-password/validate', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const filter = resetFilter(req.body?.token);
    const user = filter && await User.findOne(filter).select('username -_id').lean();
    if (!user) return res.status(400).json({ message: 'The link is invalid, expired or already used.' });
    res.json({ username: user.username });
});

router.post('/reset-password', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { token, password } = req.body ?? {};
    const eligible = resetFilter(token);
    if (!eligible || typeof password !== 'string' || [...password].length < 6 || Buffer.byteLength(password) > 72) {
        return res.status(400).json({ message: 'Use a valid link and a password of at least 6 characters and at most 72 bytes.' });
    }
    if (!await User.exists(eligible)) return res.status(400).json({ message: 'The link has expired or has already been used.' });
    const passwordHash = await bcrypt.hash(password, 10);
    const updated = await User.updateOne({ ...eligible, resetExpiresAt: { $gt: new Date() } }, {
        $set: { password: passwordHash },
        $unset: { resetDigest: '', resetExpiresAt: '' },
        $inc: { sessionVersion: 1 },
    });
    if (!updated.matchedCount) return res.status(400).json({ message: 'The link has expired or has already been used.' });
    res.status(204).end();
});

router.use('/users', authenticate, requireAdministrator);
router.param('id', (req, res, next, id) => {
    if (!isObjectIdOrHexString(id)) return res.status(404).json({ message: 'User not found' });
    next();
});

router.get('/users', async (req, res) => {
    const hospitalId = req.account.role === 'web-admin' ? req.query.hospitalId ?? req.account.hospital_id : req.account.hospital_id;
    if (!isObjectIdOrHexString(hospitalId)) return res.status(400).json({ message: 'Invalid hospital' });
    const catalog = await listHospitalAreas(hospitalId);
    if (!catalog) return res.status(404).json({ message: 'Hospital not found' });
    const users = await User.find({ hospital_id: hospitalId, ...scope(req.account) })
        .select('username hospital_id role area_id area_ids requested_area_id disabledAt trackLogin lastLoginAt')
        .sort({ username: 1 }).lean();
    res.json({ areas: catalog.areas, users: users.map(accountInfo) });
});

router.post('/users', async (req, res) => {
    const details = await accountDetails(req.body, req.account);
    if (!details) return res.status(400).json({ message: 'Enter a valid username, role, hospital and areas' });
    const { token, fields } = setupToken();
    try {
        const password = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
        const user = await withAreas(details.area_ids, async session => {
            const current = await accountDetails(req.body, req.account, null, session);
            if (!current) throw Object.assign(new Error('An area is no longer available'), { status: 400 });
            const [created] = await User.create([{ ...current, ...fields, trackLogin: true, password }], { session });
            return created;
        });
        res.status(201).json({ user: accountInfo(user), resetToken: token });
    } catch (error) {
        return transitionError(res, error);
    }
});

router.patch('/users/:id', async (req, res) => {
    const filter = targetFilter(req);
    const target = await User.findOne(filter).lean();
    if (!target) return res.status(404).json({ message: 'User not found' });
    const details = await accountDetails(req.body, req.account, target);
    if (!details) return res.status(400).json({ message: 'Enter valid account details and areas. You cannot change your own role.' });
    const moved = String(target.hospital_id) !== String(details.hospital_id);
    const roleChanged = details.role !== (target.role ?? 'user');
    const revoke = moved || roleChanged || details.username !== target.username;
    const approved = details.area_ids.includes(String(target.requested_area_id));
    const unset = {
        ...((moved || approved) && { requested_area_id: '' }),
        ...((moved || !details.area_ids.includes(String(target.area_id))) && { area_id: '' }),
        ...(revoke && { resetDigest: '', resetExpiresAt: '' }),
    };
    try {
        const saved = await protectWebAdmin(req.account, target, roleChanged, adminSession =>
            withAreas(details.area_ids, async session => {
                if (!await accountDetails(req.body, req.account, target, session)) {
                    throw Object.assign(new Error('An area is no longer available'), { status: 400 });
                }
                return User.findOneAndUpdate({
                    ...filter, hospital_id: target.hospital_id, role: target.role ?? null, disabledAt: target.disabledAt ?? null,
                }, {
                    $set: details,
                    ...(Object.keys(unset).length && { $unset: unset }),
                    ...(revoke && { $inc: { sessionVersion: 1 } }),
                }, { new: true, session }).lean();
            }, adminSession)
        );
        if (!saved) return res.status(409).json({ message: 'The account changed. Reload and try again.' });
        res.json({ user: accountInfo(saved) });
    } catch (error) {
        return transitionError(res, error);
    }
});

router.delete('/users/:id/area-request', async (req, res) => {
    const user = await User.findOneAndUpdate({ ...targetFilter(req), requested_area_id: { $ne: null } },
        { $unset: { requested_area_id: '' } }, { new: true }).lean();
    if (!user) return res.status(404).json({ message: 'Pending area request not found' });
    res.json({ user: accountInfo(user) });
});

router.patch('/users/:id/status', async (req, res) => {
    const { disabled } = req.body;
    if (typeof disabled !== 'boolean') return res.status(400).json({ message: 'Invalid account status' });
    if (String(req.account._id) === req.params.id.toLowerCase()) return res.status(409).json({ message: 'You cannot disable your own account' });
    const filter = targetFilter(req);
    const target = await User.findOne(filter).lean();
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (Boolean(target.disabledAt) === disabled) return res.json({ user: accountInfo(target) });
    try {
        const user = await protectWebAdmin(req.account, target, disabled, session =>
            User.findOneAndUpdate({
                ...filter, hospital_id: target.hospital_id, role: target.role ?? null, disabledAt: target.disabledAt ?? null,
            }, {
                $set: { disabledAt: disabled ? new Date() : null },
                $unset: { resetDigest: '', resetExpiresAt: '' },
                $inc: { sessionVersion: 1 },
            }, { new: true, session }).lean()
        );
        if (!user) return res.status(409).json({ message: 'The account changed. Reload and try again.' });
        res.json({ user: accountInfo(user) });
    } catch (error) {
        return transitionError(res, error);
    }
});

router.post('/users/:id/reset-password', async (req, res) => {
    const { token, fields } = setupToken();
    const updated = await User.updateOne({ ...targetFilter(req), disabledAt: null }, { $set: fields });
    if (!updated.matchedCount) return res.status(404).json({ message: 'Active account not found' });
    res.json({ resetToken: token });
});

router.delete('/users/:id', async (req, res) => {
    if (String(req.account._id) === req.params.id.toLowerCase()) return res.status(409).json({ message: 'You cannot delete your own account' });
    const target = await User.findOne(targetFilter(req)).lean();
    if (!target) return res.status(404).json({ message: 'User not found' });
    try {
        const result = await protectWebAdmin(req.account, target, true, session => User.deleteOne({
            ...targetFilter(req), hospital_id: target.hospital_id, role: target.role ?? null,
            trackLogin: true, lastLoginAt: null,
        }, { session }));
        if (!result.deletedCount) {
            return res.status(409).json({ message: 'Only never-used accounts with tracked sign-ins can be deleted. You can deactivate this account instead.' });
        }
        res.status(204).end();
    } catch (error) {
        return transitionError(res, error);
    }
});

module.exports = router;
