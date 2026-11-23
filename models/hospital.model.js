const mongoose = require('mongoose');

const hospitalSchema = new mongoose.Schema({
    name: { type: String, required: true },
    area_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Area' }],
});

module.exports = mongoose.model('Hospital', hospitalSchema);
