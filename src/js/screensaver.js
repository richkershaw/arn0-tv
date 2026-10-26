/*
 * Screen saver: photos with a slow zoom, a clock and a caption, after a stretch with no input
 * on Home. Any key closes it, and that press does nothing else.
 *
 * Adapted from a design mockup rather than ported from it. The mockup's backdrop was nine
 * radial-gradients over a linear-gradient — the exact shape the Lab render probe measured at
 * 4.6 fps with 88 of 90 frames dropped (see the header of css/style.css). Here a photo fills
 * that role, the one gradient left is static and painted once, and everything that moves does
 * so through `transform` and `opacity`, which the compositor animates with no JavaScript per
 * frame. The poll below ticks once a second and only decides what is due.
 *
 * Burn-in is the reason anything moves at all: on this kind of panel a clock parked in one
 * corner for an hour is a real risk, so the zoom never settles, the corner text shifts on each
 * photo change, the clock moves to another corner every couple of minutes, and the whole thing
 * fades to black once the configured hour is up.
 */
(function () {
    'use strict';

    var $ = UI.$;

    var DELAYS = [
        { key: '3m', label: '3 min', ms: 3 * 60 * 1000 },
        { key: '5m', label: '5 min', ms: 5 * 60 * 1000 },
        { key: '10m', label: '10 min', ms: 10 * 60 * 1000 },
        { key: '15m', label: '15 min', ms: 15 * 60 * 1000 }
    ];

    // The design asks for a photo change every 60-90 s; these are the ends and the middle.
    var PHOTO_EVERY = [
        { key: '60s', label: '60 s', ms: 60 * 1000 },
        { key: '75s', label: '75 s', ms: 75 * 1000 },
        { key: '90s', label: '90 s', ms: 90 * 1000 }
    ];

    var DARK_AFTER = [
        { key: '30m', label: '30 min', ms: 30 * 60 * 1000 },
        { key: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
        { key: '2h', label: '2 hours', ms: 2 * 60 * 60 * 1000 },
        { key: 'never', label: 'Never', ms: 0 }
    ];

    /*
     * The photo drifts rather than zooms. A zoom changes the layer's raster scale, and this
     * engine re-rasterises a scaled 1920x1080 layer in visible steps instead of compositing it
     * smoothly — the first version of this did zoom, and on the TV it stepped badly. A translate
     * leaves the raster alone and only changes the transform matrix, which is the one thing the
     * compositor is certain to do per frame. The layer is laid out larger than the screen so
     * there is something to drift into, and panning also beats zooming for burn-in: a zoom from
     * the centre leaves the middle of the picture almost stationary.
     */
    var PAN_X = 160;                // overhang each side, matching .ss-photo in the stylesheet
    var PAN_Y = 90;
    var HELD_LEG_MS = 90 * 1000;    // one leg of the drift when a single photo is held
    var CLOCK_MOVE_MS = 150 * 1000; // "every 2-3 minutes"
    var CLOCK_POSITIONS = 4;        // .ss-clock.pos-0 .. pos-3
    var NUDGES = [[0, 0], [7, -5], [-6, 6], [4, 8]];
    var FADE_MS = 2000;             // crossfade, also set as the default in the stylesheet
    var POLL_MS = 1000;

    var open = false;
    var returnTo = 'home';
    var lastInput = Date.now();
    var layers = [];
    var front = 0;              // which of the two photo layers is showing
    var photoToken = 0;
    var photoIndex = 0;
    var openedAt = 0;
    var nextPhotoAt = 0;
    var nextClockMoveAt = 0;
    var nextPanAt = 0;
    var panSign = 1;            // flipped on each leg, so the drift alternates direction
    var nudge = 0;
    var lastClockText = '';
    var clockPos = 0;
    var dark = false;

    // Screen-saver photos come from an HA media folder, replacing the bundled set here only
    // (the Home background still uses js/wallpaper.js). Bundled photos remain the offline fallback.
    var WP_ROOT = 'media-source://media_source/local/wallpapers';
    var haPhotos = [];              // [{id,title}] enumerated from HA media
    var dashCfg = null;             // the idle dashboard (tv-idle) config, shown in the sidebar slot
    var dashTimer = null;
    // Stand-in used in desktop preview, where there is no HA backend to read tv-idle from.
    var SS_MOCK_DASH = { views: [{ sections: [{ cards: [
        { type: 'heading', heading: 'Overnight' },
        { type: 'picture-entity', entity: 'camera.doorbell' },
        { type: 'tile', entity: 'weather.pirateweather' },
        { type: 'tile', entity: 'sensor.living_room_climate_sensor_temperature' }
    ] }] }] };

    function prefs() { return Prefs.get().screensaver; }

    function option(list, key, fallback) {
        return list.find(function (o) { return o.key === key; }) ||
            list.find(function (o) { return o.key === fallback; });
    }

    function delay() { return option(DELAYS, prefs().delay, '5m'); }
    function photoEvery() { return option(PHOTO_EVERY, prefs().photoEvery, '75s'); }
    function darkAfter() { return option(DARK_AFTER, prefs().dark, '1h'); }

    // ---------- Photos

    function isHa() { return haPhotos.length > 0; }
    function photos() { return isHa() ? haPhotos : Wallpaper.list(); }
    function cleanTitle(t) { return (t || '').replace(/\.[a-z0-9]+$/i, ''); }

    // Enumerate the HA wallpaper folder; images only. Leaves the bundled fallback in place on failure.
    function loadHaPhotos() {
        if (!window.HA || !HA.browseMedia || !HA.isConnected || !HA.isConnected()) return;
        HA.browseMedia(WP_ROOT).then(function (res) {
            var kids = (res && res.children) || [];
            haPhotos = kids.filter(function (c) { return !c.can_expand && /^image\//.test(c.media_content_type || ''); })
                           .map(function (c) { return { id: c.media_content_id, title: cleanTitle(c.title) }; });
            DevLog.log('Screen saver: ' + haPhotos.length + ' HA wallpapers');
        }, function (e) { DevLog.log('Screen saver wallpapers: ' + DevLog.errorText(e)); });
    }

    function rotating() {
        if (isHa()) return haPhotos.length > 1;
        return Prefs.get().wallpaper.mode === 'rotate' && Wallpaper.list().length > 1;
    }

    /*
     * With HA photos present they are the set and the saver rotates them. Falling back to the
     * bundled set, the photo follows the Background setting: Off shows none, Photo holds one,
     * Rotate cycles. Prefs.wallpaper is read, never written — advancing must not disturb Home.
     */
    function photoAt(i) {
        var list = photos();
        if (!list.length) return null;
        if (isHa()) return list[((i % list.length) + list.length) % list.length];
        var p = Prefs.get().wallpaper;
        if (p.mode === 'off') return null;
        if (p.mode !== 'rotate') return Wallpaper.find(p.photo);
        return list[((i % list.length) + list.length) % list.length];
    }

    function startIndex() {
        if (isHa()) return 0;
        var key = Prefs.get().wallpaper.photo;
        var i = Wallpaper.list().findIndex(function (w) { return w.key === key; });
        return i < 0 ? 0 : i;
    }

    // How long one leg of the drift lasts: a rotating photo drifts for exactly as long as it is up.
    function legMs() {
        return rotating() ? photoEvery().ms : HELD_LEG_MS;
    }

    function corner(sign) {
        return 'translate(' + (sign * PAN_X) + 'px, ' + (sign * PAN_Y) + 'px)';
    }

    /*
     * Place a layer at the start of its drift with no animation. The suppression has to be
     * inline rather than a class, because startPan sets `transition` inline and an inline
     * declaration beats a class rule.
     */
    function resetPan(layer, sign) {
        layer.style.transition = 'none';
        layer.style.transform = corner(sign);
        // Reading a layout property flushes that, so the transition startPan restores runs from
        // this corner instead of being collapsed into the move away from it.
        void layer.offsetWidth;
    }

    /*
     * The drift is one CSS transition per leg: set once, run by the compositor, no JavaScript
     * per frame. Successive photos drift in opposite directions so the picture is not always
     * sliding the same way.
     */
    function startPan() {
        panSign = -panSign;
        nextPanAt = Date.now() + legMs();
        var layer = layers[front];
        layer.style.transition = 'opacity ' + FADE_MS + 'ms linear, transform ' + legMs() + 'ms linear';
        layer.style.transform = corner(panSign);
    }

    /*
     * The incoming photo is decoded on the hidden layer before anything fades, so a slow decode
     * cannot show as a flash of empty background. A token abandons a decode that finishes after
     * the next change, or after the screen saver has closed.
     */
    function showPhoto(w) {
        var token = ++photoToken;
        if (!w) {
            layers[0].style.opacity = '0';
            layers[1].style.opacity = '0';
            nextPanAt = 0;
            return;
        }
        if (w.id) {   // HA media: resolve to a signed URL first, then decode-before-swap
            HA.resolveMedia(w.id).then(function (r) { paintPhoto(token, r.url); },
                function (e) { DevLog.log('Screen saver resolve failed: ' + DevLog.errorText(e)); });
        } else {
            paintPhoto(token, w.file);
        }
    }
    // The incoming photo is decoded on the hidden layer before anything fades, so a slow decode
    // cannot show as a flash of empty background. A token abandons a decode that finishes late.
    function paintPhoto(token, url) {
        var swapped = false;
        var swap = function () {
            if (swapped || token !== photoToken || !open) return;
            swapped = true;
            var back = layers[1 - front];
            var old = layers[front];
            back.style.backgroundImage = 'url("' + url + '")';
            resetPan(back, panSign);
            front = 1 - front;
            startPan();
            back.style.opacity = '1';
            old.style.opacity = '0';
        };
        var img = new Image();
        img.onload = swap;
        img.onerror = function () { DevLog.log('Screen saver photo failed: ' + url); };
        img.src = url;
        if (img.complete && img.naturalWidth) swap();
    }

    // ---------- Text

    // The design asks for "Wed 21 Oct"; Appearance.date is the long form Home uses.
    function shortDate(d) {
        try {
            var text = d.toLocaleDateString(Prefs.get().appearance.locale,
                { weekday: 'short', day: 'numeric', month: 'short' });
            return text.charAt(0).toUpperCase() + text.slice(1);
        } catch (e) {
            return d.toDateString();
        }
    }

    // Called every second, but only writes when the minute turns: repainting the clock text on
    // top of a drifting photo is work the compositor does not need.
    function updateClock() {
        var d = new Date();
        var t = Appearance.time(d);
        var text = t.time + (t.suffix || '');
        if (text === lastClockText) return;
        lastClockText = text;
        $('ss-time').textContent = text;
        $('ss-date').textContent = Appearance.date(d);
    }

    function caption(w) {
        $('ss-title').textContent = w ? w.title : '';
        $('ss-caption').classList.toggle('hidden', !w || dashShown());
    }

    // A few pixels on each photo change, so even the text that stays put does not stay put.
    function nudgeText() {
        nudge = (nudge + 1) % NUDGES.length;
        var shift = 'translate(' + NUDGES[nudge][0] + 'px, ' + NUDGES[nudge][1] + 'px)';
        $('ss-caption').style.transform = shift;
    }

    // Swaps the position class without touching the others, which now include `with-weather`.
    function setClockPos(n) {
        var el = $('ss-clock');
        for (var i = 0; i < CLOCK_POSITIONS; i++) el.classList.remove('pos-' + i);
        el.classList.add('pos-' + n);
    }

    function moveClock() {
        clockPos = (clockPos + 1) % CLOCK_POSITIONS;
        setClockPos(clockPos);
        nextClockMoveAt = Date.now() + CLOCK_MOVE_MS;
    }

    // Hidden outright when there is no usable reading: see the note on staleness in weather.js.
    function renderWeather() {
        var w = window.Weather && Weather.current();
        $('ss-clock').classList.toggle('with-weather', !!w);
        $('ss-weather').classList.toggle('hidden', !w);
        if (!w) return;
        $('ss-wx-icon').innerHTML = w.icon;
        $('ss-wx-temp').textContent = w.temp;
        $('ss-wx-detail').textContent = w.detail;
    }

    // ---------- Idle dashboard panel

    function dashShown() { return !!(dashCfg && window.Sidebar && Sidebar.panelRender); }

    function loadDashConfig() {
        if (window.HA && HA.configured && HA.configured()) {
            if (!HA.dashboardConfig) return;
            HA.dashboardConfig((HA.idlePath && HA.idlePath()) || 'tv-idle').then(function (c) {
                dashCfg = c; if (open) renderDash();
            }, function (e) { DevLog.log('Idle dashboard: ' + DevLog.errorText(e)); });
        } else {
            dashCfg = SS_MOCK_DASH;   // desktop preview
        }
    }

    function renderDash() {
        var host = $('ss-dash'); if (!host) return;
        if (!dashShown()) { host.classList.add('hidden'); host.innerHTML = ''; return; }
        var track = Sidebar.panelRender(dashCfg);
        host.innerHTML = '';
        host.appendChild(track);
        host.classList.remove('hidden');
        $('ss-caption').classList.add('hidden');   // the dashboard replaces the photo credit
    }

    // ---------- Open, tick, close

    function openSaver() {
        if (open) return;
        returnTo = UI.current() || 'home';
        open = true;
        dark = false;
        front = 0;
        nudge = 0;
        clockPos = 0;
        photoIndex = startIndex();
        panSign = 1;
        lastClockText = '';
        layers[0].style.opacity = '0';
        layers[1].style.opacity = '0';
        resetPan(layers[0], panSign);
        resetPan(layers[1], panSign);
        $('ss-dark').style.opacity = '0';
        $('ss-caption').style.transform = '';

        var now = Date.now();
        openedAt = now;
        nextPhotoAt = now + photoEvery().ms;
        nextClockMoveAt = now + CLOCK_MOVE_MS;
        nextPanAt = 0;

        UI.show('screensaver');
        updateClock();
        loadHaPhotos();
        loadDashConfig();
        renderDash();
        if (dashTimer) clearInterval(dashTimer);
        dashTimer = setInterval(function () { if (open && dashShown()) renderDash(); }, 12000);

        var w = photoAt(photoIndex);
        caption(w);
        showPhoto(w);
        DevLog.log('Screen saver on');
    }

    function goDark() {
        dark = true;
        $('ss-dark').style.opacity = '1';
        DevLog.log('Screen saver dark after ' + darkAfter().label);
    }

    function tick() {
        var now = Date.now();
        updateClock();
        var until = darkAfter().ms;
        if (!dark && until && now - openedAt >= until) goDark();
        // Behind an opaque black layer there is nothing worth moving.
        if (dark) return;
        if (rotating() && now >= nextPhotoAt) {
            photoIndex++;
            nextPhotoAt = now + photoEvery().ms;
            var w = photoAt(photoIndex);
            caption(w);
            nudgeText();
            showPhoto(w);
        } else if (nextPanAt && now >= nextPanAt) {
            // A held photo has reached the far corner; send it back the other way.
            startPan();
        }
    }

    function close() {
        if (!open) return;
        open = false;
        lastInput = Date.now();
        photoToken++;
        if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
        var dash = $('ss-dash'); if (dash) { dash.innerHTML = ''; dash.classList.add('hidden'); }
        // Dropping the images releases two full-screen textures on a 2 GB device.
        layers.forEach(function (l) {
            l.style.opacity = '0';
            l.style.backgroundImage = '';
        });
        UI.show(returnTo, { back: true });
    }

    // Never over a console input or another screen, and never while the app is in the background.
    function eligible() {
        return prefs().enabled && UI.isVisible('home') && !document.hidden &&
            !(window.Home && Home.tvMode());
    }

    /*
     * One poll for everything. The dismissing key is swallowed by the view's onKey below, so it
     * only closes the screen saver; this listener exists to notice input while it is closed.
     */
    document.addEventListener('keydown', function () {
        if (!open) lastInput = Date.now();
    });

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            if (open) close();
            return;
        }
        // Coming back from another app is not idle time: JavaScript was paused, not waiting.
        lastInput = Date.now();
    });

    function init() {
        layers = [$('ss-photo-a'), $('ss-photo-b')];
        UI.register('screensaver', {
            el: $('screensaver'),
            hints: [],
            rows: function () { return []; },
            onKey: function () { close(); return true; },
            onBack: function () { close(); return true; }
        });
        loadHaPhotos();
        loadDashConfig();
        setInterval(function () {
            if (open) {
                tick();
                return;
            }
            if (eligible() && Date.now() - lastInput >= delay().ms) openSaver();
        }, POLL_MS);
    }

    window.Screensaver = {
        DELAYS: DELAYS,
        PHOTO_EVERY: PHOTO_EVERY,
        DARK_AFTER: DARK_AFTER,
        delay: delay,
        photoEvery: photoEvery,
        darkAfter: darkAfter,
        init: init,
        open: openSaver,
        close: close,
        isOpen: function () { return open; },
        // Settings should not leave a countdown that started before the change.
        poke: function () { lastInput = Date.now(); }
    };
})();
