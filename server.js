const express = require('express');
const cors = require('cors');
const db = require('./db');
const admin = require('firebase-admin');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
require('dotenv').config();
const { Resend } = require('resend');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const router = express.Router();
const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(cors());
app.use(express.json());
app.use(router);

// this is for creating upload route for images used
router.post('/upload-profile', upload.single('image'), async (req, res) => {
  try {
    const result = await cloudinary.uploader.upload(req.file.path);

    res.json({
      imageUrl: result.secure_url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

// this is for saving the image url to database
router.post('/save-profile-image', async (req, res) => {
  const { userId, imageUrl } = req.body;

  await db.query(
    'UPDATE users SET profile_image = ? WHERE id = ?',
    [imageUrl, userId]
  );

  res.json({ success: true });
});

// cloudinary use for camera and media access
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});

// ── Firebase ────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ── Nodemailer (Gmail) ───────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// ── Helpers ──────────────────────────────────────────────────────────────────
async function sendToToken(token, title, body) {
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      android: { priority: 'high', notification: { channelId: 'leave_channel', sound: 'default' } },
    });
    console.log('FCM sent:', title);
  } catch (e) { console.log('FCM Error:', e.message); }
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// email send
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendOtpEmail(email, otp, type) {
  const isReset = type === 'forgot_password';

  const subject = isReset
    ? 'WorkSpace — Password Reset OTP'
    : 'WorkSpace — Verify Your Email';

  const message = isReset
    ? 'Use this OTP to reset your password.'
    : 'Use this OTP to verify your email address.';

  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: email,
      subject: subject,
      html: `
        <div style="font-family: Arial; padding: 20px;">
          <h2>${subject}</h2>
          <p>${message}</p>
          <h1 style="letter-spacing: 3px;">${otp}</h1>
        </div>
      `,
    });
  } catch (e) {
    console.error('Email error:', e.message);
    throw e;
  }
}

// ── Cron Jobs ────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', () => {
  db.query('SELECT firstName, fcm_token FROM users WHERE fcm_token IS NOT NULL AND role="user"',
    async (err, users) => {
      if (err) return;
      for (const u of users) await sendToToken(u.fcm_token, `Good morning, ${u.firstName}! 💼`, 'Have a productive day at WorkSpace.');
    });
});

cron.schedule('0 8 * * *', () => {
  const t = new Date();
  db.query(`SELECT firstName, fcm_token FROM users WHERE MONTH(dateOfBirth)=? AND DAY(dateOfBirth)=? AND fcm_token IS NOT NULL`,
    [t.getMonth() + 1, t.getDate()],
    async (err, users) => {
      if (err) return;
      for (const u of users) await sendToToken(u.fcm_token, `🎂 Happy Birthday, ${u.firstName}!`, 'Wishing you a wonderful day from the WorkSpace team!');
    });
});

cron.schedule('5 8 * * *', () => {
  const t = new Date();
  db.query(`SELECT firstName, fcm_token, YEAR(CURDATE())-YEAR(dateOfJoining) AS years FROM users WHERE MONTH(dateOfJoining)=? AND DAY(dateOfJoining)=? AND fcm_token IS NOT NULL`,
    [t.getMonth() + 1, t.getDate()],
    async (err, users) => {
      if (err) return;
      for (const u of users) {
        if (u.years < 1) continue;
        await sendToToken(u.fcm_token, `🎉 Work Anniversary!`, `Congrats ${u.firstName}! Today marks your ${u.years} year${u.years > 1 ? 's' : ''} at WorkSpace!`);
      }
    });
});

cron.schedule('0 17 * * 5', () => {
  db.query('SELECT firstName, fcm_token FROM users WHERE fcm_token IS NOT NULL AND role="user"',
    async (err, users) => {
      if (err) return;
      for (const u of users) await sendToToken(u.fcm_token, `It's Friday, ${u.firstName}! 🎉`, 'Great work this week. Enjoy your weekend!');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  OTP
// ═══════════════════════════════════════════════════════════════════════════

// Send OTP — type: 'verify_email' | 'forgot_password'
app.post('/send-otp', async (req, res) => {
  const { email, type } = req.body;
  if (!email || !type) return res.status(400).json({ message: 'Email and type required' });

  // For forgot_password: check user exists
  if (type === 'forgot_password') {
    const [users] = await db.promise().query('SELECT id FROM users WHERE email=?', [email]).catch(() => [[]]);
    if (!users || users.length === 0) return res.status(404).json({ message: 'No account found with this email' });
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  // Delete old OTPs for this email+type
  db.query('DELETE FROM otps WHERE email=? AND type=?', [email, type]);

  db.query('INSERT INTO otps (email, otp, type, expiresAt) VALUES (?,?,?,?)',
    [email, otp, type, expiresAt],
    async (err) => {
      if (err) return res.status(500).json({ message: err.message });
      try {
        await sendOtpEmail(email, otp, type);
        res.json({ message: 'OTP sent' });
      } catch (e) {
        console.log('Email error:', e.message);
        res.status(500).json({ message: 'Failed to send email. Check EMAIL_USER/EMAIL_PASS in .env' });
      }
    }
  );
});

// Verify OTP
app.post('/verify-otp', (req, res) => {
  const { email, otp, type } = req.body;
  db.query(
    'SELECT * FROM otps WHERE email=? AND otp=? AND type=? AND expiresAt > NOW() ORDER BY createdAt DESC LIMIT 1',
    [email, otp, type],
    (err, rows) => {
      if (err) return res.status(500).json({ message: err.message });
      if (!rows || rows.length === 0) return res.status(400).json({ message: 'Invalid or expired OTP' });

      // Mark as verified (for forgot_password flow)
      db.query('UPDATE otps SET verified=1 WHERE id=?', [rows[0].id]);

      // If verifying email, update user
      if (type === 'verify_email') {
        db.query('UPDATE users SET isVerified=1 WHERE email=?', [email]);
      }

      res.json({ message: 'OTP verified' });
    }
  );
});

// Reset password (after OTP verified)
app.post('/reset-password', (req, res) => {
  const { email, otp, newPassword } = req.body;
  db.query(
    'SELECT * FROM otps WHERE email=? AND otp=? AND type="forgot_password" AND verified=1 AND expiresAt > NOW() ORDER BY createdAt DESC LIMIT 1',
    [email, otp],
    (err, rows) => {
      if (err) return res.status(500).json({ message: err.message });
      if (!rows || rows.length === 0) return res.status(400).json({ message: 'OTP not verified or expired. Please start over.' });

      db.query('UPDATE users SET password=? WHERE email=?', [newPassword, email], (err2) => {
        if (err2) return res.status(500).json({ message: err2.message });
        // Clean up OTPs
        db.query('DELETE FROM otps WHERE email=? AND type="forgot_password"', [email]);
        res.json({ message: 'Password reset successfully' });
      });
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════════════════

app.post('/register', (req, res) => {
  const data = req.body;
  if (!data.role) data.role = 'user';
  data.isVerified = 0; // require email verification

  db.query('INSERT INTO users SET ?', data, (err) => {
    if (err) {
      console.log(err);
      return res.status(500).json({ message: err.message });
    }
    res.status(201).json({ message: 'User registered' });
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.query('SELECT * FROM users WHERE email=? AND password=?', [email, password], (err, result) => {
    if (err) return res.status(500).json({ message: err.message });
    if (result.length > 0) {
      db.query('UPDATE users SET last_login=NOW() WHERE id=?', [result[0].id]);
      res.json(result[0]);
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  });
});

app.post('/save-token', async (req, res) => {
  const { userId, token } = req.body;
  db.query('UPDATE users SET fcm_token=? WHERE id=?', [token, userId], async (err) => {
    if (err) return res.status(500).json({ message: err.message });
    try {
      await admin.messaging().send({
        token,
        notification: { title: 'Login Successful ✅', body: 'Welcome back to WorkSpace!' },
        android: { priority: 'high', notification: { channelId: 'leave_channel', sound: 'default' } },
      });
    } catch (e) { console.log('FCM Error:', e.message); }
    res.json({ message: 'Token saved' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  USER
// ═══════════════════════════════════════════════════════════════════════════

app.get('/user/:id', (req, res) => {
  db.query('SELECT * FROM users WHERE id=?', [req.params.id], (err, result) => {
    if (err) return res.status(500).json({ message: err.message });
    if (result.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(result[0]);
  });
});

app.put('/user/:id', (req, res) => {
  const { firstName, lastName, email, mobileNumber, emergencyContact, gender, dateOfBirth, dateOfJoining } = req.body;
  db.query(
    `UPDATE users SET firstName=?,lastName=?,email=?,mobileNumber=?,emergencyContact=?,gender=?,dateOfBirth=?,dateOfJoining=? WHERE id=?`,
    [firstName, lastName, email, mobileNumber, emergencyContact, gender, dateOfBirth, dateOfJoining, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json({ message: 'User updated successfully' });
    }
  );
});

app.delete('/user/:id', (req, res) => {
  db.query('DELETE FROM users WHERE id=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json({ message: 'User deleted successfully' });
  });
});

// Get all users (admin)
app.get('/users', (req, res) => {
  db.query('SELECT id, firstName, lastName, email, employeeCode, role, isVerified, createdAt FROM users ORDER BY createdAt DESC',
    (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json(result);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  LEAVES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/leave/apply', (req, res) => {
  const { userId, leaveType, fromDate, toDate, halfDay, reason, contact, days } = req.body;
  db.query(
    `INSERT INTO leaves (userId, leaveType, fromDate, toDate, halfDay, reason, contact, days, status) VALUES (?,?,?,?,?,?,?,?,'Pending')`,
    [userId, leaveType, fromDate, toDate, halfDay ? 1 : 0, reason, contact, days],
    async (err, result) => {
      if (err) return res.status(500).json({ message: err.message });

      // Notify all admins about new leave request
      db.query('SELECT u.firstName, u.lastName FROM users WHERE id=?', [userId], async (err2, users) => {
        if (!err2 && users.length > 0) {
          const name = `${users[0].firstName} ${users[0].lastName}`.trim();
          db.query('SELECT fcm_token FROM users WHERE role="admin" AND fcm_token IS NOT NULL', async (err3, admins) => {
            if (!err3) {
              for (const a of admins) {
                await sendToToken(a.fcm_token, '📋 New Leave Request', `${name} has submitted a ${leaveType} request.`);
              }
            }
          });
        }
      });

      res.status(201).json({ message: 'Leave applied', leaveId: result.insertId });
    }
  );
});

app.get('/leave/user/:userId', (req, res) => {
  db.query('SELECT * FROM leaves WHERE userId=? ORDER BY createdAt DESC', [req.params.userId], (err, result) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json(result);
  });
});

app.get('/leave/all', (req, res) => {
  db.query(
    `SELECT l.*, u.firstName, u.lastName, u.employeeCode, u.email
     FROM leaves l JOIN users u ON l.userId = u.id ORDER BY l.createdAt DESC`,
    (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json(result);
    }
  );
});

app.put('/leave/:leaveId/status', async (req, res) => {
  const { leaveId } = req.params;
  const { status } = req.body;
  db.query('UPDATE leaves SET status=? WHERE id=?', [status, leaveId], async (err) => {
    if (err) return res.status(500).json({ message: err.message });
    db.query(
      `SELECT u.fcm_token, u.firstName, l.leaveType, l.fromDate, l.toDate
       FROM leaves l JOIN users u ON l.userId=u.id WHERE l.id=?`,
      [leaveId],
      async (err2, rows) => {
        if (!err2 && rows.length > 0) {
          const { fcm_token, firstName, leaveType, fromDate, toDate } = rows[0];
          const from = new Date(fromDate).toDateString();
          const to = new Date(toDate).toDateString();
          const title = status === 'Approved' ? '✅ Leave Approved' : '❌ Leave Rejected';
          const body = status === 'Approved'
            ? `Hi ${firstName}, your ${leaveType} (${from} – ${to}) has been approved.`
            : `Hi ${firstName}, your ${leaveType} (${from} – ${to}) has been rejected.`;
          await sendToToken(fcm_token, title, body);
        }
        res.json({ message: `Leave ${status}` });
      }
    );
  });
});

app.get('/leave/pending-count', (req, res) => {
  db.query("SELECT COUNT(*) AS count FROM leaves WHERE status='Pending'", (err, result) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json({ count: result[0].count });
  });
});

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT || 3000}`));