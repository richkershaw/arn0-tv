/*
 * Left-hand Home Assistant column.
 *
 * Source of truth is the Lovelace dashboard named in config.homeAssistant.sidebar. js/ha.js reads
 * its config (ordered cards + visibility) and streams live state; this file turns that into
 * TV-native tiles, evaluates visibility against live state and the clock, drives actions, and
 * keeps the clock alive. HA unreachable -> the column hides and the normal clock-over-tiles home
 * shows through.
 *
 * Structure: the clock is pinned; the cards below live in a scrolling track. State updates patch
 * the affected card in place (so a focused tile never loses its highlight or re-animates). Camera
 * frames are double-buffered (load the next frame off-screen, swap only when ready — no flicker).
 *
 * With no HA configured (the browser preview) it runs the MOCK dashboard below, the same shape
 * ha.js emits.
 */
(function () {
    'use strict';

    var $ = UI.$;
    var el = UI.el;
    var log = DevLog.log;

    function st(state, attrs) { return { state: state, attributes: attrs || {} }; }
    var MOCK_CONFIG = { views: [{ type: 'sections', sections: [
        { visibility: [{ condition: 'or', conditions: [
            { condition: 'time', after: '21:00:00' }, { condition: 'time', before: '06:00:00' }] }],
          cards: [
            { type: 'heading', heading: 'Evening' },
            { type: 'button', entity: 'scene.tv_mode', name: 'TV Mode' },
            { type: 'button', entity: 'scene.wind_down', name: 'Wind-Down' },
            { type: 'picture-entity', entity: 'camera.emmett_cam', name: "Emmett's room" },
            { type: 'tile', entity: 'input_number.home_comfort_temperature', name: 'Comfort temp' },
            { type: 'tile', entity: 'sensor.living_room_climate_sensor_temperature', name: 'Living room temp' },
            { type: 'tile', entity: 'input_text.dishwasher_state', name: 'Dishwasher' } ] },
        { visibility: [{ condition: 'time', after: '06:00:00', before: '21:00:00' }],
          cards: [
            { type: 'heading', heading: 'Lights' },
            { type: 'tile', entity: 'light.living_room', name: 'Living Room' },
            { type: 'tile', entity: 'light.kitchen', name: 'Kitchen' },
            { type: 'tile', entity: 'light.workshop', name: 'Workshop' },
            { type: 'picture-entity', entity: 'camera.doorbell', name: 'Doorbell' },
            { type: 'tile', entity: 'weather.pirateweather', name: 'Weather' } ] }
    ] }] };
    var MOCK_STATES = {
        'scene.tv_mode': st('scening'), 'scene.wind_down': st('scening'),
        'camera.emmett_cam': st('idle'), 'camera.doorbell': st('idle'),
        'input_number.home_comfort_temperature': st('21', { min: 15, max: 25, step: 0.5, unit_of_measurement: '°C' }),
        'sensor.living_room_climate_sensor_temperature': st('19.6', { unit_of_measurement: '°C' }),
        'input_text.dishwasher_state': st('Running · 42 min left'),
        'light.living_room': st('on', { brightness: 180 }), 'light.kitchen': st('off'),
        'light.workshop': st('off'),
        'weather.pirateweather': st('partlycloudy', { temperature: 12 })
    };

    var cards = [];        // normalised
    var states = {};
    var online = false;
    var haveConfig = false, haveStates = false;
    var cardEls = {};      // entity -> [box]
    var camImgs = [];      // in-column camera <img>
    var camOverlay = null; // { img, base } when the pop-over is open
    var lastSig = '';

    function configured() { return window.HA && HA.configured(); }
    function getState(e) { return states[e] || null; }

    // ---- normalise ----
    function kindFor(card) {
        if (card.type === 'heading') return 'heading';
        var e = card.entity || (card.entities && card.entities[0]) || '';
        var dom = String(e).split('.')[0];
        if (dom === 'light') return 'light';
        if (dom === 'switch' || dom === 'fan' || dom === 'input_boolean') return 'switch';
        if (dom === 'scene' || dom === 'script' || dom === 'button' || dom === 'input_button') return 'button';
        if (dom === 'number' || dom === 'input_number') return 'number';
        if (dom === 'climate') return 'climate';
        if (dom === 'camera') return 'camera';
        if (dom === 'weather') return 'weather';
        return 'sensor';
    }
    function normalise(config) {
        var out = [];
        var view = (config && config.views && config.views[0]) || {};
        var groups = view.sections || [{ cards: view.cards || [], visibility: view.visibility }];
        groups.forEach(function (sec) {
            var sv = sec.visibility || null;
            (sec.cards || []).forEach(function (card) {
                if (card.type === 'heading') { out.push({ kind: 'heading', name: card.heading || '', sv: sv }); return; }
                var e = card.entity || (card.entities && card.entities[0]) || null;
                if (!e) return;
                out.push({ kind: kindFor(card), entity: e, name: card.name || null,
                    tap_action: card.tap_action || null, sv: sv, cv: card.visibility || null });
            });
        });
        return out;
    }

    // ---- visibility ----
    function secs(t) { var p = String(t).split(':'); return (+p[0]) * 3600 + (+(p[1] || 0)) * 60 + (+(p[2] || 0)); }
    function timePass(c) {
        var now = new Date(), cur = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(), pass = true;
        if (c.after != null && c.before != null) {
            pass = secs(c.after) > secs(c.before) ? (cur >= secs(c.after) || cur < secs(c.before))
                                                  : (cur >= secs(c.after) && cur < secs(c.before));
        } else if (c.after != null) { pass = cur >= secs(c.after); }
        else if (c.before != null) { pass = cur < secs(c.before); }
        if (c.weekdays) { var wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()]; if (c.weekdays.indexOf(wd) < 0) pass = false; }
        return pass;
    }
    function condPass(c) {
        if (!c) return true;
        switch (c.condition) {
            case 'and': return (c.conditions || []).every(condPass);
            case 'or': return (c.conditions || []).some(condPass);
            case 'not': return !(c.conditions || []).some(condPass);
            case 'time': return timePass(c);
            case 'state': {
                var s = getState(c.entity || c.entity_id), v = s ? s.state : null;
                if (c.state != null) return Array.isArray(c.state) ? c.state.indexOf(v) >= 0 : v === String(c.state);
                if (c.state_not != null) return Array.isArray(c.state_not) ? c.state_not.indexOf(v) < 0 : v !== String(c.state_not);
                return true;
            }
            case 'numeric_state': {
                var s2 = getState(c.entity || c.entity_id), n = s2 ? parseFloat(s2.state) : NaN;
                if (isNaN(n)) return false;
                if (c.above != null && !(n > parseFloat(c.above))) return false;
                if (c.below != null && !(n < parseFloat(c.below))) return false;
                return true;
            }
            case 'sun': {
                var sun = getState('sun.sun'); if (!sun) return true;
                if (c.after === 'sunset' || c.before === 'sunrise') return sun.state === 'below_horizon';
                if (c.after === 'sunrise' || c.before === 'sunset') return sun.state === 'above_horizon';
                return true;
            }
            default: return true;
        }
    }
    function visible(card) {
        var vis = [];
        if (card.sv) vis = vis.concat(card.sv);
        if (card.cv) vis = vis.concat(card.cv);
        return vis.every(condPass);
    }
    function visSig() {
        return cards.filter(function (c) { return (c.kind === 'heading' || c.entity) && visible(c); })
            .map(function (c) { return c.kind + ':' + (c.entity || c.name); }).join('|');
    }

    // ---- formatting ----
    function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
    function fmt(v) { return Math.round(v * 10) / 10; }

    // ---- renderers (HA state shape) ----
    function shell(card, focusable) {
        var box = el('div', 'ha-card ha-' + card.kind);
        if (focusable) box.classList.add('ha-focusable');
        box._card = card;
        if (card.name) box.appendChild(el('div', 'ha-name', card.name));
        return box;
    }
    function value(box, text, cls) { box.appendChild(el('div', 'ha-value' + (cls ? ' ' + cls : ''), text)); }
    function pill(box, on) { box.appendChild(el('div', 'ha-pill' + (on ? ' on' : ''), on ? 'On' : 'Off')); }
    function stepper(box, text) {
        var row = el('div', 'ha-stepper');
        row.appendChild(el('span', 'ha-step ha-down', '−'));
        row.appendChild(el('span', 'ha-value', text));
        row.appendChild(el('span', 'ha-step ha-up', '+'));
        box.appendChild(row);
    }
    function unavail(box) { value(box, 'unavailable', 'muted'); }

    function renderHeading(card) { return el('div', 'ha-head', card.name); }
    function renderLight(card) {
        var s = getState(card.entity), b = shell(card, true);
        if (!s) { unavail(b); return b; }
        var on = s.state === 'on'; pill(b, on);
        if (on && s.attributes.brightness != null) b.appendChild(el('div', 'ha-sub', Math.round(s.attributes.brightness / 255 * 100) + '%'));
        return b;
    }
    function renderSwitch(card) {
        var s = getState(card.entity), b = shell(card, true);
        if (!s) { unavail(b); return b; } pill(b, s.state === 'on'); return b;
    }
    function renderButton(card) { var b = shell(card, true); b.appendChild(el('div', 'ha-press', 'Press')); return b; }
    function renderNumber(card) {
        var s = getState(card.entity), b = shell(card, true);
        if (!s) { unavail(b); return b; }
        stepper(b, (num(s.state) != null ? fmt(num(s.state)) : s.state) + (s.attributes.unit_of_measurement || ''));
        return b;
    }
    function renderClimate(card) {
        var s = getState(card.entity), b = shell(card, true);
        if (!s) { unavail(b); return b; }
        stepper(b, (s.attributes.temperature != null ? fmt(s.attributes.temperature) + '°' : '—'));
        var cur = s.attributes.current_temperature;
        b.appendChild(el('div', 'ha-sub', (cur != null ? 'now ' + fmt(cur) + '° · ' : '') + cap(s.state)));
        return b;
    }
    function renderSensor(card) {
        var s = getState(card.entity), b = shell(card, true);
        if (!s) { unavail(b); return b; }
        var u = s.attributes.unit_of_measurement || '';
        value(b, (num(s.state) != null ? fmt(num(s.state)) : s.state) + (u ? ' ' + u : ''));
        return b;
    }
    function renderWeather(card) {
        var s = getState(card.entity), b = shell(card, true);
        if (!s) { unavail(b); return b; }
        value(b, (s.attributes.temperature != null ? fmt(s.attributes.temperature) + '°' : '—'));
        b.appendChild(el('div', 'ha-sub', cap(String(s.state).replace(/[-_]/g, ' '))));
        return b;
    }
    function camUrl(s) { return s && window.HA && HA.entityPicture ? HA.entityPicture(s) : null; }
    function bust(url) { return url + (url.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(); }
    function renderCamera(card) {
        var s = getState(card.entity), b = shell(card, true);
        var frame = el('div', 'ha-cam'), url = camUrl(s);
        if (url) {
            var img = new Image(); img.className = 'ha-cam-img'; img._base = url; img.src = bust(url);
            frame.appendChild(img); camImgs.push(img);
        } else if (s) { frame.classList.add('ha-cam-live'); }
        else { frame.appendChild(el('div', 'ha-cam-off', 'camera unavailable')); }
        b.appendChild(frame);
        return b;
    }
    var RENDER = { heading: renderHeading, light: renderLight, switch: renderSwitch, button: renderButton,
        number: renderNumber, climate: renderClimate, sensor: renderSensor, weather: renderWeather, camera: renderCamera };
    function buildCard(card) { return (RENDER[card.kind] || renderSensor)(card); }

    // ---- clock ----
    function tickClock() {
        var col = $('sidebar'); if (!col) return;
        var t = col.querySelector('.ha-clock-time'); if (!t) return;
        var now = new Date(), ct = Appearance.time(now);
        t.textContent = ct.time + (ct.suffix || '');
        var d = col.querySelector('.ha-clock-date'); if (d) d.textContent = Appearance.date(now);
    }
    function clockCard() { var b = el('div', 'ha-card ha-clock'); b.appendChild(el('div', 'ha-clock-time')); b.appendChild(el('div', 'ha-clock-date')); return b; }

    // ---- full render (structure) ----
    function render() {
        var col = $('sidebar'); if (!col || !online) return;
        camImgs = []; cardEls = {};
        col.innerHTML = '';
        col.appendChild(clockCard());
        var scroll = el('div', 'ha-scroll'), track = el('div', 'ha-track');
        scroll.appendChild(track); col.appendChild(scroll);
        cards.forEach(function (card) {
            if (card.kind !== 'heading' && !card.entity) return;
            if (!visible(card)) return;
            var box = buildCard(card);
            track.appendChild(box);
            if (card.entity) (cardEls[card.entity] = cardEls[card.entity] || []).push(box);
        });
        lastSig = visSig();
        tickClock();
        alignApps();
        if (window.Home && Home.reSidebarFocus) Home.reSidebarFocus();
    }

    // ---- in-place patch (no focus jump) ----
    function updateCameraBox(box) {
        var s = getState(box._card.entity), img = box.querySelector('.ha-cam-img'), url = camUrl(s);
        if (img && url) img._base = url;          // next refresh uses the new token; current frame stays
        else render();                            // gained/lost a frame -> structure changed
    }
    function updateBox(box) {
        if (box._card.kind === 'camera') { updateCameraBox(box); return; }
        var fresh = buildCard(box._card), focused = box.classList.contains('focused');
        box.className = fresh.className + (focused ? ' focused' : '');
        box.innerHTML = fresh.innerHTML;
    }
    function refresh(entity) {
        if (!online) return;
        if (visSig() !== lastSig) { render(); return; }      // visibility/structure changed
        if (entity && cardEls[entity]) cardEls[entity].forEach(updateBox);
    }

    // ---- scrolling ----
    function ensureVisible(box) {
        var track = box && box.parentNode;
        if (!track || !track.classList.contains('ha-track')) return;
        var port = track.parentNode, size = port.clientHeight, M = 10;
        var start = box.offsetTop, len = box.offsetHeight, pos = track._pos || 0;
        if (start - M < pos) pos = start - M;
        else if (start + len + M > pos + size) pos = start + len + M - size;
        if (pos < 0) pos = 0;
        if (pos !== track._pos) { track._pos = pos; track.style.transform = 'translateY(' + (-pos) + 'px)'; }
    }

    function alignApps() {
        if (!window.Home || !Home.setAppsTop) return;
        var col = $('sidebar'), stage = $('stage');
        var card = col && col.querySelector('.ha-head, .ha-card:not(.ha-clock)');
        if (!card || !stage) { Home.setAppsTop(null); return; }
        var sr = stage.getBoundingClientRect(), cr = card.getBoundingClientRect();
        var scale = (sr.height / 1080) || 1;
        Home.setAppsTop(Math.round((cr.top - sr.top) / scale));
    }

    // ---- actions ----
    function serviceFromAction(a, entity) {
        var name = a.perform_action || a.service;
        if (!name || name.indexOf('.') < 0) return null;
        var p = name.split('.'), target = (a.target && a.target.entity_id) || entity;
        return window.HA ? HA.callService(p[0], p[1], target, a.data) : null;
    }
    function activate(box) {
        var c = box._card, e = c.entity, dom = e.split('.')[0], p;
        if (c.tap_action && (c.tap_action.action === 'perform-action' || c.tap_action.action === 'call-service')) {
            p = serviceFromAction(c.tap_action, e);
        } else if (c.kind === 'light' || c.kind === 'switch') { p = HA.callService(dom, 'toggle', e); }
        else if (c.kind === 'button') {
            if (dom === 'scene') p = HA.callService('scene', 'turn_on', e);
            else if (dom === 'script') p = HA.callService('script', 'turn_on', e);
            else p = HA.callService(dom, 'press', e);
        } else { return; }
        if (p) p.then(null, function (err) { UI.toast('HA: ' + DevLog.errorText(err)); });
        box.classList.add('ha-busy'); setTimeout(function () { box.classList.remove('ha-busy'); }, 250);
    }
    function adjust(box, dir) {
        var c = box._card, s = getState(c.entity); if (!s) return;
        if (c.kind === 'number') {
            var step = num(s.attributes.step) || 1, nv = (num(s.state) || 0) + dir * step;
            if (s.attributes.min != null) nv = Math.max(num(s.attributes.min), nv);
            if (s.attributes.max != null) nv = Math.min(num(s.attributes.max), nv);
            nv = Math.round(nv / step) * step;
            s.state = String(nv); refresh(c.entity);
            HA.callService(c.entity.split('.')[0], 'set_value', c.entity, { value: nv }).then(null, function (err) { UI.toast('HA: ' + DevLog.errorText(err)); });
        } else if (c.kind === 'climate') {
            var cstep = num(s.attributes.target_temp_step) || 0.5, nt = (num(s.attributes.temperature) || 0) + dir * cstep;
            s.attributes.temperature = nt; refresh(c.entity);
            HA.callService('climate', 'set_temperature', c.entity, { temperature: nt }).then(null, function (err) { UI.toast('HA: ' + DevLog.errorText(err)); });
        }
    }

    // ---- camera pop-over ----
    function labelOf(entity) { for (var i = 0; i < cards.length; i++) if (cards[i].entity === entity) return cards[i].name || entity; return entity; }
    function ensureOverlay() {
        var ov = $('cam-overlay');
        if (ov) return ov;
        ov = el('div', 'cam-overlay hidden'); ov.id = 'cam-overlay';
        var box = el('div', 'cam-box');
        box.appendChild(el('div', 'cam-title'));
        var img = new Image(); img.className = 'cam-big'; box.appendChild(img);
        box.appendChild(el('div', 'cam-none', 'camera unavailable'));
        box.appendChild(el('div', 'cam-hint', 'Back to close'));
        ov.appendChild(box);
        $('stage').appendChild(ov);
        return ov;
    }
    function openCamera(entity) {
        var ov = ensureOverlay(), s = getState(entity), url = camUrl(s);
        ov.querySelector('.cam-title').textContent = labelOf(entity);
        var img = ov.querySelector('.cam-big'), none = ov.querySelector('.cam-none');
        if (url) { img.style.display = ''; none.style.display = 'none'; img.src = bust(url); camOverlay = { img: img, base: url }; }
        else { img.style.display = 'none'; none.style.display = ''; camOverlay = null; }
        ov.classList.remove('hidden');
    }
    function closeCamera() { var ov = $('cam-overlay'); if (ov) ov.classList.add('hidden'); camOverlay = null; }

    // ---- camera frame refresh (double-buffered: no flicker) ----
    function swap(img, base) { var n = new Image(); n.onload = function () { img.src = n.src; }; n.src = bust(base); }
    function refreshCameras() {
        if (!online) return;
        camImgs.forEach(function (img) { if (img._base) swap(img, img._base); });
        if (camOverlay && camOverlay.base) swap(camOverlay.img, camOverlay.base);
    }

    // ---- online/offline ----
    function applyMode() {
        var home = $('home'), col = $('sidebar');
        if (home) home.classList.toggle('has-sidebar', online);
        if (col) col.style.display = online ? '' : 'none';
        if (online) render();
        else {
            if (window.Home && Home.setAppsTop) Home.setAppsTop(null);
            if (window.Home && Home.sidebarGone) Home.sidebarGone();
            closeCamera();
        }
    }
    function setOnline(v) { if (v === online) return; online = v; applyMode(); }
    function maybeOnline() { if (haveConfig && haveStates) setOnline(true); }

    function init() {
        var home = $('home'); if (!home) return;
        if (!$('sidebar')) { var aside = el('aside'); aside.id = 'sidebar'; home.insertBefore(aside, home.firstChild); }

        setInterval(function () { if (online && visSig() !== lastSig) render(); }, 30000);  // day/night flip
        setInterval(refreshCameras, 4000);
        setInterval(tickClock, 10000);

        if (configured()) {
            HA.connect({
                onConfig: function (cfg) { cards = normalise(cfg); haveConfig = true; maybeOnline(); if (online) render(); },
                onStates: function (map) { states = map; haveStates = true; maybeOnline(); if (online) render(); },
                onChange: function (entity, s) { if (s) states[entity] = s; else delete states[entity]; refresh(entity); },
                onStatus: function (up) { if (!up) setOnline(false); }
            });
            return;
        }
        var down = location.hash.indexOf('ha-down') >= 0;
        cards = normalise(MOCK_CONFIG); states = MOCK_STATES;
        haveConfig = haveStates = true;
        setOnline(!down);
    }

    window.Sidebar = {
        init: init,
        setOffline: function (off) { setOnline(!off); },
        rows: function () { var t = $('sidebar') && $('sidebar').querySelector('.ha-track'); return t ? UI.children(t).filter(function (c) { return c.classList.contains('ha-focusable'); }) : []; },
        ensureVisible: ensureVisible,
        activate: activate,
        adjust: adjust,
        openCamera: openCamera,
        closeCamera: closeCamera,
        isStepper: function (box) { return box && box._card && (box._card.kind === 'number' || box._card.kind === 'climate'); },
        isCamera: function (box) { return box && box._card && box._card.kind === 'camera'; }
    };
})();
