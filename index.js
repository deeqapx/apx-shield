/**
 * APX-SHIELD V5.7 - THE ABSOLUTE SENTINEL
 * Fixed: Participant Split Error, Deprecated QR Warning, Duplicate Messages
 * Features: All 16 Rules + Edited Message Monitoring
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    getContentType
} = require("@whiskeysockets/baileys");
const { Telegraf } = require('telegraf');
const pino = require("pino");
const fs = require('fs-extra');

const CONFIG = {
    TG_TOKEN: '8513129567:AAG68GcUgYhLtgsbY503n9g6QaNK_Vtt7_o',
    DB_FILE: './database/shield_db.json',
    FOOTER: "\n~ Powered by Apexium Team",
    PROMOTION_THRESHOLD: 500
};

const bot = new Telegraf(CONFIG.TG_TOKEN);
const sessions = new Map();
const floodTracker = new Map();
const onlineStatus = new Set();
let adminChatId;

const db = {
    read: () => { try { return fs.readJsonSync(CONFIG.DB_FILE); } catch { return { users: {} }; } },
    save: (data) => fs.writeJsonSync(CONFIG.DB_FILE, data, { spaces: 2 })
};

async function startShield(phoneNumber) {
    if (sessions.has(phoneNumber)) {
        const oldSock = sessions.get(phoneNumber);
        oldSock.ev.removeAllListeners();
        try { oldSock.end(); } catch (e) {}
        sessions.delete(phoneNumber);
    }

    const sessionDir = `./sessions/${phoneNumber}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "110.0.5481.177"]
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            let code = await sock.requestPairingCode(phoneNumber);
            if (adminChatId) bot.telegram.sendMessage(adminChatId, `🔑 *Pairing Code:* \`${code}\``);
        }, 3000);
    }

    sessions.set(phoneNumber, sock);
    sock.ev.on('creds.update', saveCreds);

    const monitor = async (m) => {
        const msg = m.messages ? m.messages[0] : m;
        if (!msg || !msg.key || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const user = sender.split('@')[0];

        let content = msg.message;
        const type = getContentType(content);
        if (type === 'protocolMessage') content = content.protocolMessage?.editedMessage;
        else if (type === 'editedMessage') content = content.editedMessage?.message;
        if (!content) return;

        const body = (content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || "").toLowerCase();
        const mentionedJids = content.extendedTextMessage?.contextInfo?.mentionedJid || [];

        // 16. STATUS MENTION PROHIBITION
        if (jid === 'status@broadcast') {
            const groups = await sock.groupFetchAllParticipating();
            if (mentionedJids.some(r => Object.keys(groups).includes(r)) || body.includes('chat.whatsapp.com')) {
                for (let gJid in groups) {
                    await sock.sendMessage(gJid, { text: `❌ @${user} was removed due to status mention violations.` + CONFIG.FOOTER, mentions: [sender] });
                    await sock.groupParticipantsUpdate(gJid, [sender], "remove");
                }
            }
            return;
        }

        if (!jid.endsWith('@g.us')) return;
        const meta = await sock.groupMetadata(jid);
        const isAdmin = meta.participants.find(p => p.id === sender)?.admin;

        // 12. ADMIN COMMANDS
        if (body === '/rules') {
            return await sock.sendMessage(jid, { text: `📌 *Group Rules Reminder*\n• No spam or unauthorized promotions\n• Be respectful to all members\n• Stay on topic\n• Violations lead to removal` + CONFIG.FOOTER });
        }

        // 14. ADMIN PROTECTION
        if (isAdmin) return;

        // 8. ANTI-SPAM & 16. MENTION CONTROL
        const hasLink = body.match(/https?:\/\/\S+/gi);
        const hasMention = body.includes('@') || mentionedJids.length > 0;

        if (hasMention) {
            await sock.sendMessage(jid, { delete: msg.key });
            await sock.sendMessage(jid, { text: `❌ @${user} was removed due to repeated mention violations.` + CONFIG.FOOTER, mentions: [sender] });
            return await sock.groupParticipantsUpdate(jid, [sender], "remove");
        }

        if (hasLink) {
            await sock.sendMessage(jid, { delete: msg.key });
            return await handleViolation(sock, jid, sender, user, "Unauthorized Link");
        }

        // 9. FLOOD CONTROL
        const now = Date.now();
        const logs = floodTracker.get(sender) || [];
        const recent = logs.filter(t => now - t < 5000);
        recent.push(now);
        floodTracker.set(sender, recent);
        if (recent.length > 5) {
            return await sock.sendMessage(jid, { text: `⏳ @${user}, you are sending messages too quickly. Please slow down.` + CONFIG.FOOTER, mentions: [sender] });
        }

        // 13 & 6. FIRST MSG & ENGAGEMENT
        let data = db.read();
        if (!data.users[sender]) {
            data.users[sender] = { strikes: 0, msgs: 0 };
            await sock.sendMessage(jid, { text: `Hi @${user} 👋\nWelcome once again. Feel free to briefly introduce yourself.` + CONFIG.FOOTER, mentions: [sender] });
        }
        data.users[sender].msgs++;
        if (data.users[sender].msgs === CONFIG.PROMOTION_THRESHOLD) {
            await sock.sendMessage(jid, { text: `🎉 Congratulations @${user}\nPromoted to Group Admin for your meaningful contribution.` + CONFIG.FOOTER, mentions: [sender] });
            await sock.groupParticipantsUpdate(jid, [sender], "promote");
        }
        db.save(data);
    };

    sock.ev.on('messages.upsert', monitor);
    // CHECK EDITED MESSAGES (Rule 8/16)
    sock.ev.on('messages.update', async (u) => { for (const update of u) if (update.update.message) await monitor(update.update); });

    // 1 & 2. WELCOME & EXIT (Fixed p.split error)
    sock.ev.on('group-participants.update', async (ev) => {
        const { id, participants, action } = ev;
        const gMeta = await sock.groupMetadata(id);
        for (let p of participants) {
            const pId = typeof p === 'string' ? p : p.id;
            const u = pId.split('@')[0];
            if (action === 'add') {
                await sock.sendMessage(id, { text: `Welcome @${u} 👋\nYou’re now part of ${gMeta.subject}.\nPlease review the group rules.` + CONFIG.FOOTER, mentions: [pId] });
            } else if (action === 'remove') {
                await sock.sendMessage(id, { text: `@${u} has left the group.\nWe wish them all the best.` + CONFIG.FOOTER, mentions: [pId] });
            }
        }
    });

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (connection === 'close') {
            onlineStatus.delete(phoneNumber);
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut && sessions.has(phoneNumber)) startShield(phoneNumber);
        }
        if (connection === 'open') {
            if (!onlineStatus.has(phoneNumber)) {
                bot.telegram.sendMessage(adminChatId, `🛡️ *SHIELD ONLINE:* ${phoneNumber}`);
                onlineStatus.add(phoneNumber);
            }
        }
    });
}

async function handleViolation(sock, jid, sender, user, reason) {
    let data = db.read();
    if (!data.users[sender]) data.users[sender] = { strikes: 0, msgs: 0 };
    data.users[sender].strikes++;
    const s = data.users[sender].strikes;

    if (s === 1) await sock.sendMessage(jid, { text: `⚠️ @${user}, this message violates group rules (Rule: ${reason}).` + CONFIG.FOOTER, mentions: [sender] });
    else if (s === 2) await sock.sendMessage(jid, { text: `🚨 Final warning @${user}. Any further violation results in removal.` + CONFIG.FOOTER, mentions: [sender] });
    else {
        await sock.sendMessage(jid, { text: `❌ Member removed for repeated rule violations.` + CONFIG.FOOTER });
        await sock.groupParticipantsUpdate(jid, [sender], "remove");
        data.users[sender].strikes = 0;
    }
    db.save(data);
}

bot.on('text', async (ctx) => {
    adminChatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    if (text.toUpperCase().startsWith('ST ')) {
        const num = text.split(' ')[1].replace(/\D/g, '');
        if (sessions.has(num)) {
            sessions.get(num).ev.removeAllListeners();
            try { sessions.get(num).end(); } catch (e) {}
            sessions.delete(num);
            onlineStatus.delete(num);
            return ctx.reply(`✖️ Shield Deactivated for ${num}`);
        }
    }
    const cleanNumber = text.replace(/\D/g, '');
    if (cleanNumber.length > 5) {
        ctx.reply(`🚀 Deploying Shield: ${cleanNumber}...`);
        startShield(cleanNumber);
    }
});

bot.launch();

