require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

app.use(express.static(__dirname));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const excelFilePath = path.join(uploadsDir, 'Staff_Attendance_Ledger.csv');
if (!fs.existsSync(excelFilePath)) {
    fs.writeFileSync(excelFilePath, 'Type,StaffName,Phone,Date,Status,SalaryAmount,DriveExcelFolder,DriveImageFolder\n');
}

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch((err) => console.log('❌ Connection Error:', err));

// Database Schemas
const staffSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  salaryType: { type: String, enum: ['monthly', 'daily'], default: 'monthly' },
  salaryAmount: { type: Number, required: true },
  joiningDate: { type: Date, default: Date.now }
});
const Staff = mongoose.model('Staff', staffSchema);

const attendanceSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['present', 'absent', 'half_day'], required: true },
  punchTime: { type: String },
  imagePath: { type: String }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

// Helper Function: Append to CSV Ledger
function appendToExcelLedger(rowText) {
    fs.appendFileSync(excelFilePath, rowText + '\n');
}

// ---------------- API ENDPOINTS ----------------

// 1. Add Staff API
app.post('/api/staff', async (req, res) => {
  try {
    const staff = new Staff(req.body);
    await staff.save();

    const todayDate = new Date().toISOString().split('T')[0];
    appendToExcelLedger(`STAFF_REGISTER,${staff.name},${staff.phone},${todayDate},ACTIVE,${staff.salaryAmount},N/A,N/A`);

    res.status(201).json({ success: true, message: 'Staff added successfully!', data: staff });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 2. Fetch All Staff API
app.get('/api/staff', async (req, res) => {
  try {
    const staffList = await Staff.find();
    res.json({ success: true, data: staffList });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Edit Staff API
app.put('/api/staff/:id', async (req, res) => {
  try {
    const staff = await Staff.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: staff });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Delete Staff API
app.delete('/api/staff/:id', async (req, res) => {
  try {
    await Staff.findByIdAndDelete(req.params.id);
    await Attendance.deleteMany({ staffId: req.params.id });
    res.json({ success: true, message: 'Staff and attendance deleted!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 5. Face Punch API
app.post('/api/face-punch', async (req, res) => {
  const { staffId, image } = req.body;
  try {
    const staff = await Staff.findById(staffId);
    if (!staff) return res.status(404).json({ success: false, error: 'Staff not found' });

    const today = new Date().toISOString().split('T')[0];
    const timeNow = new Date().toLocaleTimeString();

    let savedImagePath = '';
    if (image) {
      const base64Data = image.replace(/^data:image\/png;base64,/, "");
      const fileName = `LENS_${staff.name.replace(/\s+/g, '_')}_${today}_${Date.now()}.png`;
      savedImagePath = path.join(uploadsDir, fileName);
      fs.writeFileSync(savedImagePath, base64Data, 'base64');
    }

    const attendance = await Attendance.findOneAndUpdate(
      { staffId, date: today },
      { status: 'present', punchTime: timeNow, imagePath: savedImagePath },
      { upsert: true, new: true }
    );

    appendToExcelLedger(`FACE_PUNCH_LOG,${staff.name},${staff.phone},${today},PRESENT,${staff.salaryAmount},N/A,${savedImagePath}`);

    res.json({ success: true, message: 'Face punch attendance recorded!', data: attendance });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Manual Attendance Override API (Absent, Present, Half Day)
app.post('/api/attendance/manual', async (req, res) => {
  const { staffId, date, status } = req.body;
  try {
    const attendance = await Attendance.findOneAndUpdate(
      { staffId, date },
      { status, punchTime: 'Manual Entry' },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: attendance });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 7. Get Today's Working Staff Status
app.get('/api/attendance/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const logs = await Attendance.find({ date: today }).populate('staffId');
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Get All Attendance Logs
app.get('/api/attendance/all', async (req, res) => {
  try {
    const logs = await Attendance.find().populate('staffId').sort({ date: -1 });
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Monthly Salary Calculation API
app.get('/api/salary/calculate', async (req, res) => {
  const { staffId, month, year } = req.query;
  try {
    const staff = await Staff.findById(staffId);
    if (!staff) return res.status(404).json({ success: false, error: 'Staff not found' });

    const startDate = `${year}-${month.padStart(2, '0')}-01`;
    const endDate = `${year}-${month.padStart(2, '0')}-31`;

    const attendances = await Attendance.find({
      staffId,
      date: { $gte: startDate, $lte: endDate }
    });

    let presentDays = 0;
    let halfDays = 0;

    attendances.forEach(att => {
      if (att.status === 'present') presentDays += 1;
      if (att.status === 'half_day') halfDays += 1;
    });

    const totalEffectiveDays = presentDays + (halfDays * 0.5);
    const dailyRate = staff.salaryAmount / 30;
    const totalEarnedSalary = Math.round(totalEffectiveDays * dailyRate);

    res.json({
      success: true,
      data: {
        staffName: staff.name,
        monthlyBaseSalary: staff.salaryAmount,
        presentDays,
        halfDays,
        totalEffectiveDays,
        totalEarnedSalary
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. CSV Export Endpoint
app.get('/api/export/csv', (req, res) => {
  res.download(excelFilePath, 'Staff_Attendance_Ledger.csv');
});

// Wildcard Route
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 PagarBook Lens Server running on http://localhost:${PORT}`);
});