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
  pin: { type: String, required: true, unique: true },
  documentFile: { type: String },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  joiningDate: { type: Date, default: Date.now }
});
const Staff = mongoose.model('Staff', staffSchema);

const attendanceSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  date: { type: String, required: true },
  punchIn: { type: String },
  punchOut: { type: String },
  punchPhoto: { type: String },
  workHours: { type: Number, default: 0 },
  status: { type: String, enum: ['present', 'absent', 'half_day'], default: 'present' }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

// ---------------- 📍 ALLOWED OFFICE LOCATIONS CONFIG ----------------
const ALLOWED_LOCATIONS = [
    { name: "Branch 1 (Office)", lat: 21.2514, lng: 81.6296, radiusKm: 0.1 }, // 100 Meter Radius
    { name: "Branch 2 (Shop/Store)", lat: 21.2334, lng: 81.6337, radiusKm: 0.1 } // 100 Meter Radius
];

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = (lat2-lat1) * (Math.PI/180);
  var dLon = (lon2-lon1) * (Math.PI/180); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c; 
}

function isWithinAllowedLocations(userLat, userLng) {
    for (let loc of ALLOWED_LOCATIONS) {
        let dist = getDistanceFromLatLonInKm(userLat, userLng, loc.lat, loc.lng);
        if (dist <= loc.radiusKm) return true;
    }
    return false;
}

function appendToExcelLedger(rowText) {
    fs.appendFileSync(excelFilePath, rowText + '\n');
}

function getLocalCurrentTime() {
    const now = new Date();
    return now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function calculateHours(time1, time2) {
    if(!time1 || !time2) return 0;
    const [h1, m1] = time1.split(':').map(Number);
    const [h2, m2] = time2.split(':').map(Number);
    const diffMs = (new Date(2000, 0, 1, h2, m2) - new Date(2000, 0, 1, h1, m1));
    return Math.max(0, Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10);
}

// ---------------- API ENDPOINTS ----------------

app.post('/api/staff', async (req, res) => {
  try {
    const { name, phone, salaryAmount, pin, documentFile } = req.body;
    const staff = new Staff({ name, phone, salaryAmount, pin, documentFile, status: 'active' });
    await staff.save();
    res.status(201).json({ success: true, data: staff });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/staff', async (req, res) => {
  try {
    const staffList = await Staff.find();
    res.json({ success: true, data: staffList });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, phone, salaryAmount, pin } = req.body;
    const staff = await Staff.findByIdAndUpdate(req.params.id, { name, phone, salaryAmount, pin }, { new: true });
    res.json({ success: true, data: staff });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.put('/api/staff/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const staff = await Staff.findByIdAndUpdate(req.params.id, { status }, { new: true });
    res.json({ success: true, data: staff });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    await Staff.findByIdAndDelete(req.params.id);
    await Attendance.deleteMany({ staffId: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ⚡ Step 1 PIN Verification Endpoint
app.post('/api/verify-pin', async (req, res) => {
  const { pin } = req.body;
  try {
    const matchedStaff = await Staff.findOne({ pin, status: 'active' });
    if (!matchedStaff) {
        return res.status(404).json({ success: false, error: 'Incorrect PIN or Staff Inactive!' });
    }
    res.json({ success: true, data: { name: matchedStaff.name, phone: matchedStaff.phone } });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ⚡ Step 2 & 3: Submit Captured Photo + GPS Location Punch Endpoint
app.post('/api/submit-photo-geofenced-punch', async (req, res) => {
  const { pin, lat, lng, photo } = req.body;
  try {
    // 1. Verify GPS Radius First
    if (!lat || !lng || !isWithinAllowedLocations(lat, lng)) {
        return res.status(403).json({ 
            success: false, 
            error: 'Punch Rejected! You are outside allowed office location!' 
        });
    }

    // 2. Match PIN & Active Status
    const matchedStaff = await Staff.findOne({ pin, status: 'active' });
    if (!matchedStaff) {
        return res.status(404).json({ success: false, error: 'Incorrect PIN or Staff Inactive!' });
    }

    const today = new Date().toISOString().split('T')[0];
    const timeNow = getLocalCurrentTime();

    let record = await Attendance.findOne({ staffId: matchedStaff._id, date: today });
    let punchType = 'IN';

    if (!record) {
      record = new Attendance({ staffId: matchedStaff._id, date: today, punchIn: timeNow, punchPhoto: photo, status: 'present' });
      await record.save();
      appendToExcelLedger(`IN,${matchedStaff.name},${matchedStaff.phone},${today},${timeNow},N/A,0,PRESENT`);
    } else if (!record.punchOut) {
      punchType = 'OUT';
      record.punchOut = timeNow;
      record.workHours = calculateHours(record.punchIn, timeNow);
      if (record.workHours < 5) record.status = 'half_day';
      else record.status = 'present';

      await record.save();
      appendToExcelLedger(`OUT,${matchedStaff.name},${matchedStaff.phone},${today},${record.punchIn},${timeNow},${record.workHours},${record.status}`);
    } else {
      return res.status(400).json({ success: false, error: `Today's IN & OUT completed for ${matchedStaff.name}!` });
    }

    res.json({
      success: true,
      data: { staffName: matchedStaff.name, type: punchType, time: timeNow, workHours: record.workHours }
    });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/attendance/manual', async (req, res) => {
  const { staffId, date, status } = req.body;
  try {
    const hours = status === 'present' ? 8 : (status === 'half_day' ? 4 : 0);
    const attendance = await Attendance.findOneAndUpdate(
      { staffId, date },
      { status, workHours: hours, punchIn: '09:00', punchOut: '17:00' },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: attendance });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/attendance/edit-time', async (req, res) => {
  const { id, punchIn, punchOut } = req.body;
  try {
    let record = await Attendance.findById(id);
    if (!record) return res.status(404).json({ success: false, error: 'Record not found' });

    record.punchIn = punchIn;
    record.punchOut = punchOut;
    if (punchIn && punchOut) {
        record.workHours = calculateHours(punchIn, punchOut);
        if (record.workHours < 5) record.status = 'half_day';
        else record.status = 'present';
    }
    await record.save();
    res.json({ success: true, data: record });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/attendance/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const logs = await Attendance.find({ date: today }).populate('staffId');
    res.json({ success: true, data: logs });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/attendance/all', async (req, res) => {
  const { month, year } = req.query;
  try {
    let query = {};
    let dateRegexStr = "";

    if (year && year !== 'ALL') {
        dateRegexStr += year;
    } else {
        dateRegexStr += ".*";
    }

    if (month && month !== 'ALL') {
        dateRegexStr += `-${month.padStart(2, '0')}-`;
    } else {
        dateRegexStr += "-.*-";
    }

    if (month !== 'ALL' || year !== 'ALL') {
        query.date = { $regex: dateRegexStr };
    }

    const logs = await Attendance.find(query).populate('staffId').sort({ date: -1 });
    res.json({ success: true, data: logs });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/salary/monthly-report', async (req, res) => {
  const { month, year } = req.query;
  try {
    const staffList = await Staff.find({ status: 'active' });
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

app.get('/api/export/csv', (req, res) => {
  res.download(excelFilePath, 'Staff_Attendance_Ledger.csv');
});

app.get('/api/export/salary-csv', async (req, res) => {
  const { month, year } = req.query;
  try {
    const staffList = await Staff.find({ status: 'active' });
    const startDate = `${year}-${month.padStart(2, '0')}-01`;
    const endDate = `${year}-${month.padStart(2, '0')}-31`;

    let csvContent = "StaffName,BaseMonthlySalary,PresentDays,HalfDays,EffectiveDays,NetEarnedSalary\n";

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

      csvContent += `${staff.name},${staff.salaryAmount},${shiftCompletedDays},${halfDays},${totalEffectiveDays},${netPayableSalary}\n`;
    }

    const salPath = path.join(uploadsDir, `Salary_Report_${month}_${year}.csv`);
    fs.writeFileSync(salPath, csvContent);
    res.download(salPath);
  } catch (err) { res.status(500).send("Error exporting salary sheet CSV"); }
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));