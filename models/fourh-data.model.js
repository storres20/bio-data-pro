const mongoose = require('mongoose');
const createSensorDataSchema = require('./sensor-data.schema');

module.exports = mongoose.model('FourHData', createSensorDataSchema(), '4hdata');
