# Blocking Samsung ads and tracking with Pi-hole

Nothing here touches the TV itself; it is all DNS, so every step is undone by removing the entry.
Add the entries in Pi-hole → **Domains → Deny (regex)**, and give them a group that only the TV's
IP is in (Pi-hole → Clients/Groups), so phones and laptops are not affected.

Test after each tier: Smart Hub opens, apps launch and play (Netflix, iPlayer, YouTube), Art Mode
still shows your art, and the app store still installs updates. If something breaks, look in the
Pi-hole query log, filtered to the TV, for what was blocked at the moment it failed.

## Tier 1: ads, ACR and telemetry (safe)

ACR (automatic content recognition) is what watches the picture to report what you are viewing.

```
(\.|^)samsungads\.com$
(\.|^)samsungacr\.com$
(\.|^)samsungadhub\.com$
(\.|^)adgrx\.com$
(\.|^)samsungrm\.net$
^events\.samsungads\.com$
```

## Tier 2: Smart Hub promotions and notices (probably safe)

```
^(notice|noticecdn|noticefile)\.samsungcloudsolution\.com$
^(acr0|musicid)\.samsungcloudsolution\.com$
^api-hub\.samsungyosemite\.com$
```

`samsungyosemite.com` serves the Smart Hub content rows. Blocking it should empty those rows, but
it may also stop Samsung TV Plus, so leave it out if you use TV Plus.

## Tier 3: optional, and each one costs something

| Domain | What blocking it costs |
|--------|------------------------|
| `(\.|^)samsungotn\.net$` | **Firmware updates.** This freezes the firmware, which keeps a Home-button change from being undone by an update, but it also stops security fixes. Decide on purpose. |
| `(\.|^)samsungcloudsolution\.(com\|net)$` (wildcard) | Too broad: the app store, Samsung account, time sync and probably Art Store all live here. Use the specific hosts above instead. |

## Do not block

- `samsungqbe.com`: core Smart TV functions.
- `samsungosp.com`: Samsung account sign-in (needed for the Art Store and SmartThings, which your
  Home Assistant integration uses).
- `*.nflxso.net`, `*.nflxvideo.net`: Netflix playback.

## Also switch off on the TV

Settings → General → Terms & Privacy (wording varies by firmware):

- Viewing Information Services: off (this is ACR).
- Interest-Based Advertisement: off.
- Voice Recognition Services: off, if you do not use Bixby or voice.
- Settings → General → Smart Features: Autorun Smart Hub off.

Sources: [hkamran80's smart-TV blocklist](https://gist.github.com/hkamran80/779019103fcd306979411d44c8d38459),
[LazyAdmin: how to block ads on your smart TV](https://lazyadmin.nl/home-network/how-to-block-ads-on-your-smart-tv/).
