/*
 * Home Assistant: scene buttons on Home.
 *
 * Talks to Home Assistant's REST API with a long-lived access token (Profile → Security →
 * Long-lived access tokens). Put the URL and token in js/config.local.js, which is gitignored:
 *
 *   window.LAUNCHER_LOCAL = {
 *       homeAssistant: {
 *           url: 'http://192.168.1.10:8123',
 *           token: 'eyJ…',
 *           label: 'tv_launcher'      // optional: show everything with this HA label
 *       }
 *   };
 *
 * Which buttons appear, in order of preference:
 *   1. `label` set: every scene/script/button entity carrying that label in Home Assistant, so the
 *      list is edited in HA (Settings → Labels) rather than by rebuilding the app.
 *   2. otherwise `buttons` from config.js: [{ entity: 'scene.tv_mode', label: 'TV Mode' }].
 * The last list fetched is cached, so the row draws instantly and survives HA being down.
 *
 * Pressing one calls the domain's own action: scene/script → turn_on, button/input_button →
 * press, automation → trigger.
 */
(function () {
    'use strict';

    var CACHE_KEY = 'arn0.ha.buttons.v1';
    var TIMEOUT_MS = 6000;
    var log = DevLog.log;

    var cfg = (window.LAUNCHER_CONFIG || {}).homeAssistant || {};
    var listeners = [];
    var buttons = readCache() || staticButtons();

    var ACTIONS = {
        scene: 'turn_on',
        script: 'turn_on',
        button: 'press',
        input_button: 'press',
        automation: 'trigger'
    };

    function configured() {
        return !!(cfg.url && cfg.token);
    }

    // Preview with nothing configured: show a few pretend buttons so the layout can be judged.
    function demo() {
        return !!window.__TIZEN_MOCK__ && !configured();
    }

    function staticButtons() {
        if (demo()) {
            return [
                { entity: 'scene.tv_mode', label: 'TV Mode' },
                { entity: 'scene.living_room_on', label: 'Lights on' },
                { entity: 'scene.living_room_off', label: 'Lights off' }
            ];
        }
        return (cfg.buttons || []).filter(function (b) { return b && b.entity; });
    }

    function readCache() {
        try {
            var list = JSON.parse(localStorage.getItem(CACHE_KEY));
            return Array.isArray(list) ? list : null;
        } catch (e) {
            return null;
        }
    }

    function writeCache(list) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(list));
        } catch (e) {
            // Only costs the instant first draw.
        }
    }

    function request(method, path, body) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, cfg.url.replace(/\/+$/, '') + path);
            xhr.timeout = TIMEOUT_MS;
            xhr.setRequestHeader('Authorization', 'Bearer ' + cfg.token);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
                else if (xhr.status === 401) reject(new Error('token rejected (401)'));
                else if (xhr.status === 500) {
                    // HA ran the action but something in it failed, typically one offline device
                    // in a scene. The rest has already been applied.
                    var e = new Error('ran, but Home Assistant reported an error (see its logs)');
                    e.partial = true;
                    reject(e);
                }
                else reject(new Error('HTTP ' + xhr.status));
            };
            xhr.onerror = function () { reject(new Error('cannot reach ' + cfg.url)); };
            xhr.ontimeout = function () { reject(new Error('timed out')); };
            xhr.send(body ? JSON.stringify(body) : null);
        });
    }

    // Entities with the label, with their friendly names, in one round trip via the template API.
    function fetchLabelled() {
        var tpl = "{% set ns = namespace(out=[]) %}" +
            "{% for e in label_entities('" + String(cfg.label).replace(/'/g, '') + "') | sort %}" +
            "{% if e.split('.')[0] in ['scene','script','button','input_button','automation'] %}" +
            "{% set ns.out = ns.out + [{'entity': e, 'label': state_attr(e, 'friendly_name') or e}] %}" +
            "{% endif %}{% endfor %}{{ ns.out | tojson }}";
        return request('POST', '/api/template', { template: tpl }).then(function (text) {
            var list = JSON.parse(text);
            if (!Array.isArray(list)) throw new Error('unexpected template result');
            return list;
        });
    }

    function sameList(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    function setButtons(list) {
        if (sameList(list, buttons)) return;
        buttons = list;
        writeCache(list);
        listeners.forEach(function (fn) { fn(); });
    }

    function refresh() {
        if (!configured()) {
            setButtons(staticButtons());
            return Promise.resolve(buttons);
        }
        if (!cfg.label) {
            setButtons(staticButtons());
            return Promise.resolve(buttons);
        }
        return fetchLabelled().then(function (list) {
            setButtons(list);
            return list;
        }, function (err) {
            log('Home Assistant buttons: ' + DevLog.errorText(err));
            throw err;
        });
    }

    function activate(button) {
        var domain = button.entity.split('.')[0];
        var action = ACTIONS[domain];
        if (!action) return Promise.reject(new Error('unsupported entity ' + button.entity));
        if (demo()) {
            log('[preview] ' + domain + '.' + action + ' ' + button.entity);
            return Promise.resolve();
        }
        if (!configured()) return Promise.reject(new Error('Home Assistant is not configured'));
        return request('POST', '/api/services/' + domain + '/' + action, { entity_id: button.entity });
    }

    function test() {
        if (!configured()) {
            log('Home Assistant: no url/token in config.local.js');
            return Promise.reject(new Error('not configured'));
        }
        return request('GET', '/api/').then(function (text) {
            log('Home Assistant: ' + text);
            return refresh().then(function (list) {
                log('Home Assistant buttons: ' + list.map(function (b) { return b.entity; }).join(', '));
            });
        });
    }

    window.HA = {
        configured: configured,
        buttons: function () { return buttons; },
        refresh: refresh,
        activate: activate,
        onChange: function (fn) { listeners.push(fn); },
        actions: function () {
            return [{
                label: 'Home Assistant: test connection and reload buttons',
                run: function () {
                    test().then(function () { UI.toast('Home Assistant OK'); }, function (err) {
                        UI.toast('Home Assistant: ' + DevLog.errorText(err));
                    });
                }
            }];
        }
    };
})();
