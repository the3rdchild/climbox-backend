// get-jids-safe.js
// npm i @whiskeysockets/baileys qrcode-terminal pino
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(__dirname, 'session');
const GROUPS_OUT = path.join(__dirname, 'groups.json');

let sock = null;
let restarting = false;

async function start() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    // optional: get current baileys version to be safe
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log('Baileys web version:', version, 'isLatest?', isLatest);

    sock = makeWASocket({
      auth: state,
      version, // use latest version fetched
      printQRInTerminal: false, // we'll print QR manually from event
      // logger: require('pino')({ level: 'debug' }), // enable if you want full logs
      browser: ['get-jids', 'Chrome', '13.0'],
      defaultQueryTimeoutMs: undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      // update: { connection, lastDisconnect, qr, isNewLogin, ... }
      console.log('connection.update:', update);

      if (update.qr) {
        console.log('=== QR CODE ===');
        qrcode.generate(update.qr, { small: true });
        console.log('Scan the QR above with the sender WhatsApp account.');
      }

      if (update.connection === 'open') {
        console.log('Connected -> open');
        // On open fetch all groups and save them
        try {
          const groups = await sock.groupFetchAllParticipating();
          // groups is object keyed by groupJid ('1234-123@g.us') with metadata
          const byName = {};
          for (const [jid, meta] of Object.entries(groups || {})) {
            const name = meta?.subject || jid;
            byName[name] = jid;
          }
          fs.writeFileSync(GROUPS_OUT, JSON.stringify(byName, null, 2));
          console.log('Saved groups to', GROUPS_OUT);
        } catch (e) {
          console.warn('Failed to fetch groups on open:', e?.message || e);
        }
      }

      if (update.connection === 'close') {
        console.warn('Connection closed:', update.lastDisconnect || update);
        // detect if reconnection needed
        // If server returned stream error (515) or other, restart
        // We'll attempt automatic restart with backoff
        if (!restarting) {
          restarting = true;
          const waitMs = 2000;
          console.log(`Reconnecting in ${waitMs}ms...`);
          setTimeout(() => {
            restarting = false;
            start().catch(err => console.error('Restart failed', err));
          }, waitMs);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try {
          const from = m.key?.remoteJid;
          if (!from) continue;
          // group JIDs end with @g.us
          if (from.endsWith && from.endsWith('@g.us')) {
            console.log('Group message from:', from, 'pushName:', m.pushName || m.pushname || '(no pushname)');
          } else {
            console.log('Message from:', from);
          }
        } catch (e) {
          console.error('messages.upsert handler error', e);
        }
      }
    });

    sock.ev.on('connection.error', e => {
      console.error('connection.error event:', e);
    });

    // keep process alive
    process.on('SIGINT', async () => {
      console.log('SIGINT - closing...');
      try { if (sock) await sock.logout(); } catch (e) {}
      process.exit(0);
    });

  } catch (err) {
    console.error('start() fatal error', err);
    // backoff restart
    setTimeout(() => start().catch(()=>{}), 3000);
  }
}

start();
