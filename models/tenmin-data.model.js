const mongoose = require('mongoose');
const createSensorDataSchema = require('./sensor-data.schema');

module.exports = mongoose.model('TenMinData', createSensorDataSchema(), '10mindata');
