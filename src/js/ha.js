/*
 * Home Assistant client: one authenticated WebSocket for the dashboard config and live state,
 * plus REST for actions and camera frames. Used by js/sidebar.js.
 *
 * Config (js/config.local.js):
 *   homeAssistant: { url: 'http://192.168.1.10:8123', token: 'eyJ…', sidebar: 'tv-sidebar' }
 *
 * The sidebar is read from the Lovelace dashboard named by `sidebar` (its url_path), so what the
 * TV shows is managed entirely in Home Assistant's dashboard editor.
 */
(function () {
    'use strict';

    var log = DevLog.log;
    var cfg = (window.LAUNCHER_CONFIG || {}).homeAssistant || {};

    function configured() { return !!(cfg.url && cfg.token); }
    function base() { return (cfg.url || '').replace(/\/+$/, ''); }
    function wsUrl() { return base().replace(/^http/, 'ws') + '/api/websocket'; }

    // ---- REST ----
    function request(method, path, body) {
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest();
            x.open(method, base() + path);
            x.timeout = 8000;
            x.setRequestHeader('Authorization', 'Bearer ' + cfg.token);
            x.setRequestHeader('Content-Type', 'application/json');
            x.onload = function () {
                if (x.status >= 200 && x.status < 300) resolve(x.responseText);
                else if (x.status === 401) reject(new Error('token rejected (401)'));
                else reject(new Error('HTTP ' + x.status));
            };
            x.onerror = function () { reject(new Error('cannot reach ' + base())); };
            x.ontimeout = function () { reject(new Error('timed out')); };
            x.send(body ? JSON.stringify(body) : null);
        });
    }

    function callService(domain, service, entityId, data) {
        var payload = {};
        if (data) { for (var k in data) if (data.hasOwnProperty(k)) payload[k] = data[k]; }
        if (entityId) payload.entity_id = entityId;
        return request('POST', '/api/services/' + domain + '/' + service, payload);
    }

    // A camera's current frame URL (token rotates inside the state, so this follows updates).
    function entityPicture(state) {
        if (!state || !state.attributes || !state.attributes.entity_picture) return null;
        return base() + state.attributes.entity_picture;
    }

    // ---- WebSocket ----
    var ws = null, msgId = 1, connected = false, reconnectT = null;
    var handlers = {}, subId = null, cfgId = null, lovelaceSubId = null;

    function nextId() { return msgId++; }
    function sendWS(o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }

    function afterAuth() {
        connected = true;
        log('HA connected');
        if (handlers.onStatus) handlers.onStatus(true);
        // Dashboard config (WebSocket-only).
        cfgId = nextId();
        sendWS({ id: cfgId, type: 'lovelace/config', url_path: cfg.sidebar || null });
        // Initial states over REST, then subscribe to deltas.
        request('GET', '/api/states').then(function (text) {
            var arr = JSON.parse(text), map = {};
            arr.forEach(function (s) { map[s.entity_id] = s; });
            if (handlers.onStates) handlers.onStates(map);
        }).catch(function (e) { log('HA get_states: ' + DevLog.errorText(e)); });
        subId = nextId();
        sendWS({ id: subId, type: 'subscribe_events', event_type: 'state_changed' });
        // Hot-reload the dashboard when it is edited in HA.
        lovelaceSubId = nextId();
        sendWS({ id: lovelaceSubId, type: 'subscribe_events', event_type: 'lovelace_updated' });
    }
    function refetchConfig() {
        cfgId = nextId();
        sendWS({ id: cfgId, type: 'lovelace/config', url_path: cfg.sidebar || null });
    }

    function onMessage(raw) {
        var m;
        try { m = JSON.parse(raw); } catch (e) { return; }
        if (m.type === 'auth_required') { sendWS({ type: 'auth', access_token: cfg.token }); return; }
        if (m.type === 'auth_invalid') { log('HA auth rejected'); try { ws.close(); } catch (e) {} return; }
        if (m.type === 'auth_ok') { afterAuth(); return; }
        if (m.type === 'result' && m.id === cfgId) {
            if (m.success && m.result && handlers.onConfig) handlers.onConfig(m.result);
            else if (!m.success) log('HA dashboard "' + (cfg.sidebar || '') + '" not readable');
            return;
        }
        if (m.type === 'event' && m.id === lovelaceSubId && m.event) {
            var d = m.event.data || {};
            if ((d.url_path || null) === (cfg.sidebar || null)) { log('HA dashboard changed; reloading config'); refetchConfig(); }
            return;
        }
        if (m.type === 'event' && m.id === subId && m.event && m.event.data) {
            if (handlers.onChange) handlers.onChange(m.event.data.entity_id, m.event.data.new_state);
        }
    }

    function scheduleReconnect() {
        if (reconnectT) return;
        reconnectT = setTimeout(function () { reconnectT = null; connect(handlers); }, 5000);
    }

    function connect(h) {
        if (!configured() || ws) return;
        handlers = h || handlers || {};
        try { ws = new WebSocket(wsUrl()); }
        catch (e) { log('HA WS: ' + DevLog.errorText(e)); scheduleReconnect(); return; }
        ws.onmessage = function (e) { onMessage(e.data); };
        ws.onclose = function () {
            connected = false; ws = null;
            if (handlers.onStatus) handlers.onStatus(false);
            scheduleReconnect();
        };
        ws.onerror = function () { /* onclose handles reconnect */ };
    }

    function test() {
        if (!configured()) return Promise.reject(new Error('no url/token in config.local.js'));
        return request('GET', '/api/').then(function (t) { log('HA REST: ' + t); return t; });
    }

    window.HA = {
        configured: configured,
        base: base,
        request: request,
        callService: callService,
        entityPicture: entityPicture,
        connect: connect,
        isConnected: function () { return connected; },
        test: test,
        dashboardPath: function () { return cfg.sidebar || null; }
    };
})();
