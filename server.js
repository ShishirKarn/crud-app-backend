const express = require('express');
const cors = require('cors');
const db = require('./db');
const admin = require('firebase-admin');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin ──────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ── FCM helper ──────────────────────────────────────────────────────────────
async function sendToToken(token, title, body) {
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      android: { priority: 'high', notification: { channelId: 'leave_channel', sound: 'default' } },
    });
    console.log('FCM sent:', title);
  } catch (e) {
    console.log('FCM Error:', e.message);
  }
}

// ── Cron: Daily afternoon reminder ──────────────────────────────────────────
cron.schedule('0 9 * * *', () => {
  db.query('SELECT firstName, fcm_token FROM users WHERE fcm_token IS NOT NULL AND role="user"',
    async (err, users) => {
      if (err) return;
      for (const user of users) {
        await sendToToken(user.fcm_token,
          `Good morning, ${user.firstName}! 💼`,
          'Have a productive day at WorkSpace.');
      }
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════════════════

// Register
app.post('/register', (req, res) => {
  const data = req.body;
  // Default role to 'user' — admin accounts are set manually in DB
  if (!data.role) data.role = 'user';

  db.query('INSERT INTO users SET ?', data, (err) => {
    if (err) {
      console.log(err);
      return res.status(500).json({ message: err.message });
    }
    res.status(201).json({ message: 'User registered' });
  });
});

// Login — returns user including role
app.post('/login', (req, res) => {
  const { email, password } = req.body;

  db.query(
    'SELECT * FROM users WHERE email=? AND password=?',
    [email, password],
    (err, result) => {
      if (err) return res.status(500).json({ message: err.message });

      if (result.length > 0) {
        const user = result[0];

        db.query('UPDATE users SET last_login=NOW() WHERE id=?', [user.id]);

        // ✅ normalize role (IMPORTANT)
        user.role = (user.role || 'user').toString().trim().toLowerCase();

        console.log("✅ LOGIN USER:", user.email, "| ROLE:", user.role);

        res.json(user);
      } else {
        res.status(401).json({ message: 'Invalid credentials' });
      }
    }
  );
});

// Save FCM token — also sends welcome notification
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

// Get user
app.get('/user/:id', (req, res) => {
  db.query('SELECT * FROM users WHERE id=?', [req.params.id], (err, result) => {
    if (err) return res.status(500).json({ message: err.message });
    if (result.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(result[0]);
  });
});

// Update user
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

// Delete user
app.delete('/user/:id', (req, res) => {
  db.query('DELETE FROM users WHERE id=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json({ message: 'User deleted successfully' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  LEAVES
// ═══════════════════════════════════════════════════════════════════════════

// Apply for leave
app.post('/leave/apply', (req, res) => {
  const { userId, leaveType, fromDate, toDate, halfDay, reason, contact, days } = req.body;
  db.query(
    `INSERT INTO leaves (userId, leaveType, fromDate, toDate, halfDay, reason, contact, days, status) VALUES (?,?,?,?,?,?,?,?,'Pending')`,
    [userId, leaveType, fromDate, toDate, halfDay ? 1 : 0, reason, contact, days],
    (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      res.status(201).json({ message: 'Leave applied', leaveId: result.insertId });
    }
  );
});

// Get leaves for a specific user
app.get('/leave/user/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);

  console.log("➡️ /leave/user called with:", userId);

  // 🛑 guard against bad input
  if (!userId || isNaN(userId)) {
    console.log("❌ Invalid userId");
    return res.status(400).json({ message: 'Invalid userId' });
  }

  db.query(
    'SELECT * FROM leaves WHERE userId=? ORDER BY createdAt DESC',
    [userId],
    (err, result) => {
      if (err) {
        console.log("❌ DB ERROR:", err);
        return res.status(500).json({ message: err.message });
      }

      console.log("✅ Leaves found:", result.length);
      res.json(result);
    }
  );
});

// Get ALL leaves (admin) — includes user info
app.get('/leave/all', (req, res) => {
  db.query(
    `SELECT l.*, u.firstName, u.lastName, u.employeeCode, u.email
     FROM leaves l
     JOIN users u ON l.userId = u.id
     ORDER BY l.createdAt DESC`,
    (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json(result);
    }
  );
});

// Approve or reject a leave (admin) — triggers FCM notification
app.put('/leave/:leaveId/status', async (req, res) => {
  const { leaveId } = req.params;
  const { status, adminId } = req.body;

  // check role
  db.query('SELECT role FROM users WHERE id=?', [adminId], (err, result) => {
    if (err) return res.status(500).json({ message: err.message });

    if (result.length === 0 || result[0].role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    // update leave
    db.query('UPDATE leaves SET status=? WHERE id=?', [status, leaveId], async (err) => {
      if (err) return res.status(500).json({ message: err.message });

      // notification
      db.query(
        `SELECT u.fcm_token, u.firstName, l.leaveType, l.fromDate, l.toDate
         FROM leaves l 
         JOIN users u ON l.userId=u.id 
         WHERE l.id=?`,
        [leaveId],
        async (err2, rows) => {
          if (!err2 && rows.length > 0) {
            const { fcm_token, firstName, leaveType, fromDate, toDate } = rows[0];

            const from = new Date(fromDate).toDateString();
            const to = new Date(toDate).toDateString();

            const title = status === 'Approved' ? '✅ Leave Approved' : '❌ Leave Rejected';
            const body =
              status === 'Approved'
                ? `Hi ${firstName}, your ${leaveType} (${from} – ${to}) has been approved.`
                : `Hi ${firstName}, your ${leaveType} (${from} – ${to}) has been rejected.`;

            await sendToToken(fcm_token, title, body);
          }

          res.json({ message: `Leave ${status}` });
        }
      );
    });
  });
});

// Get pending leave count (admin badge)
app.get('/leave/pending-count', (req, res) => {
  db.query("SELECT COUNT(*) AS count FROM leaves WHERE status='Pending'", (err, result) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json({ count: result[0].count });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════════════════
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});

process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('🔥 Unhandled Rejection:', err);
});