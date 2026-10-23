const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['present', 'absent', 'half_day'], required: true },
  workHours: { type: Number, default: 8 }
});

module.exports = mongoose.model('Attendance', attendanceSchema);