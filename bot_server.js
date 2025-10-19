// SMM Panel WhatsApp Bot Server (Node.js/Express/Baileys)

const { 
    default: makeWASocket, useMultiFileAuthState, DisconnectReason, 
    fetchLatestBaileysVersion, makeInMemoryStore, Browsers, 
    jidDecode, proto, downloadMediaMessage, WAMessageStubType 
} = require('@adiwajshing/baileys');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');

// --- Global Setup and Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_FOLDER = './sessions';

// In-memory store to manage connections and settings for multiple users
const sessions = new Map();
const userSettings = new Map(); // Stores { sessionName: { autoSeen: boolean, autoReact: boolean } }

// Ensure session folder exists
if (!fs.existsSync(SESSION_FOLDER)) {
    fs.mkdirSync(SESSION_FOLDER);
}

// Function to decode JID (JID ko decode karne ka function)
const jidToName = (jid) => {
    if (!jid) return '';
    const decode = jidDecode(jid);
    return decode.user;
};

// --- Bot Core Logic (Connection and Events) ---
async function startSession(sessionName, res) {
    // 1. Check if session already exists (Dekhen ki session pehle se hai ya nahi)
    if (sessions.has(sessionName)) {
        // Agar yeh API call se aaya hai, toh response bhej den
        if (res.status) { 
            res.status(200).json({ success: false, message: 'Session already active.' });
        }
        return;
    }

    const sessionPath = `${SESSION_FOLDER}/${sessionName}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // 2. Fetch WhatsApp socket (WhatsApp socket shuru karen)
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        auth: state,
    });

    // 3. Store in-memory (Memory mein store karen)
    sessions.set(sessionName, { sock, state, saveCreds });
    userSettings.set(sessionName, { autoSeen: false, autoReact: false });

    // 4. Handle Connection Updates (Connection updates ko handle karen)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for ${sessionName}. Reconnecting: ${shouldReconnect}`);
            
            // Clean up session data if logged out
            if (!shouldReconnect) {
                sessions.delete(sessionName);
                userSettings.delete(sessionName);
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`Session ${sessionName} permanently removed.`);
            } else {
                // Auto reconnect
                startSession(sessionName, res);
            }
        } else if (qr && res.status) { // Only send QR response if it's an API call
            const qrCodeUrl = await QRCode.toDataURL(qr);
            res.status(200).json({ success: true, method: 'qr', qr: qrCodeUrl, sessionName: sessionName });
        } else if (connection === 'open' && res.status) {
            res.status(200).json({ success: true, message: `Session ${sessionName} connected!`, status: 'connected' });
        }
    });

    // 5. Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // 6. Handle Incoming Messages and Commands
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.fromMe) return;

        const senderJid = msg.key.remoteJid;
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
        const settings = userSettings.get(sessionName);

        // --- Feature 1: Auto React (Random) ---
        if (settings.autoReact) {
            const reactions = ['🔥', '😂', '👍', '❤️', '🤯'];
            const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];
            await sock.sendMessage(senderJid, { react: { text: randomReaction, key: msg.key } });
        }

        // --- COMMANDS ---
        if (body.startsWith('.')) {
            const command = body.split(' ')[0];
            const args = body.substring(command.length).trim();

            switch (command) {
                case '.menu':
                    const menu = `
*🌟 MD Bot Commands 🌟*

🤖 *Bot Status:*
.autostatusseen ${settings.autoSeen ? 'ON' : 'OFF'}
.autoreact ${settings.autoReact ? 'ON' : 'OFF'}

*Commands:*
.menu - Yeh menu dekhein.
.autostatusseen on/off - Status ko automatically dekhne ke liye.
.autoreact on/off - Incoming messages par random reactions bhejen.
.vv - Reply karen kisi View Once media (photo/video) par use download karne ke liye.
`;
                    await sock.sendMessage(senderJid, { text: menu });
                    break;

                case '.autostatusseen':
                    const autoSeenStatus = args === 'on';
                    userSettings.set(sessionName, { ...settings, autoSeen: autoSeenStatus });
                    await sock.sendMessage(senderJid, { text: `✅ Auto Status Seen/React is now ${autoSeenStatus ? 'ON' : 'OFF'}` });
                    break;

                case '.autoreact':
                    const autoReactStatus = args === 'on';
                    userSettings.set(sessionName, { ...settings, autoReact: autoReactStatus });
                    await sock.sendMessage(senderJid, { text: `✅ Auto Incoming Message React is now ${autoReactStatus ? 'ON' : 'OFF'}` });
                    break;

                case '.vv':
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    
                    if (!quoted || !quoted.viewOnceMessage) {
                        await sock.sendMessage(senderJid, { text: '❌ Kripya kisi View Once media (Photo/Video) par reply karein.' });
                        return;
                    }

                    const viewOnceMsg = quoted.viewOnceMessage.message;
                    let mediaType, mediaData;

                    if (viewOnceMsg.imageMessage) {
                        mediaType = 'image';
                        mediaData = viewOnceMsg.imageMessage;
                    } else if (viewOnceMsg.videoMessage) {
                        mediaType = 'video';
                        mediaData = viewOnceMsg.videoMessage;
                    }

                    if (mediaType) {
                        const buffer = await downloadMediaMessage(
                            { message: { [mediaType + 'Message']: mediaData }, key: msg.key },
                            'buffer',
                            {},
                            { logger: pino({ level: 'silent' }) }
                        );
                        
                        await sock.sendMessage(senderJid, { 
                            [mediaType]: buffer, 
                            caption: `✅ VV Downloaded (${mediaType})` 
                        });
                    } else {
                         await sock.sendMessage(senderJid, { text: '❌ View Once media detect nahi hua.' });
                    }
                    break;

                default:
                    await sock.sendMessage(senderJid, { text: `❌ Unknown command: ${command}. Use .menu to see available commands.` });
            }
        }
    });

    // --- Feature 2: Auto Status Seen/React ---
    sock.ev.on('presence.update', async (update) => {
        if (update.id === 'status@broadcast' && update.presences) {
            const settings = userSettings.get(sessionName);
            if (settings.autoSeen) {
                for (const jid of Object.keys(update.presences)) {
                    if (update.presences[jid].lastKnownPresence === 'available') {
                        // Mark as read
                        await sock.readMessages([
                            {
                                remoteJid: 'status@broadcast',
                                id: update.id,
                                participant: jid
                            }
                        ]);
                        // Status ko dekha hua mark karna
                    }
                }
            }
        }
    });
}

// --- Express API Endpoints ---
app.use(express.static('./')); // index.html ko serve karne ke liye. (Yahi woh line hai jo file ko serve karti hai)
app.use(express.json());

// API to request a new session (QR/Pairing Code)
app.post('/start-session', async (req, res) => {
    const { sessionName } = req.body;
    
    if (!sessionName || sessionName.length < 3) {
        return res.status(400).json({ success: false, message: 'Invalid session name provided.' });
    }

    try {
        // startSession function will handle the response (QR/success/error)
        await startSession(sessionName, res);
    } catch (error) {
        console.error('Error starting session:', error);
        res.status(500).json({ success: false, message: 'Server error while starting session.' });
    }
});

// API to check status
app.get('/status/:sessionName', (req, res) => {
    const sessionName = req.params.sessionName;
    if (sessions.has(sessionName)) {
        res.status(200).json({ status: 'connected', sessionName });
    } else {
        res.status(200).json({ status: 'disconnected', sessionName });
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log('Use the web interface to link new users.');
    
    // Attempt to restart all existing sessions on boot (for robustness)
    const existingSessions = fs.readdirSync(SESSION_FOLDER).filter(f => fs.statSync(`${SESSION_FOLDER}/${f}`).isDirectory());
    console.log(`Found ${existingSessions.length} existing sessions. Restarting...`);
    
    // Server start hone par, yeh existing sessions ko restart karne ki koshish karta hai
    existingSessions.forEach(sessionName => {
        console.log(`Attempting to restart session: ${sessionName}`);
        startSession(sessionName, {
            status: () => ({ json: () => {} }),
            json: () => {},
            send: () => {}
        });
    });
});
        
