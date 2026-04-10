const express = require('express');
const cors = require('cors');
const db = require('./db');
const admin = require("firebase-admin");
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});


// notification helper
async function sendToToken(token, title, body) {
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'leave_channel',
          sound: 'default',
        }
      }
    });
  } catch (e) {
    console.log('FCM Error:', e.message);
  }
}

// Daily moring reminder
cron.schedule('* * * * *',()=>{
  db.query('SELECT firstName, fcm_token FROM users WHERE fcm_token IS NOT NULL',
    async(err,users)=>{
      if(err) return;
      for(const user of users){
        await sendToToken(
          user.fcm_token,
          `Good Morning, ${user.firstName}! ☀️`,
          'Have a productive day at Office!'
        );
      }
    }
  );
});


// register
app.post('/register', (req, res) => {
  console.log("Incoming request:", req.body);

  const data = req.body;

  const sql = `INSERT INTO users SET ?`;

  db.query(sql, data, (err, result) => {
    if (err) {
      console.log(err);
      return res.send(err);
    }
    res.send('User registered');
  });
});

//login
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.query('SELECT * FROM users WHERE email=? AND password=?',
    [email, password], (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      if (result.length > 0) {
        db.query('UPDATE users SET last_login=NOW() WHERE id=?', [result[0].id]);
        res.json(result[0]);
      } else {
        res.status(401).json({ message: 'Invalid credentials' });
      }
    }
  );
});

// save token
app.post('/save-token', async (req, res) => {
  const { userId, token } = req.body;

  db.query('UPDATE users SET fcm_token=? WHERE id=?', [token, userId],
    async (err) => {
      if (err) return res.status(500).send(err);

      // Now send the notification — token is guaranteed to exist
      try {
        await admin.messaging().send({
          token: token,
          notification: {
            title: 'Login Successful ✅',
            body: 'Welcome back to WorkSpace!',
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'leave_channel', // must match Flutter channel ID
              sound: 'default',
            },
          },
        });
        console.log('Login notification sent');
      } catch (e) {
        console.log('FCM Error:', e.message);
      }

      res.json({ message: 'Token saved' });
    }
  );
});

// get user data
app.get('/user/:id', (req, res) => {
  const id = req.params.id;

  db.query('SELECT * FROM users WHERE id=?', [id], (err, result) => {
    if (err) return res.status(500).send(err);

    if (result.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(result[0]);
  });
});

// update user data
app.put('/user/:id', (req, res) => {
  const id = req.params.id;

  const {
    firstName,
    lastName,
    email,
    mobileNumber,
    emergencyContact,
    gender,
    dateOfBirth,
    dateOfJoining
  } = req.body;

  const sql = `
    UPDATE users 
    SET 
      firstName = ?, 
      lastName = ?, 
      email = ?, 
      mobileNumber = ?, 
      emergencyContact = ?, 
      gender = ?, 
      dateOfBirth = ?, 
      dateOfJoining = ?
    WHERE id = ?
  `;

  db.query(
    sql,
    [
      firstName,
      lastName,
      email,
      mobileNumber,
      emergencyContact,
      gender,
      dateOfBirth,
      dateOfJoining,
      id
    ],
    (err, result) => {
      if (err) {
        console.log("UPDATE ERROR:", err);
        return res.status(500).send(err);
      }

      res.send("User updated successfully");
    }
  );
});

// apply for leave
app.put('/apply-leave/:id', (req, res) => {
  const id = req.params.id;
  const { leaveStartDate, leaveEndDate } = req.body;

  db.query(
    `UPDATE users 
     SET leaveStartDate=?, leaveEndDate=?, isApproved=NULL 
     WHERE id=?`,
    [leaveStartDate, leaveEndDate, id],
    (err) => {
      if (err) return res.send(err);
      res.send('Leave applied');
    }
  );
});

// approve / reject leave
app.put('/leave-status/:id', (req, res) => {
  const id = req.params.id;
  const { isApproved } = req.body;

  db.query(
    'UPDATE users SET isApproved=? WHERE id=?',
    [isApproved, id],
    (err) => {
      if (err) return res.send(err);
      res.send('Leave status updated');
    }
  );
});

// delete user
app.delete('/user/:id', (req, res) => {
  const id = req.params.id;

  db.query('DELETE FROM users WHERE id=?', [id], (err) => {
    if (err) return res.send(err);
    res.send('User Deleted Successfully');
  });
});

// starting server
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});


console.log("ENV CHECK:", {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  db: process.env.DB_NAME,
  port: process.env.DB_PORT
});