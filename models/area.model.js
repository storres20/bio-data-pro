const mongoose = require('mongoose');

const areaSchema = new mongoose.Schema({
    name: { type: String, required: true },
    nameKey: { type: String, unique: true, sparse: true },
    referenceVersion: { type: Number },
});

module.exports = mongoose.model('Area', areaSchema);
