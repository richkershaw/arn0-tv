// Lists every app installed on the TV with the id its REST API and Home Assistant understand.
//
//   node scripts/tv-apps.mjs <tv-ip>
//
// Uses the TV's own remote-control WebSocket (wss://<tv>:8002), so the first run shows an
// "allow this device?" prompt on the TV: accept it with the remote. The token the TV hands back
// is saved to scripts/.tv-token (gitignored) so later runs do not prompt. No dependencies.
//
// Some models (The Frame among them) accept the connection but never answer the app-list
// request. After 10 s the script falls back to the list the launcher itself saw: run Lab →
// "Send installed app list to log" with `npm run devlog` going, then this script reads
// logs/tv.jsonl and checks each app id against the TV's REST API. `--from-log` skips the
// WebSocket attempt entirely.
import tls from 'node:tls';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const fromLog = args.includes('--from-log');
const tv = args.find((a) => !a.startsWith('--'));
if (!tv) {
    console.error('usage: node scripts/tv-apps.mjs <tv-ip>');
    process.exit(2);
}
const tokenFile = resolve(import.meta.dirname, '.tv-token');
let token = '';
try { token = readFileSync(tokenFile, 'utf8').trim(); } catch {}

const name = Buffer.from('arn0-tv-apps').toString('base64');
const path = `/api/v2/channels/samsung.remote.control?name=${name}` + (token ? `&token=${token}` : '');

function restStatus(id) {
    return new Promise((ok) => {
        const req = http.get({ host: tv, port: 8001, path: `/api/v2/applications/${id}`, timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { ok(JSON.parse(body)); } catch { ok(null); } });
        });
        req.on('error', () => ok(null));
        req.on('timeout', () => { req.destroy(); ok(null); });
    });
}

function printList(apps) {
    console.log(`${'ID'.padEnd(34)} ${'RUN'.padEnd(5)} ${'VIS'.padEnd(5)} NAME`);
    const list = {};
    return apps.reduce((p, app) => p.then(async () => {
        const st = await restStatus(app.appId);
        const yn = (v) => (st && st.id ? (v ? 'yes' : 'no') : '-');
        console.log(`${String(app.appId).padEnd(34)} ${yn(st && st.running).padEnd(5)} ${yn(st && st.visible).padEnd(5)} ${app.name}`);
        if (st && st.id) list[app.name] = app.appId;
    }), Promise.resolve()).then(() => {
        const n = Object.keys(list).length;
        console.log(`\n${n} of ${apps.length} answer on the REST API ('-' = the TV did not recognise that id).`);
        console.log('Home Assistant app_list (SamsungTV Smart):\n' + JSON.stringify(list, null, 2));
    });
}

// Store apps and the few preloaded consumer apps from the launcher's own app dump.
function fallbackFromLog() {
    const file = resolve(import.meta.dirname, '..', 'logs', 'tv.jsonl');
    if (!existsSync(file)) {
        console.error('No logs/tv.jsonl. Run `npm run devlog`, then on the TV: Lab → "Send installed app list to log".');
        process.exit(1);
    }
    const dumps = readFileSync(file, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && /^apps: /.test(e.message) && Array.isArray(e.data));
    if (!dumps.length) {
        console.error('logs/tv.jsonl has no app dump yet. On the TV: Lab → "Send installed app list to log".');
        process.exit(1);
    }
    const apps = dumps.pop().data
        .filter((a) => a.consumer)
        .map((a) => ({ appId: a.id, name: a.name.split(/\s+[-:|–]\s+/)[0].trim() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    console.error(`Checking ${apps.length} apps from the launcher's last app dump…`);
    printList(apps).then(() => process.exit(0));
}

if (fromLog) {
    fallbackFromLog();
} else {
    connect();
}

function connect() {
const sock = tls.connect({ host: tv, port: 8002, rejectUnauthorized: false, servername: '' });
const key = crypto.randomBytes(16).toString('base64');
let buf = Buffer.alloc(0);
let upgraded = false;
let message = [];

let timer = setTimeout(() => {
    console.error('No answer from the TV in 45 s. Is it on, and did you accept the prompt?');
    process.exit(1);
}, 45000);

function send(obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    let head;
    if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
    else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    sock.write(Buffer.concat([head, mask, masked]));
}

function frames() {
    for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const data = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, 0x80 | data.length]), Buffer.alloc(4), data])); continue; }
        if (op === 8) { console.error('The TV closed the connection.'); process.exit(1); }
        message.push(data);
        if (fin) { const text = Buffer.concat(message).toString('utf8'); message = []; onMessage(text); }
    }
}

async function onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.event === 'ms.channel.unauthorized') {
        console.error('The TV refused. Allow this computer: Settings → General → External Device Manager → Device Connection Manager.');
        process.exit(1);
    }
    if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token && msg.data.token !== token) {
            writeFileSync(tokenFile, String(msg.data.token));
            console.error('Saved the TV token to scripts/.tv-token');
        }
        send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
        clearTimeout(timer);
        timer = setTimeout(() => {
            console.error('The TV accepted the connection but did not send its app list (normal on The Frame).');
            sock.destroy();
            fallbackFromLog();
        }, 10000);
        return;
    }
    if (msg.event === 'ed.installedApp.get') {
        clearTimeout(timer);
        const apps = ((msg.data && msg.data.data) || []).sort((a, b) => a.name.localeCompare(b.name));
        sock.end();
        await printList(apps);
        process.exit(0);
    }
}

sock.on('secureConnect', () => {
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${tv}:8002\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    console.error('Connected. If the TV shows an "allow" prompt, accept it with the remote…');
});
sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        if (!/^HTTP\/1\.1 101/.test(head)) { console.error('Upgrade refused:\n' + head); process.exit(1); }
        upgraded = true;
        buf = buf.subarray(end + 4);
    }
    frames();
});
sock.on('error', (e) => { console.error('Connection failed: ' + e.message); process.exit(1); });
}
