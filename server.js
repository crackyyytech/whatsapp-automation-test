'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const fileupload = require('express-fileupload');
const pino = require('pino');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'session');
const FORCE_COUNTRY_CODE = (process.env.FORCE_COUNTRY_CODE || '').replace(/[^\d]/g, '');

const state = {
  connected: false,
  sending: false,
  qr: null,
  stopRequested: false,
  lastError: null
};

let sock = null;
let startBusy = false;

function log(...args) { console.log(new Date().toISOString(), ...args); }

/* =========================================================
   WhatsApp client (Baileys)
   ========================================================= */

async function startClient() {
  if (startBusy) return;
  startBusy = true;
  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    let version;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch (e) {
      version = undefined;
    }

    const client = makeWASocket({
      version,
      logger: pino({ level: 'warn' }),
      printQRInTerminal: false,
      browser: ['WhatsAppDocumentSender', 'Chrome', '131.0'],
      auth: authState,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    if (process.env.STATE_TEST === '1') {
      state.connected = true;
      client.sendMessage = async (jid, content) => {
        log('FAKE-SEND', jid, 'bytes=' + (content.document ? content.document.length : 0), 'name=' + content.fileName);
      };
    }

    client.ev.on('creds.update', saveCreds);

    client.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.lastError = null;
        QRCode.toBuffer(qr, { width: 512, margin: 1 })
          .then(buf => {
            state.qr = 'data:image/png;base64,' + buf.toString('base64');
            log('QR code ready - scan it from the desktop app');
          })
          .catch(err => {
            log('Failed to render QR:', err.message);
            state.qr = null;
          });
      }

      if (connection === 'open') {
        state.connected = true;
        state.qr = null;
        state.lastError = null;
        log('WhatsApp connected');
      }

      if (connection === 'close') {
        state.connected = false;
        state.qr = null;
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode : null;

        if (statusCode === DisconnectReason.loggedOut) {
          state.lastError = 'logged out';
          log('Logged out from WhatsApp. Delete the session folder and restart to re-link.');
          return;
        }

        state.lastError = 'disconnected';
        log('Connection closed, reconnecting in 3s...');
        setTimeout(startClient, 3000);
      }
    });

    sock = client;
  } catch (e) {
    log('Failed to start WhatsApp client:', e.message);
    setTimeout(startClient, 5000);
  } finally {
    startBusy = false;
  }
}

function normalizeJid(raw) {
  if (!raw) return null;
  let num = String(raw).replace(/[^\d]/g, '');
  if (!num || num.length < 7) return null;
  if (FORCE_COUNTRY_CODE && num.length < 12) {
    num = FORCE_COUNTRY_CODE + num;
  }
  return num + '@s.whatsapp.net';
}

async function sendDocumentToNumber(jid, caption, buffer, fileName, mime) {
  const result = { number: jid.split('@')[0], status: 'unknown', error: null };
  try {
    await sock.sendMessage(jid, {
      document: buffer,
      fileName: fileName,
      mimetype: mime,
      caption: caption || undefined
    });
    result.status = 'sent';
  } catch (e) {
    result.status = 'failed';
    result.error = e.message || 'send failed';
  }
  return result;
}

/* =========================================================
   Express app - routes match the VB.NET client contract
   Contract:
     GET  /status -> {connected, sending, qr}
     POST /send   -> {success, message, results:[{number,status,error}]}
     POST /stop   -> {success, message}
   ========================================================= */

const app = express();
app.use(fileupload({ limits: { fileSize: 50 * 1024 * 1024 }, abortOnLimit: true }));
app.use(express.json());

function statusPayload() {
  return { connected: state.connected, sending: state.sending, qr: state.qr, lastError: state.lastError };
}

function handleStatus(req, res) {
  res.json(statusPayload());
}

async function handleSend(req, res) {
  try {
    if (!state.connected) {
      return res.json({ success: false, message: 'WhatsApp not connected. Check the QR code.', results: [] });
    }
    if (state.sending) {
      return res.json({ success: false, message: 'A send job is already in progress.', results: [] });
    }
    if (state.stopRequested) {
      state.stopRequested = false;
      return res.json({ success: false, message: 'Sending was stopped.', results: [] });
    }
    if (!req.files || !req.files.document) {
      return res.json({ success: false, message: 'Missing document file.', results: [] });
    }

    let numbers = [];
    if (req.body.numbers) {
      try {
        const parsed = JSON.parse(req.body.numbers);
        if (Array.isArray(parsed)) numbers = parsed.map(String);
      } catch (e) {
        return res.json({ success: false, message: 'numbers must be a JSON array of strings.', results: [] });
      }
    }
    if (numbers.length === 0) {
      return res.json({ success: false, message: 'No valid numbers provided.', results: [] });
    }

    const file = req.files.document;
    const message = req.body.message || '';

    state.sending = true;
    state.stopRequested = false;
    const results = [];

    try {
      for (const number of numbers) {
        if (state.stopRequested) break;
        const jid = normalizeJid(number);
        if (!jid) {
          results.push({ number: number, status: 'failed', error: 'invalid number' });
          continue;
        }
        results.push(await sendDocumentToNumber(jid, message, file.data, file.name, file.mimetype));
      }
    } finally {
      state.sending = false;
      state.stopRequested = false;
    }

    const failed = results.filter(r => r.status !== 'sent').length;
    const ok = results.length - failed;

    if (failed === 0) {
      return res.json({ success: true, message: 'All ' + results.length + ' document(s) sent.', results });
    }
    if (ok === 0) {
      return res.json({ success: false, message: '0 of ' + results.length + ' sent.', results });
    }
    return res.json({ success: true, message: ok + ' sent, ' + failed + ' failed.', results });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal error: ' + e.message, results: [] });
  }
}

function handleStop(req, res) {
  if (state.sending) state.stopRequested = true;
  res.json({ success: true, message: 'Sending stopped.' });
}

// The VB.NET client appends /status, /send, /stop to the configured base URL,
// so the routes are mounted both at the root and under /api/.
function mount(prefix) {
  app.get(prefix + '/status', handleStatus);
  app.post(prefix + '/send', handleSend);
  app.post(prefix + '/stop', handleStop);
}
mount('');
mount('/api');

app.get('/hello', (req, res) => {
  res.json({ ok: true, service: 'whatsapp-document-sender', connected: state.connected });
});

/* =========================================================
   Boot
   ========================================================= */

fs.mkdirSync(SESSION_DIR, { recursive: true });
startClient();

app.listen(PORT, HOST, () => {
  log('WhatsApp Document Sender server listening on http://' + HOST + ':' + PORT);
  log('Set the desktop app ApiUrl to http://' + HOST + ':' + PORT + '/api/   (or without /api/)');
});