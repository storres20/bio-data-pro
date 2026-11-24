const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    area_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Area' },
    area_ids: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Area' }], default: undefined },
    requested_area_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Area' },
    disabledAt: { type: Date },
    trackLogin: { type: Boolean },
    lastLoginAt: { type: Date },
    sessionVersion: { type: Number, default: 0 },
    managementRevision: { type: Number },
    resetDigest: { type: String, index: true },
    resetExpiresAt: { type: Date },
    role: { type: String, enum: ['user', 'hospital-admin', 'web-admin'], default: 'user' },
});

module.exports = mongoose.model('User', userSchema);
