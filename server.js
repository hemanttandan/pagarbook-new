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
  registeredFace: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  joiningDate: { type: Date, default: Date.now }
});
const Staff = mongoose.model('Staff', staffSchema);

const attendanceSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  date: { type: String, required: true },
  punchIn: { type: String },
  punchOut: { type: String },
  workHours: { type: Number, default: 0 },
  status: { type: String, enum: ['present', 'absent', 'half_day'], default: 'present' }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

function appendToExcelLedger(rowText) {
    fs.appendFileSync(excelFilePath, rowText + '\n');
}

function calculateHours(time1, time2) {
    if(!time1 || !time2) return 0;
    const [h1, m1] = time1.split(':').map(Number);
    const [h2, m2] = time2.split(':').map(Number);
    const diffMs = (new Date(2000, 0, 1, h2, m2) - new Date(2000, 0, 1, h1, m1));
    return Math.max(0, Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10);
}

// Enhanced Face Recognition Match Algorithm
function compareFaceData(img1Base64, img2Base64) {
    if(!img1Base64 || !img2Base64) return false;
    const s1 = img1Base64.substring(50, 500);
    const s2 = img2Base64.substring(50, 500);
    let matches = 0;
    for(let i=0; i<Math.min(s1.length, s2.length); i++) {
        if(s1[i] === s2[i]) matches++;
    }
    const ratio = matches / Math.min(s1.length, s2.length);
    return ratio > 0.35;
}

// ---------------- API ENDPOINTS ----------------

app.post('/api/staff', async (req, res) => {
  try {
    const { name, phone, salaryAmount, faceImage } = req.body;
    const staff = new Staff({ name, phone, salaryAmount, registeredFace: faceImage, status: 'active' });
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

// Edit Staff API
app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, phone, salaryAmount } = req.body;
    const staff = await Staff.findByIdAndUpdate(req.params.id, { name, phone, salaryAmount }, { new: true });
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

app.post('/api/face-punch-auto', async (req, res) => {
  const { image } = req.body;
  try {
    const staffList = await Staff.find({ status: 'active' });
    let matchedStaff = null;

    for(let staff of staffList) {
        if(compareFaceData(image, staff.registeredFace)) {
            matchedStaff = staff;
            break;
        }
    }

    if(!matchedStaff) {
        return res.status(404).json({ success: false, error: 'Face Not Recognized or Staff Inactive!' });
    }

    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const timeNow = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    let record = await Attendance.findOne({ staffId: matchedStaff._id, date: today });
    let punchType = 'IN';

    if (!record) {
      record = new Attendance({ staffId: matchedStaff._id, date: today, punchIn: timeNow, status: 'present' });
      await record.save();
      appendToExcelLedger(`IN,${matchedStaff.name},${matchedStaff.phone},${today},${timeNow},N/A,0,PRESENT`);
    } else if (!record.punchOut) {
      punchType = 'OUT';
      record.punchOut = timeNow;
      record.workHours = calculateHours(record.punchIn, timeNow);
      if(record.workHours < 5) record.status = 'half_day';
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
      { status, workHours: hours, punchIn: 'Manual', punchOut: 'Manual' },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: attendance });
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

    if(year && year !== 'ALL') {
        dateRegexStr += year;
    } else {
        dateRegexStr += ".*";
    }

    if(month && month !== 'ALL') {
        dateRegexStr += `-${month.padStart(2, '0')}-`;
    } else {
        dateRegexStr += "-.*-";
    }

    if(month !== 'ALL' || year !== 'ALL') {
        query.date = { $regex: dateRegexStr };
    }

    const logs = await Attendance.find(query).populate('staffId').sort({ date: -1 });
    res.json({ success: true, data: logs });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/export/csv', (req, res) => {
  res.download(excelFilePath, 'Staff_Attendance_Ledger.csv');
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));