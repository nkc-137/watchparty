# Publishing to the Chrome Web Store

Goal: let friends install the extension with one click instead of loading an
unpacked folder. For a friends-only tool, publish as **Unlisted** (installable
via a link, not shown in search).

## What's already prepped in the repo

- Icons at `icons/icon{16,48,128}.png`, wired into `manifest.json`.
- Unused `tabs` permission removed (fewer permissions = easier review).
- `npm run package` builds and produces `watchparty-extension.zip` (the upload).

Regenerate the zip anytime with:

```bash
cd extension
npm run package    # -> watchparty-extension.zip
```

---

## One-time setup

1. Go to the **Chrome Web Store Developer Dashboard**:
   https://chrome.google.com/webstore/devconsole
2. Sign in with a Google account and pay the **one-time $5 registration fee**.

---

## Create the listing

1. Click **Add new item**, upload `watchparty-extension.zip`.
2. Fill in the store listing:
   - **Description** — what it does (sync + chat for Netflix/Prime; requires
     your own self-hosted server).
   - **Category** — Entertainment.
   - **Language** — English.
   - **Screenshots** — at least one **1280×800** or **640×400** PNG/JPEG. Take a
     screenshot of the overlay on a title (the panel expanded over the video).
   - **Store icon** — the 128×128 is picked up from the package.
3. **Privacy** tab (this is where most reviews get held up — fill it carefully):
   - **Single purpose**: "Synchronize video playback position and relay chat
     between friends watching the same title, via a user-provided server."
   - **Permission justifications**:
     - `storage` — save the user's server URL / room / display settings.
     - host permissions (`netflix.com`, `primevideo.com`, `amazon.com/gp/video`)
       — read and control the video player on those sites to keep playback in
       sync and show the chat overlay.
   - **Remote code**: No (all code is bundled in the package).
   - **Data usage**: the extension does not collect or sell user data; it sends
     playback timing and chat text to the server the user configures. Check the
     boxes accordingly.
   - **Privacy policy URL** — required. See below.
4. **Visibility**: choose **Unlisted** (anyone with the link can install;
   not searchable). Change to Public later if you want.
5. **Submit for review**. Review typically takes a few hours to a few days.
   Broad host permissions can add scrutiny; the single-purpose + justifications
   above are what reviewers look for.

---

## Privacy policy (required)

You need a public URL. Since you don't have a domain, host it free on a GitHub
Gist or GitHub Pages. Minimal text that fits this extension:

> **Watch Party — Privacy Policy**
> This extension does not collect, store, or sell personal data. It reads and
> controls the video player on Netflix and Amazon Prime Video only to
> synchronize playback with other participants. Playback timing and any chat
> messages you type are sent only to the server URL you configure, which you or
> the party host operate. No data is sent to the developer or any third party.
> Settings (server URL, room, display preferences) are stored locally in your
> browser via the extension storage API.

Paste that into a public Gist (https://gist.github.com), click "Raw", and use
that URL as the privacy policy link.

---

## Sharing with friends

After approval you get a Chrome Web Store URL like
`https://chromewebstore.google.com/detail/<id>`. Send friends that link — they
click **Add to Chrome** and they're done. They still open the popup, **Paste
invite**, and Join as before.

## Publishing updates

1. Bump `"version"` in `manifest.json` (e.g. `0.2.0` -> `0.2.1`).
2. `npm run package`.
3. In the dashboard, open the item -> **Package** -> upload the new zip ->
   submit. Installed users auto-update within a day or so.

## Notes

- The extension has **no hardcoded server** — each user points it at their own
  party server, so publishing it publicly exposes no infrastructure of yours.
- Keep the server's `JOIN_SECRET` set; the public listing doesn't change your
  room security model.
