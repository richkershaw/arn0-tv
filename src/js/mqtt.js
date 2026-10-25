/*
 * Tiny MQTT 3.1.1 publisher over WebSockets, for reporting what is on the TV to Home Assistant.
 *
 * The launcher is the one thing that reliably knows which app is in front — it launched it — so
 * it publishes that here. Home Assistant's own Samsung integration cannot see the big streaming
 * apps on this TV (their status endpoint returns 404), which is why this exists.
 *
 * Publish-only and deliberately small: no subscribe, QoS 0, one connection. Home Assistant's
 * Mosquitto exposes plain MQTT-over-WebSockets on port 1884 (TLS on 8884). Configure it in
 * js/config.local.js:
 *
 *   mqtt: {
 *       url: 'ws://192.168.1.10:1884',    // your HA host, Mosquitto's WebSocket port
 *       username: 'tv', password: '…',    // an MQTT login (HA → Settings → add-ons → Mosquitto)
 *       topic: 'framey/launcher'          // optional; this is the default
 *   }
 *
 * With `discovery` left on, it announces itself so a sensor (sensor.framey_launcher) appears in
 * Home Assistant automatically. An MQTT Last Will marks it offline when the TV powers off.
 */
(function () {
    'use strict';

    var log = DevLog.log;
    var cfg = (window.LAUNCHER_CONFIG || {}).mqtt || {};
    var KEEPALIVE = 60;

    function configured() {
        return !!(cfg.url && cfg.username);
    }

    // ---- packet encoding

    function str(s) {
        s = String(s);
        var out = [(s.length >> 8) & 0xff, s.length & 0xff];
        for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
        return out;
    }

    function remainingLength(n) {
        var out = [];
        do {
            var b = n % 128;
            n = Math.floor(n / 128);
            if (n > 0) b |= 0x80;
            out.push(b);
        } while (n > 0);
        return out;
    }

    function packet(type, body) {
        return new Uint8Array([type].concat(remainingLength(body.length), body));
    }

    function connectPacket(opts) {
        var flags = 0x02;                       // clean session
        var payload = str(opts.clientId);
        if (opts.will) {
            flags |= 0x04 | (opts.will.retain ? 0x20 : 0);   // will, will-retain, QoS 0
            payload = payload.concat(str(opts.will.topic), str(opts.will.payload));
        }
        if (opts.username) { flags |= 0x80; payload = payload.concat(str(opts.username)); }
        if (opts.password) { flags |= 0x40; payload = payload.concat(str(opts.password)); }
        var variable = str('MQTT').concat([0x04, flags, (KEEPALIVE >> 8) & 0xff, KEEPALIVE & 0xff]);
        return packet(0x10, variable.concat(payload));
    }

    function publishPacket(topic, payload, retain) {
        var header = 0x30 | (retain ? 0x01 : 0);   // PUBLISH, QoS 0
        var body = str(topic);
        for (var i = 0; i < payload.length; i++) body.push(payload.charCodeAt(i) & 0xff);
        return packet(header, body);
    }

    // ---- client

    var ws = null;
    var connected = false;
    var pingTimer = null;
    var reconnectTimer = null;
    var queue = [];
    var last = null;              // last state, re-sent on reconnect

    function topic(suffix) {
        return (cfg.topic || 'framey/launcher') + '/' + suffix;
    }

    function clientId() {
        return 'arn0-launcher-' + Math.random().toString(16).slice(2, 8);
    }

    function send(bytes) {
        try {
            ws.send(bytes);
            return true;
        } catch (e) {
            return false;
        }
    }

    function discovery() {
        if (cfg.discovery === false) return;
        var base = cfg.topic || 'framey/launcher';
        var conf = {
            name: 'Framey launcher',
            unique_id: 'framey_launcher_app',
            state_topic: base + '/state',
            value_template: '{{ value_json.app }}',
            json_attributes_topic: base + '/state',
            availability_topic: base + '/availability',
            icon: 'mdi:television-play',
            device: {
                identifiers: ['framey_launcher'],
                name: 'Framey launcher',
                manufacturer: 'arn0-tv'
            }
        };
        // Retained, so Home Assistant recreates the sensor after a restart.
        send(publishPacket('homeassistant/sensor/framey_launcher/config', JSON.stringify(conf), true));
    }

    function flush() {
        discovery();
        send(publishPacket(topic('availability'), 'online', true));
        if (last) send(publishPacket(topic('state'), JSON.stringify(last), true));
        queue.forEach(function (m) { send(publishPacket(topic('state'), JSON.stringify(m), true)); });
        queue = [];
    }

    function onData(buf) {
        var type = new Uint8Array(buf)[0] & 0xf0;
        if (type === 0x20) {                 // CONNACK
            connected = true;
            log('MQTT connected');
            flush();
            pingTimer = setInterval(function () {
                send(new Uint8Array([0xc0, 0x00]));   // PINGREQ
            }, KEEPALIVE * 500);
        }
    }

    function connect() {
        if (!configured() || connected || ws) return;
        try {
            ws = new WebSocket(cfg.url, ['mqtt']);
        } catch (e) {
            log('MQTT: ' + DevLog.errorText(e));
            return;
        }
        ws.binaryType = 'arraybuffer';
        ws.onopen = function () {
            send(connectPacket({
                clientId: clientId(),
                username: cfg.username,
                password: cfg.password,
                will: { topic: topic('availability'), payload: 'offline', retain: true }
            }));
        };
        ws.onmessage = function (e) { onData(e.data); };
        ws.onclose = function () {
            connected = false;
            ws = null;
            clearInterval(pingTimer);
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 5000);
            }
        };
        ws.onerror = function () { /* onclose handles rettry */ };
    }

    // ---- public: report what is on

    function publishState(app, id) {
        last = { app: app, id: id || null };
        if (connected) send(publishPacket(topic('state'), JSON.stringify(last), true));
        else {
            queue = [last];        // only the latest matters
            connect();
        }
    }

    window.MQTT = {
        configured: configured,
        start: connect,
        reportApp: function (item) { publishState(item.label, item.id); },
        reportHome: function () { publishState('Home', null); },
        test: function () {
            if (!configured()) return Promise.reject(new Error('no mqtt.url/username in config.local.js'));
            connect();
            return new Promise(function (resolve, reject) {
                var tries = 0;
                var t = setInterval(function () {
                    if (connected) { clearInterval(t); resolve('connected to ' + cfg.url); }
                    else if (++tries > 10) { clearInterval(t); reject(new Error('no CONNACK from ' + cfg.url)); }
                }, 500);
            });
        }
    };
})();
