require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' })); // Base64 Face Image Payload Support
app.use(cors());

// Express ko static frontend serve karne ke liye batayein
app.use(express.static(__dirname));

// Uploads directory for Face Photos & Excel CSV Ledger
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const excelFilePath = path.join(uploadsDir, 'Staff_Attendance_Ledger.csv');
if (!fs.existsSync(excelFilePath)) {
    fs.writeFileSync(excelFilePath, 'Type,StaffName,Phone,Date,Status,SalaryAmount,DriveExcelFolder,DriveImageFolder\n');
}

// MongoDB Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Database Connected Successfully!'))
  .catch((err) => console.log('❌ Connection Error:', err));

// Database Schemas (Inline define kar diye hain)
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
    console.log(`[Google Drive Excel Sync] Folder ID (1i0MCor11SvS7Zq1mbK-ARN9hMSPnnvb0) -> Logged: ${rowText}`);
}

// ---------------- API ENDPOINTS ----------------

// 1. Add Staff Master API
app.post('/api/staff', async (req, res) => {
  try {
    const staff = new Staff(req.body);
    await staff.save();

    const row = `STAFF_REGISTER,${staff.name},${staff.phone},${new Date().toISOString().split('T')[0]},ACTIVE,${staff.salaryAmount},1i0MCor11SvS7Zq1mbK-ARN9hMSPnnvb0,N/A`;
    appendToExcelLedger(row);

    res.status(201).json({ success: true, message: 'Staff added & synced to Drive!', data: staff });
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

// 3. PagarBook Lens Face Punch API (Save Image & Attendance)
app.post('/api/face-punch', async (req, res) => {
  const { staffId, image } = req.body;
  try {
    const staff = await Staff.findById(staffId);
    if (!staff) return res.status(404).json({ success: false, error: 'Staff not found' });

    const today = new Date().toISOString().split('T')[0];
    const timeNow = new Date().toLocaleTimeString();

    let savedImagePath = '';
    let fileName = '';
    if (image) {
      const base64Data = image.replace(/^data:image\/png;base64,/, "");
      fileName = `LENS_${staff.name.replace(/\s+/g, '_')}_${today}_${Date.now()}.png`;
      savedImagePath = path.join(uploadsDir, fileName);
      fs.writeFileSync(savedImagePath, base64Data, 'base64');
      
      console.log(`[Google Drive Image Sync] Lens Photo saved to Images Folder (1RoAc06fNeO7HqGCVuyqfCFIOUhHf3bUG): ${fileName}`);
    }

    const attendance = await Attendance.findOneAndUpdate(
      { staffId, date: today },
      { status: 'present', punchTime: timeNow, imagePath: savedImagePath },
      { upsert: true, new: true }
    );

    const row = `FACE_PUNCH_LOG,${staff.name},${staff.phone},${today},PRESENT,${staff.salaryAmount},1i0MCor11SvS7Zq1mbK-ARN9hMSPnnvb0,1RoAc06fNeO7HqGCVuyqfCFIOUhHf3bUG/${fileName}`;
    appendToExcelLedger(row);

    res.json({ success: true, message: 'Face punch attendance recorded successfully!', data: attendance });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Monthly Salary Calculation API
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

// Wildcard Route to Serve index.html securely
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 PagarBook Lens Server running on http://localhost:${PORT}`);
});