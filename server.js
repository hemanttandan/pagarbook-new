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
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const excelFilePath = path.join(uploadsDir, 'Staff_Attendance_Ledger.csv');
if (!fs.existsSync(excelFilePath)) {
    fs.writeFileSync(excelFilePath, 'Type,StaffName,Phone,Date,PunchIn,PunchOut,WorkHours,Status\n');
}

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch((err) => console.log('❌ Connection Error:', err));

// Database Schemas
const staffSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  salaryAmount: { type: Number, required: true },
  registeredFace: { type: String },
  joiningDate: { type: Date, default: Date.now }
});
const Staff = mongoose.model('Staff', staffSchema);

const attendanceSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  date: { type: String, required: true },
  punchIn: { type: String },
  punchOut: { type: String },
  workHours: { type: Number, default: 0 },
  status: { type: String, enum: ['present', 'absent', 'half_day'], default: 'present' },
  imagePath: { type: String }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

function appendToExcelLedger(rowText) {
    fs.appendFileSync(excelFilePath, rowText + '\n');
}

// Helper: Calculate Hours
function calculateHours(time1, time2) {
    if(!time1 || !time2) return 0;
    const [h1, m1] = time1.split(':').map(Number);
    const [h2, m2] = time2.split(':').map(Number);
    const diffMs = (new Date(2000, 0, 1, h2, m2) - new Date(2000, 0, 1, h1, m1));
    return Math.max(0, Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10);
}

// ---------------- API ENDPOINTS ----------------

// Register Staff with Face
app.post('/api/staff', async (req, res) => {
  try {
    const { name, phone, salaryAmount, faceImage } = req.body;
    const staff = new Staff({ name, phone, salaryAmount, registeredFace: faceImage });
    await staff.save();
    res.status(201).json({ success: true, data: staff });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// Fetch All Staff
app.get('/api/staff', async (req, res) => {
  try {
    const staffList = await Staff.find();
    res.json({ success: true, data: staffList });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Delete Staff
app.delete('/api/staff/:id', async (req, res) => {
  try {
    await Staff.findByIdAndDelete(req.params.id);
    await Attendance.deleteMany({ staffId: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// Face Punch IN / OUT Logic
app.post('/api/face-punch', async (req, res) => {
  const { staffId } = req.body;
  try {
    const staff = await Staff.findById(staffId);
    if (!staff) return res.status(404).json({ success: false, error: 'Staff not found' });

    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const timeNow = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    let record = await Attendance.findOne({ staffId, date: today });
    let punchType = 'IN';

    if (!record) {
      // First Punch = IN
      record = new Attendance({ staffId, date: today, punchIn: timeNow, status: 'present' });
      await record.save();
      appendToExcelLedger(`IN,${staff.name},${staff.phone},${today},${timeNow},N/A,0,PRESENT`);
    } else if (!record.punchOut) {
      // Second Punch = OUT
      punchType = 'OUT';
      record.punchOut = timeNow;
      record.workHours = calculateHours(record.punchIn, timeNow);

      if(record.workHours < 5) record.status = 'half_day';
      else record.status = 'present';

      await record.save();
      appendToExcelLedger(`OUT,${staff.name},${staff.phone},${today},${record.punchIn},${timeNow},${record.workHours},${record.status}`);
    } else {
      return res.status(400).json({ success: false, error: 'IN & OUT punches already completed today!' });
    }

    res.json({
      success: true,
      data: { staffName: staff.name, type: punchType, time: timeNow, workHours: record.workHours }
    });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// Manual Attendance Override
app.post('/api/attendance/manual', async (req, res) => {
  const { staffId, date, status } = req.body;
  try {
    const hours = status === 'present' ? 8 : (status === 'half_day' ? 4 : 0);
    const attendance = await Attendance.findOneAndUpdate(
      { staffId, date },
      { status, workHours: hours, punchIn: 'Manual', punchOut: 'Manual' },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: attendance });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// Today's Working Status
app.get('/api/attendance/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const logs = await Attendance.find({ date: today }).populate('staffId');
    res.json({ success: true, data: logs });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// All Attendance Logs
app.get('/api/attendance/all', async (req, res) => {
  try {
    const logs = await Attendance.find().populate('staffId').sort({ date: -1 });
    res.json({ success: true, data: logs });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Monthly Salary Calculation Report API
app.get('/api/salary/monthly-report', async (req, res) => {
  const { month, year } = req.query;
  try {
    const staffList = await Staff.find();
    const startDate = `${year}-${month.padStart(2, '0')}-01`;
    const endDate = `${year}-${month.padStart(2, '0')}-31`;

    const report = [];

    for (let staff of staffList) {
      const logs = await Attendance.find({
        staffId: staff._id,
        date: { $gte: startDate, $lte: endDate }
      });

      let shiftCompletedDays = 0;
      let halfDays = 0;

      logs.forEach(log => {
        if (log.workHours >= 8 || log.status === 'present') shiftCompletedDays += 1;
        else if (log.workHours > 0 || log.status === 'half_day') halfDays += 1;
      });

      const totalEffectiveDays = shiftCompletedDays + (halfDays * 0.5);
      const dailyRate = staff.salaryAmount / 30;
      const netPayableSalary = Math.round(totalEffectiveDays * dailyRate);

      report.push({
        staffName: staff.name,
        monthlyBaseSalary: staff.salaryAmount,
        shiftCompletedDays,
        halfDays,
        totalEffectiveDays,
        netPayableSalary
      });
    }

    res.json({ success: true, data: report });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Export CSV
app.get('/api/export/csv', (req, res) => {
  res.download(excelFilePath, 'Staff_Attendance_Ledger.csv');
});

// Wildcard Route
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));