/*
 * Home screen content.
 *
 * apps: each entry picks the first installed app matching it:
 *   { id: 'org.tizen.netflix-app' }   exact app id (most reliable; see "All apps", the id of
 *                                     the focused app is shown at the bottom)
 *   { match: 'netflix' }              case-insensitive regex on id or name
 *   label                             optional display name
 *   brand                             optional key from js/brands.js (otherwise guessed from the name)
 * Entries that match nothing are skipped.
 *
 * inputs: HDMI ports shown in the second row. Set `hdmi` to the port each device is plugged into.
 */
window.LAUNCHER_CONFIG = {
    apps: [
        // Exact ids from this TV (Lab → "Send installed app list to log"; also shown bottom-left
        // in All apps). Pinned rather than matched by name because the TV also carries
        // "dummy" copies of Prime Video and Apple TV that a name match could pick.
        { id: '9Ur5IzDKqV.TizenYouTube', label: 'YouTube', brand: 'youtube' },
        { id: 'DqEoaplKlw.bbchybrid', label: 'BBC iPlayer', brand: 'iplayer' },
        { id: 'OCaxbgg9v6.chfourctv', label: 'Channel 4', brand: 'channel4' },
        { id: 'org.tizen.primevideo', label: 'Prime Video', brand: 'primevideo' },
        { id: 'MCmYXNxgcu.DisneyPlus', label: 'Disney+', brand: 'disneyplus' },
        { id: 'com.samsung.tv.aria-video', label: 'Apple TV', brand: 'appletv' },
        { id: '1Qb6IoAcGC.NowTV', label: 'NOW', brand: 'now' },
        { id: 'kIciSQlYEM.plex', label: 'Plex', brand: 'plex' }
    ],

    inputs: [
        { hdmi: 1, label: 'Nintendo Switch', brand: 'switch' },
        { hdmi: 3, label: 'PlayStation 5', brand: 'playstation' }
    ],

    // How an input tile switches the TV. See README "HDMI inputs".
    //   'switch+viewer'  set the TV source, then open Samsung's TV viewer (default)
    //   'switch'         only set the TV source
    //   'inapp'          show the input full screen inside the launcher (Back returns)
    inputMethod: 'switch+viewer',

    locale: 'en-GB',

    theme: {
        // Starting wallpaper (key from js/wallpapers.js), or null for none (plain gradient).
        // Changed from Settings → Background; the TV remembers the choice.
        wallpaper: null
    },

    /*
     * Weather shown in the screen saver's corner, from Open-Meteo. No API key and nothing to
     * keep secret, so this is the whole setup: put your own coordinates here (two decimals is
     * plenty, and is also about as precise as you want a public request to be). Leave them null
     * and the widget never appears.
     *
     * There is no Settings page for this on purpose — the TV does not move, and coordinates are
     * not something you type with a remote.
     */
    weather: {
        latitude: null,
        longitude: null,
        unit: 'celsius'         // 'celsius' | 'fahrenheit'
    },

    /*
     * EXPERIMENTAL navigation sound. Synthesised, so there is no audio file. `move` plays when
     * focus changes, `edge` when it cannot (the end of a row). Tune by ear in the browser
     * preview; `volume` is 0–1 and sits on top of the TV's own volume.
     *
     * Whether this is worth keeping depends on the TV's audio latency: run
     * "Sound: report audio latency" in the Lab screen. Set enabled to false to silence it.
     */
    sound: {
        enabled: true,
        preset: 'soft',
        volume: 0.08,
        minGapMs: 45,
        presets: {
            soft: { label: 'Soft', freq: 620, ms: 30, type: 'sine' },
            warm: { label: 'Warm', freq: 520, ms: 44, type: 'triangle' },
            bright: { label: 'Bright', freq: 1040, ms: 30, type: 'triangle' }
        },
        move: { freq: 880, ms: 38, type: 'triangle' },
        edge: { freq: 200, ms: 70, type: 'sine' },
        select: { freq: 1320, ms: 55, type: 'triangle' }
    },

    /*
     * Home Assistant scene buttons along the top of Home (js/ha.js). The url and token belong in
     * js/config.local.js, never here. With `label` set, every scene/script/button carrying that
     * label in HA is shown and `buttons` is ignored, so the list is edited in HA itself.
     */
    homeAssistant: {
        url: null,          // 'http://<ha-host>:8123'
        token: null,        // a long-lived access token (HA profile -> Security)
        sidebar: null       // the Lovelace dashboard url_path the left column reads, e.g. 'tv-sidebar'
    },

    /*
     * Report what is on the TV to Home Assistant over MQTT (js/mqtt.js). The launcher knows which
     * app it launched, which is the one reliable signal on this TV. url/username/password belong
     * in js/config.local.js. With discovery on, sensor.framey_launcher appears automatically.
     */
    mqtt: {
        url: null,              // 'ws://<ha-host>:1884'  (Mosquitto's WebSocket port)
        username: null,
        password: null,
        topic: 'framey/launcher',
        discovery: true
    },

    // Development only: where the Lab screen sends its logs (npm run devlog on your computer).
    // null disables it; set it to http://<your-computer-ip>:8099/log while debugging.
    devLogUrl: null
};

/*
 * Local overrides from js/config.local.js, which is gitignored and loaded just before this file.
 * That is where values specific to one TV belong — coordinates, a devlog address — so this file
 * can stay in the repository with nulls in it. Nothing to strip before a push, nothing to put
 * back before a build, and the overlay reaches the browser preview and the .wgt alike.
 *
 * Merged one level deep, so a local file can set weather.latitude without restating the rest of
 * the block. Arrays (apps, inputs) and plain values replace the default outright.
 */
(function () {
    'use strict';

    var local = window.LAUNCHER_LOCAL;
    if (!local) return;

    function plainObject(v) {
        return v && typeof v === 'object' && !Array.isArray(v);
    }

    Object.keys(local).forEach(function (key) {
        if (plainObject(local[key]) && plainObject(window.LAUNCHER_CONFIG[key])) {
            Object.keys(local[key]).forEach(function (inner) {
                window.LAUNCHER_CONFIG[key][inner] = local[key][inner];
            });
        } else {
            window.LAUNCHER_CONFIG[key] = local[key];
        }
    });
})();
