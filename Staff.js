const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  salaryType: { type: String, enum: ['monthly', 'daily'], default: 'monthly' },
  salaryAmount: { type: Number, required: true },
  joiningDate: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Staff', staffSchema);