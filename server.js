require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const UPI_ID = process.env.UPI_ID || '9696159863.wallet@phonepe';
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Vikas Kumar Mishra';
const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || `http://localhost:${PORT}`;

// Pricing Plans Config
const PLANS = {
  starter: { name: 'Starter Pack', amount: 100, searches: 2 },
  popular: { name: 'Popular Value Pack', amount: 500, searches: 12 },
  vip: { name: 'VIP Business Pack', amount: 1000, searches: 30 }
};

// ----------------------------------------------------
// 1. Health Check Endpoint (For UptimeRobot 24/7 Ping)
// ----------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date() });
});

// ----------------------------------------------------
// 2. User Balance & Sync APIs
// ----------------------------------------------------
app.get('/api/user/balance', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  db.get('SELECT balance FROM users WHERE userId = ?', [userId], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    if (!row) {
      db.run('INSERT INTO users (userId, balance) VALUES (?, ?)', [userId, 0], (err2) => {
        if (err2) return res.status(500).json({ error: 'DB Error' });
        return res.json({ userId, balance: 0 });
      });
    } else {
      return res.json({ userId, balance: row.balance });
    }
  });
});

// ----------------------------------------------------
// 3. Payment Request & Telegram Webhook Broadcast
// ----------------------------------------------------
app.post('/api/payment/request', async (req, res) => {
  const { userId, planId, txnId } = req.body;
  const plan = PLANS[planId];

  if (!plan || !userId || !txnId) {
    return res.status(400).json({ error: 'Invalid Payment Request' });
  }

  db.run(
    'INSERT INTO transactions (txnId, userId, planId, amount, searches, status) VALUES (?, ?, ?, ?, ?, ?)',
    [txnId, userId, planId, plan.amount, plan.searches, 'PENDING'],
    async (err) => {
      if (err) return res.status(500).json({ error: 'Failed to record transaction' });

      // Telegram Message Formatting
      const message = `🔔 *NEW ADD BALANCE REQUEST*\n\n` +
                      `👤 *User ID:* \`${userId}\`\n` +
                      `📦 *Plan:* ${plan.name}\n` +
                      `💰 *Amount:* ₹${plan.amount}\n` +
                      `🔍 *Searches Added:* +${plan.searches}\n` +
                      `🆔 *Txn Reference:* \`${txnId}\`\n` +
                      `⏰ *Time:* ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: 'Approve ✅', callback_data: `APPROVE:${txnId}` },
            { text: 'Reject ❌', callback_data: `REJECT:${txnId}` }
          ]
        ]
      };

      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          text: message,
          parse_mode: 'Markdown',
          reply_markup: inlineKeyboard
        });
      } catch (tgErr) {
        console.error('Telegram notification failed:', tgErr.message);
      }

      return res.json({ success: true, message: 'Request submitted to admin for approval' });
    }
  );
});

// ----------------------------------------------------
// 4. Telegram Webhook Listener for Admin [Approve/Reject]
// ----------------------------------------------------
app.post('/telegram/webhook', async (req, res) => {
  const body = req.body;
  
  if (body && body.callback_query) {
    const callback = body.callback_query;
    const data = callback.data; 
    const messageId = callback.message.message_id;
    const chatId = callback.message.chat.id;

    const [action, txnId] = data.split(':');

    db.get('SELECT * FROM transactions WHERE txnId = ?', [txnId], async (err, txn) => {
      if (err || !txn) {
        await answerCallback(callback.id, 'Transaction not found or error!');
        return res.sendStatus(200);
      }

      if (txn.status !== 'PENDING') {
        await answerCallback(callback.id, `Already processed as ${txn.status}`);
        return res.sendStatus(200);
      }

      if (action === 'APPROVE') {
        db.run('UPDATE transactions SET status = ? WHERE txnId = ?', ['APPROVED', txnId], (uErr) => {
          if (uErr) return;

          // Add balance to user (searches * 50 = balance in Rupees)
          const addedAmount = txn.searches * 50;
          db.run(
            'INSERT INTO users (userId, balance) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET balance = balance + ?',
            [txn.userId, addedAmount, addedAmount],
            async () => {
              await answerCallback(callback.id, 'Transaction Approved! Balance credited.');
              await editTelegramMessage(chatId, messageId, callback.message.text + '\n\n✅ *STATUS: APPROVED BY ADMIN*');
            }
          );
        });
      } else if (action === 'REJECT') {
        db.run('UPDATE transactions SET status = ? WHERE txnId = ?', ['REJECTED', txnId], async () => {
          await answerCallback(callback.id, 'Transaction Rejected.');
          await editTelegramMessage(chatId, messageId, callback.message.text + '\n\n❌ *STATUS: REJECTED BY ADMIN*');
        });
      }
    });
  }

  res.sendStatus(200);
});

async function answerCallback(callbackQueryId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text,
      show_alert: true
    });
  } catch (e) {}
}

async function editTelegramMessage(chatId, messageId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (e) {}
}

// ----------------------------------------------------
// 5. Deduct Balance API (ONLY IF DATA FOUND)
// ----------------------------------------------------
app.post('/api/user/deduct', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  db.get('SELECT balance FROM users WHERE userId = ?', [userId], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    if (!row || row.balance < 50) {
      return res.status(402).json({ error: 'Insufficient balance. Minimum ₹50 required.' });
    }

    db.run('UPDATE users SET balance = balance - 50 WHERE userId = ?', [userId], function(err2) {
      if (err2) return res.status(500).json({ error: 'Failed to deduct balance' });
      return res.json({ success: true, remainingBalance: row.balance - 50 });
    });
  });
});

// ----------------------------------------------------
// 6. External Vahan Lookup Handler
// ----------------------------------------------------
app.get('/api/vahan', async (req, res) => {
  const veh = req.query.veh;
  if (!veh) return res.status(400).json({ status: 'error', message: 'Vehicle number required' });

  try {
    const response = await axios.get(`https://vahan-system.onrender.com/api/vahan?veh=${encodeURIComponent(veh)}`, {
      timeout: 18000
    });
    return res.json(response.data);
  } catch (err) {
    return res.status(504).json({ status: 'error', message: 'Vehicle details not found or connection timed out.' });
  }
});

// Auto Set Telegram Webhook on startup
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (TELEGRAM_TOKEN && PUBLIC_SERVER_URL) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
        url: `${PUBLIC_SERVER_URL}/telegram/webhook`
      });
      console.log('Telegram Webhook Automatically Registered.');
    } catch (e) {
      console.warn('Webhook auto-registration notice:', e.message);
    }
  }
});
