# PROGRESS

Project: TANIM ER WIFE - Discord bot + admin dashboard (TYRONEX PRODUCTION)

Files: `index.js` (server), `public/index.html` (dashboard), `package.json`, `.env.example`, `PROGRESS.md`. This is the final stage (6B): the project is complete.

## Status (FINAL)
- Stage 1: DONE
- Stage 2A: DONE
- Stage 2B: DONE
- Stage 3: DONE
- Stage 4A: DONE
- Stage 4B: DONE
- Stage 5A: DONE
- Stage 5B: DONE
- Stage 6A: DONE
- Stage 6B: DONE

"DONE" means: implemented, and tested here against stand-ins for discord.js / Express / ws / multer / cron / voice (npm packages and Discord cannot be reached from the build environment). Nothing has been run against live Discord, a real voice connection, real AI keys, real co-admin accounts or Render. See "Stage 6B - Final audit" at the end for the exact lists.

## Stage 1 - Live chat improvements: DONE

### 1. Message delete
- Every message has a **Delete** button. A confirmation dialog shows the message before anything is deleted.
- Server: `DELETE /api/guilds/:gid/channels/:cid/messages/:mid`. With **Manage Messages** the bot deletes any message. Without it, only its own. Anything else returns a clear 403.
- Live: the server broadcasts `messageDelete` (from the delete call and from Discord's `messageDelete` / `messageDeleteBulk` events). Every open dashboard removes the message at once.
- The button is greyed out, with a tooltip, when the bot is not allowed to delete that message.

### 2. Message reply
- Every message has a **Reply** button. A "Replying to" bar appears above the input, with an **X** (Esc also cancels).
- Sent as a real Discord reply (`message_reference`). The replied-to user is not pinged.
- Each reply shows a snippet of the original (author, text, or "Attachment"). Click it to jump to the original.
- If the original was deleted or cannot be read, the reply shows "The original message was deleted or is unavailable". If it is deleted while you are replying, the reply bar is cleared. If it is gone at send time, the message is sent as a normal message and you are told.

### 3. Emoji reactions
- Emoji picker (common emojis + this server's custom emojis, with search). Quick buttons for the old checkmark / cross are kept.
- Reaction chips show emoji + count. If the bot already reacted, the chip is highlighted and **clicking it removes the bot's reaction**. Clicking a chip the bot has not used adds it.
- Server: `POST` adds, `DELETE ...?emoji=` removes (only the bot's own reaction). Duplicates are refused, double clicks are ignored, the 20-reaction limit and missing permissions give clear messages.
- Live: new intent `GuildMessageReactions` (not privileged) plus partials Reaction/User. On every reaction add / remove / remove-all / remove-emoji event the server re-reads the message and broadcasts the exact state (`reactions`).

### 4. Channel permissions
- Channel list shows a green check when the bot has View Channel + Send Messages, otherwise a red cross.
- Sending is disabled (text box, attach, send) in unavailable channels with a short reason above the box. Hidden channels explain why messages cannot be shown.
- Server-side: sending, reading, deleting and reacting all re-check permissions (`chanPerms`). Uploading also needs Attach Files. The UI is not trusted.
- The list refreshes on Reload and automatically when Discord reports a channel, role or bot-member permission change (`perms` event).

### 5. File preview
- After choosing files, each one gets a preview (image or video thumbnail, otherwise an icon) with name and size, plus **Replace** and **Remove** buttons.
- Remove clears the file completely (list entry, object URL and the input value). Existing upload / send behaviour is kept: up to 10 files, 25 MB each.

### Other small changes
- `/` also serves `index.html` from next to `index.js` if there is no `public/` folder.
- Common Discord error codes are turned into readable messages in every API route.
- After a dropped websocket reconnects, the open channel reloads so nothing stays out of date.

### Checks
- `node --check index.js`: OK
- Syntax check of the script inside `index.html`: OK
- Browser smoke test of the dashboard against a mocked API (Playwright, 26 checks: marks, delete + confirm, reply bar, chips, picker, live events, file preview, disabled states): all passed.
- Not run against real Discord (no bot token or network here). Please test once on your server.

### Notes for deploy
- No new npm packages. The bot's invite needs View Channel, Send Messages, Read Message History, Add Reactions, Attach Files and, for deleting others' messages, Manage Messages.

## Stage 2A - Voice audio quality and controls: DONE

### Discord -> website (inspected, tuned only where needed)
- Kept: 60 ms server batching (3 x 20 ms Opus frames), per-speaker streams, the adaptive jitter buffer, the recording feature.
- Server: a short tail batch is now sent after 40 ms instead of waiting for the 400 ms silence timeout (the end of a sentence no longer arrives late). Opus and decoder streams are both destroyed on error.
- Client jitter buffer fixes:
  - A normal pause in speech (>400 ms) was counted as an underrun, so the buffer kept growing and added delay. Now only a stall in the middle of speech grows it.
  - Buffer limits 100 ms start / 60-600 ms -> 120 ms start / 80-500 ms, gentler growth, faster shrink.
  - When playback runs late it now plays 8% faster instead of dropping a 60 ms chunk (no click). A chunk is dropped only if more than 1.5 s behind.
  - 3 ms fade-in at the start of each talk spurt removes the start click.
  - Mixed speakers go through a soft limiter, so several people talking at once no longer clip.
- Live status line under Listen: buffer ms, target, underruns, catch-ups.

### Website microphone -> Discord
- Resampling replaced: the old code picked every Nth sample per block (no filter, seams at block edges, wrong if the browser ignores a 48 kHz context). New streaming linear resampler keeps its position between blocks, with a 2-stage anti-alias filter when it has to downsample. At 48 kHz the audio passes through unchanged.
- Float to Int16 conversion rounds and clamps (no wrap-around).
- Mic chain: mic -> gain -> soft limiter (clean below 0.85, rounds peaks to at most 0.99, handles up to 4x overshoot) -> resampler. Mic meter turns red when peaks are near full scale.
- Server: browser-mic queue is capped at about 0.6 s so a burst cannot become permanent delay (Voice AI replies keep the large cap because Gemini sends faster than real time). Only one browser can talk into a voice channel at a time; the other gets a "another admin is talking" message instead of garbled audio.
- Voice AI microphone uses the same chain and resampler (16 kHz).

### New controls (Voice tab, grouped as Listen and Microphone)
- **Listen volume**: 0-200 %, changes only this browser's playback of Discord audio. Discord members and Record are not affected. The Voice AI reply volume is not changed.
- **Mic mute / unmute**: button shows state; status text reads Mic is live / Muted / Mic is off. While muted nothing is sent. A mute button is also in the Voice AI tab.
- **Mic gain**: 0-300 %, smoothed, passes through the limiter.
- Volume and gain are remembered in this browser. Mute is never remembered.
- Layout: wraps on mobile, sliders go full width under 720 px.

### Other
- `index.html` now lives at `public/index.html` (Stage 1 ZIP had it next to `index.js`; the server already serves it from `public/`).
- Added `package.json` (the Stage 1 ZIP had none). If your repository already has one, keep yours.

### Checks
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK. All element ids used by the script exist in the page.
- Numeric tests of the resampler and limiter (8 checks): passed. Passthrough exact, no seams at block edges for 44.1 -> 48 kHz, correct 48 -> 16 kHz length, no Int16 wrap-around, limiter transparent below 0.85 and bounded under 0.99.

### NOT tested (needs a live Discord voice connection, a real browser and a microphone)
- Real Discord audio reaching the browser, and how the new jitter settings sound on a real network.
- Packet loss: the Discord receiver gives no loss information and the Opus decoder has no concealment, so lost packets cannot be measured or repaired here.
- Mic audio reaching Discord members, mic level in Discord, the one-talker-at-a-time guard with two browsers.
- Slider, mute button and meter behaviour on real desktop and mobile browsers; iOS Safari audio start.
- Voice AI with the new mic chain.

## Stage 2B - Voice file playback and Discord Voice AI: DONE

### 1. Voice file upload and playback (Voice tab, new "Audio files" card)
- **Upload**: any signed-in admin (head or sub-admin). MP3, WAV, OGG only. Checked on the server three ways: extension, real file content (first bytes must match MP3 / WAV / OGG, so a renamed .exe is refused), and size. The browser also pre-checks type and size to save a pointless upload.
- **Size limit is configurable**: head admin sets it in the card (1-100 MB, default 20, or `VOICE_MAX_MB` env). Over-limit uploads are cut off while uploading (HTTP 413). Library holds up to 50 files.
- **Safe storage**: `DATA_DIR/voice-files/<random-uuid>.<ext>`. The uploaded name is only a display label (sanitised); it never becomes a path. Uploads land in a temp folder first and are removed if validation fails. Metadata is in `store.json`.
- **List**: name, type, size, uploader, with **Play**, **Stop** and **Delete** per file. Delete: head admin or the uploader; a playing file is stopped first. The list updates live on every open dashboard.
- **Volume** (0-150 %), **Loop ON/OFF**, **Stop**: change live while playing and are what Discord members hear. Volume is remembered in the browser.
- **Playback path**: ffmpeg (via prism-media; `ffmpeg-static` is installed) decodes to 48 kHz stereo PCM, which is played by the SAME audio player and voice connection as the mic and Voice AI. Everyone in the channel hears it. The bot joins the selected voice channel if it is not already there.
- **Loop** starts the next pass while ~5 s of the previous one are still buffered, so the gap is normally inaudible.
- **Errors and disconnects**: corrupt or missing file, ffmpeg missing, decode failure and player errors stop playback and show a message on every dashboard. Leaving or being disconnected from voice stops the file. If the player starves for a moment on a busy server it is re-armed on the same stream (up to 30 times). Playing another file replaces the current one.
- **Access control**: every route needs a signed-in admin; the limit setting is head-only. No YouTube or any downloader.
- While a file plays, the website mic and Voice AI output are paused (a notice is shown) so nothing mixes into it. Voice AI start into Discord is refused with a message.

### 2. Discord Voice AI
- **Settings (Voice AI tab, head only)**: new checkbox **Let the AI listen to Discord voice members** (OFF by default, because members' voices are sent to Google Gemini) and **answer only when called by name / answer every speaker** (default: by name, done through the AI instructions; with "by name" the model stays silent when people just talk to each other).
- **Flow**: a member starts talking -> that member is the only speaker -> bot decodes their audio (48 kHz stereo to 16 kHz mono) -> `activityStart`, audio, `activityEnd` (manual activity detection, as before) -> the existing Gemini Live session answers -> the answer is played into the Discord channel through the same player, so everyone hears it, and into browsers that listen to the AI.
- **No overlap**: one Discord speaker at a time; no new speaker while an answer is pending or still playing (plus ~0.7 s echo tail); the website mic cannot start while a member is talking, but it can still interrupt an AI answer, as before. Turns are cut at 30 s; under 300 ms of speech (a click or cough) is ignored.
- **No feedback loops**: the bot's own audio and other bots are never listened to; members are ignored while the AI is busy; nothing starts while a file plays.
- **Joins, leaves, disconnects**: a speaker who leaves the channel ends their turn; a voice disconnect or reconnect mid-turn resets the Live session; Gemini errors or a closed session clear the turn and show the error in the dashboard. Audio spoken while Gemini is still connecting (up to ~14 s) is buffered and sent in order.
- **Website microphone Voice AI is unchanged** (same chain, mute and gain from Stage 2A). The Live session is re-opened with the matching instructions when the kind of speaker changes. A small status line shows "Hearing <name>", "Thinking", "AI is speaking".

### Bug fixes found while testing
- Loop button sent the old value to the server (UI re-rendered from stale state first). Fixed.
- A stale Gemini socket closing late could mark a new session as closed. Old sockets are now ignored.

### Stage 2A kept intact
Listen volume, mic mute and gain, soft limiter, resampler and jitter buffer code were not touched. Their 8 numeric checks still pass.

### Checks actually run
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK. No duplicate top-level names, every element id used by the script exists.
- `package.json` is valid JSON; every package `index.js` requires is listed (added `ffmpeg-static`).
- Stage 2A resampler / limiter tests: 8 passed.
- File playback logic against REAL ffmpeg with a stand-in player (22 checks): format sniffing (wav / mp3 / ogg accepted, exe and html refused), name cleaning, MP3 / WAV / OGG each decode and finish on their own, initial and live volume, loop runs past the file length, loop-off ends after the current pass, Stop kills ffmpeg, corrupt file refused cleanly, replacing a file, missing file gives 404.
- Discord Voice AI turn logic with stubbed Discord and Gemini (16 checks): own audio and bots ignored, off switch respected, one speaker at a time, audio buffered until connected, start / audio / end order, busy while answer pending or playing, short blip discarded, speaker leaving, disconnect mid-turn, website mic taking priority, file playing blocks it.
- Browser test of the dashboard against a mocked API (Chromium, desktop 1200 px and phone 375 px, 26 checks): list, Play sends the file and selected channel, now-playing, Stop, loop toggle, volume, wrong type and over-limit files blocked, Voice AI settings load, no sideways scrolling, controls fit the screen, no JS errors.

### NOT tested (needs live Discord voice, audio hardware, AI credentials, or `npm install`)
- `npm install` and the real dependencies (no network here): the versions in `package.json` are my best guess, and `ffmpeg-static` downloads its binary at install time.
- The Express upload route itself (multer disk storage, 413 on oversize, auth ordering) - only the validation helpers were run, not the HTTP route.
- Real Discord: files actually heard by members, volume and loop on the live player, joining the selected channel, disconnect and rejoin during playback, player behaviour under a loaded Render free instance.
- Real Discord Voice AI: receiving member audio, Opus decoding, Gemini accepting the 16 kHz audio, the "only when called by name" behaviour, answer playback into the channel, echo with real speakers and headsets, long turns, many members.
- Gemini Live API key, model name and response quality; website-mic Voice AI after the instruction-switching change.
- Large uploads on the Render free tier (disk space is not persistent unless `DATA_DIR` points at a persistent disk; files are lost on redeploy otherwise).

## Stage 3 - Co-admin accounts, login and strict access control: DONE

### 1. Add co-admin (Admins tab, head only)
- Fields, all required and checked twice (in the browser for quick feedback, again on the server which is the one that counts): real name (2-80 chars), phone (7-15 digits), servers (multi-select, only servers where the bot is present), navigation tabs (multi-select + **Select All**), photo URL, email, password (8+ characters).
- Photo URL must match `https://i.postimg.cc/...` exactly: HTTPS only, host exactly `i.postimg.cc`, no port, no user info, no query or `#fragment`, no `..`, no spaces or quotes. Lookalikes such as `https://i.postimg.cc.evil.com/` or `https://i.postimg.cc@evil.com/` are refused.
- Email is stored lowercase and must be unique (case-insensitive). The head email cannot be reused.
- Password is stored with the existing scrypt approach (random 16-byte salt, 64-byte hash). The plain password is never stored or returned.
- Navigation tabs that can be assigned: Live chat, Roles, Voice, Schedule, AI. **Voice AI and Admins stay head-only** (they hold the API key and the account list), so they are not in the list.

### 2. Co-admin panel
- List with name, phone, email, photo, assigned servers and navigation access. Only the head admin can open it (`/api/admins*` are head-only).
- Head can: **Edit** name, phone, photo, servers, tabs (email is fixed), **Reset password**, **Delete**.
- The phone number exists only in head-only responses. It is not in `/api/me`, not in any WebSocket message, not in the co-admin's own page.

### 3. Delete co-admin
- Red **Delete** button on every row. Confirmation text: `Delete <name>? This cannot be undone`.
- On delete, in this order: removed from `admins.json` (if the disk write fails nothing changes and an error is shown) -> all sessions of that account ended -> every open WebSocket of that account closed (code 4401) -> favorites and role pins removed from `store.json`.
- The head admin is not in the list and every attempt to delete it (by id `head` or by its email) returns 403.
- Pending scheduled messages of a deleted or no-longer-authorised co-admin are not sent (they are marked failed with a reason). Voice files they uploaded stay in the library; the head admin can delete them.

### 4. Login and header
- Login is email + password. The head admin still signs in with `HEAD_EMAIL` + `HEAD_PASSWORD` from the environment, unchanged.
- Co-admin header: round profile photo, name and email. Head admin header is exactly as before (no photo).
- If the photo cannot load (or the stored URL is not a postimg link) a default avatar is shown instead. This works in the header, the co-admin list and the add/edit preview.
- Unknown emails cost the same hashing time as known ones, so login timing does not reveal which emails exist. The 10-failures-per-10-minutes throttle is unchanged.
- A browser whose account was deleted, or whose password was reset, goes back to the sign-in page with a clear message and no longer retries forever.

### 5. Strict server-side access control (the browser is never trusted)
- A co-admin's rights are read from the **current account record on every request, every WebSocket message and every broadcast**. Editing access takes effect immediately, also for sessions that are already open.
- **Servers**: unassigned servers are missing from `/api/guilds`, from the status count, and every `/api/guilds/:gid/...` route answers **403** before anything is looked up (a server id that does not exist also gives 403, so existence is not leaked). Favorites, role pins and schedules are checked by their `guildId` as well. A schedule must target a channel that really belongs to the chosen server.
- **Tabs** (route -> tab): messages, reactions, emojis -> Live chat; roles, members (read) -> Live chat or Roles; role changes, role pins -> Roles; voice routes, voice files -> Voice; schedules -> Schedule; AI settings -> AI; channel list and favorites -> Live chat, Voice or Schedule. Voice AI settings, Admins and all writes to AI settings are head-only.
- **WebSocket**: `listen` / `mic` are refused (`ws:denied` message) for a server or the Voice tab the account does not have; `vai` is head-only. Live audio is re-checked for every frame, so revoking access stops it at once. When access is edited the open sockets are cleaned up and the browser is told to reload its view (`access:changed`).
- **Broadcasts**: every event type is mapped to its tab, and guild events must carry an allowed `guildId`. An event type that is not in the map goes to the head admin only. Expired or deleted sessions get nothing, and idle sockets of dead sessions are closed by the 30-second heartbeat.
- **Stage 2 accounts** (email + password only) are upgraded automatically: name = email, no servers, no tabs. They can still sign in but see nothing until the head admin edits them.
- Menus: tabs without access are hidden; if a co-admin has no tab at all a notice says so. Hidden is cosmetic only: all of the above is enforced on the server.

### Bug found and fixed on the way
- `wrap()` only caught rejected promises, so errors thrown directly (for example "That email is already used") reached the browser as an unreadable error page and the dashboard only showed "Request failed". It now catches both, so every message reaches the dashboard.

### Checks actually run
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK.
- **Backend test, 206 checks**, running the real `index.js` with test doubles for Discord, Express, multer, cron (none of the real packages could be installed here): every validation rule (16 bad photo URLs, emails, passwords, servers, tabs), uppercase email, duplicates, scrypt storage, all head-only routes closed to co-admins, a 19-route x 2-server matrix of allowed / 403 results, non-guild routes, schedules, WebSocket broadcasts for 3 servers (A saw only Alpha chat/voice, B saw only Beta `perms`, no foreign id or text in any payload), socket actions denied, edit takes effect at once on the old token, password reset ends sessions and sockets, delete (storage, sessions, all sockets within 1.5 s, favorites and pins, no re-login, head undeletable, other accounts untouched), restart persistence, Stage 2 account upgrade, login throttle.
- **Browser test, 50 checks** (Chromium, desktop and 375 px phone): required-field and per-field messages, Select All behaviour, add / edit / reset / delete flows, exact delete text, red Delete button, header photo + email, default avatar for a broken photo, hidden tabs, direct URL calls from a co-admin page (all 403), live tab removal in an open co-admin page, deleted co-admin sent to sign-in, no sideways scroll on phone, no JavaScript errors.

### NOT tested (needs the real packages, real Discord or the real internet)
- `npm install` and the real Express / multer / discord.js (test doubles were used, so route order and `req.params` behave as I expect from Express 4 but were not run on it).
- Real Discord: the server list, channel and message calls, voice, and Discord events reaching the WebSocket with real objects.
- Loading real postimg images (the browser test used a local stand-in). Postimg "page" links (`https://postimg.cc/...`) are refused on purpose: use the direct image link that starts with `https://i.postimg.cc/`.
- Render free tier: `admins.json` and `store.json` are lost on redeploy unless `DATA_DIR` points at a persistent disk (same note as before). Without one, co-admins disappear on every redeploy.

## Stage 4A - Logging system and data collection: DONE

Backend only. The Logging tab button exists (assignable to co-admins) with a short placeholder; the real screen is Stage 4B.

### Configuration (per server)
- Stored in `store.json` under `logCfg[guildId]` (existing storage, no new database). Defaults: everything OFF.
- Per server: voice logging on/off + channels to watch, message logging on/off + channels to watch (empty list = all channels of that kind), retention days (1-365, default 30), max entries (1000-50000, default 20000).
- "Logging channels" is implemented as the channels that are logged. Channel ids are checked against the real server (voice list only accepts voice channels, message list only text channels). A failed disk save is rolled back and reported.
- `GET/PUT /api/guilds/:gid/logging/config` (GET also returns the channel lists, so a co-admin with only the Logging tab can pick channels, plus a small health block with no file paths).

### Voice logging
- JOIN, LEAVE, MOVE from `voiceStateUpdate`. Mute/deafen/stream changes are ignored. Bots are not logged.
- Each row: `ts` (epoch ms, API adds ISO `time`), `username`, `userId`, `guildId`, `channelName`, `channelId`, `type`. MOVE also has `fromChannelId` / `fromChannelName` (channel fields = destination).
- With a channel list set: JOIN/LEAVE are logged for listed channels, MOVE if either side is listed.
- `GET /api/guilds/:gid/logging/voice?limit&before&since&userId&channelId&type`.

### Message logging (counts only)
- Per message the handler reads only: id, author id + username, channel id + name, timestamp. It never reads text, attachments, images, embeds or stickers (a test feeds a message with all of those and checks nothing reaches the disk, plus a source check on the logging code).
- Counts are summed per author + channel + hour (one stored row per bucket, not per message). Bots, webhooks, system messages and DMs are skipped. Message ids (ids only) are kept in a 5000-entry memory window so one message is never counted twice.
- `GET /api/guilds/:gid/logging/messages?limit&since&until&userId&channelId` returns buckets, total, and top users / channels.

### Storage and performance
- Append-only JSON lines in `DATA_DIR/logs/<guildId>.voice.jsonl` and `.msg.jsonl`, file mode 0600. Guild ids are validated as numeric snowflakes before they touch a file path.
- Discord handlers only push to memory. A 5 s timer writes asynchronously (never inside the Discord event). Memory caps: 5000 pending voice rows, 5000 pending message buckets, 5000 remembered message ids. If the disk fails, rows are kept and retried; beyond the cap the oldest are dropped and counted in `health.dropped`.
- Retention: every 6 h (and 60 s after start, after a size > 4 MB, and when limits are lowered) old rows are removed, message deltas are merged, and the file is capped at `maxEntries` (atomic tmp + rename). Reads never load more than 24 MB of a file. A per-file lock stops writes, prunes and reads from interleaving. Pending rows are written on shutdown.
- `POST /api/guilds/:gid/logging/clear` (head admin only) deletes stored logs of a server.

### Access control
- New navigation tab `logs` (label "Logging"), assignable in the co-admin form. Head admin has it always.
- Every logging route checks: signed in -> assigned server (403) -> Logging tab (403) before anything is read. Clear is head-only. Unknown server ids give 403 to co-admins (no leak) and 404 to the head.
- WebSocket: new client message `{t:'logs', g, on}` subscribes a socket to ONE server; refused with `ws:denied` without the Logging tab or the server. Live events `log:voice` and `log:messages` (counts only, no text) go ONLY to sockets subscribed to that server that still pass the tab + server check at send time (head included). Editing access clears the subscription. Existing events and routes are unchanged.

### Checks actually run
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK.
- Logging test, 122 checks, running the real `index.js` with test doubles for Discord, Express, ws, multer, cron: 4 accounts x 5 routes (401/403 matrix), unknown / malicious server ids, config validation and persistence and rollback, JOIN/LEAVE/MOVE fields, duplicate and mute events ignored, bots ignored, channel filters, message aggregation and dedupe, privacy (content/attachments/embeds leave no trace), filters and paging, retention and compaction and entry cap, corrupt line skipped, simulated disk-full (rows kept, retried, no path leak), WebSocket subscribe/deny/broadcast isolation across servers (head included), live revocation, Stage 3 broadcasts unchanged, old routes still registered, shutdown flush, memory caps.

### NOT tested (needs a live Discord server / real packages)
- `npm install` and the real discord.js / Express / ws (test doubles were used).
- Real `voiceStateUpdate` / `messageCreate` objects: partial members or users (username shows `unknown` if Discord gives none), thread messages, and the exact event order on a real gateway.
- Voice joins that happened before the bot started are not logged (no event exists for them).
- Behaviour on a loaded Render free instance. `logs/` and `store.json` are lost on redeploy unless `DATA_DIR` points at a persistent disk.
- Minor known limit: the voice `before` paging cursor is a timestamp, so events in the same millisecond at a page edge could be skipped.

## Stage 4B - Logging dashboard and summary: DONE

### Logging tab (Logging in the navigation bar)
- Shown only to accounts that have the Logging tab (head admin always). Hidden otherwise, but that is cosmetic: every Logging API answers 403 and every Logging WebSocket action is refused (`ws:denied`) without the tab and the server (Stage 4A rules, re-tested).
- **Server selector**: lists only `/api/guilds` (already limited to the account's servers). It starts on the server opened in the main panel and follows it. Switching server reloads settings and filters, and clears the filters. Late answers from the previous server are ignored.
- Three views: **Settings**, **Voice log**, **Message counts**. Views refresh in place with no page reload.

### Settings view
- Voice logging on/off, message counting on/off, channel tick lists (only this server's voice / text channels, none ticked = all), retention days, maximum rows, storage health line, privacy note. Saved with `PUT .../logging/config` (persistent in `store.json`); server errors are shown as a message.
- Head admin only: **Delete stored logs...** (asks to confirm).

### Voice log view
- Table: time, event badge (JOIN / LEAVE / MOVE with "joined / left / moved"), username + ID, voice channel (MOVE shows `from -> to`). Counters for total / joined / left / moved.
- Filters: server (selector), user (name part or ID), voice channel, event type, from / to date-time. Pagination (25 / 50 / 100 rows, Previous / Next, "x-y of N").

### Message counts view (counts only, no content exists anywhere in this feature)
- Totals, **messages per user**, **messages per text channel** (bars), **activity over time** chart (per hour for ranges up to 3 days, otherwise per day in the viewer's time zone, empty slots filled), and a paged table of counts per person / channel / hour.
- Filters: server, user, text channel, from / to date-time.

### UI
- Same dark theme, cards, buttons and inputs as the other tabs. Loading ("Loading..."), empty (explains that logging must be on and only later events exist) and error (message + Retry) states. Tables scroll inside their own box on phones; no sideways page scroll at 375 px. Usernames are always escaped (tested with a hostile name).
- Live: after opening a server in this tab the browser subscribes (`{t:'logs', g}`) and refreshes the open view quietly (1.2 s debounce) when `log:voice` / `log:messages` arrive. Leaving the tab or the server list unsubscribes; reconnects resubscribe.

### Backend changes (additive, nothing removed or renamed)
- `GET .../logging/voice`: new `q` (user name part or ID), `until`, `offset`; response adds `counts` and `offset` / `limit`.
- `GET .../logging/messages`: new `q`, `offset`, `tzOffset`; response adds `series`, `unit`, `totalBuckets`; `byUser` / `byChannel` now up to 100 rows.
- Old parameters (`userId`, `channelId`, `since`, `before`, `type`, `limit`) still work.

### Checks actually run
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK.
- Stage 4A backend test (122 checks, real `index.js` with test doubles): still all passing.
- New backend test (13 checks): paging without overlap, user filter (case-insensitive, by ID), date range, type, daily / hourly series, empty results, no content fields in any response.
- Browser test (Chromium, 48 checks) against a server running the REAL route handlers and access checks with seeded logs: server selector contents, only that server's channels, save + reload persistence, voice paging / filters / empty / bad date range, message totals / per user / per channel / chart / hour-vs-day / paging, switching servers shows no old data, error state with Retry, co-admin A sees only Logging + only Alpha and gets 403 for Beta and for clear, co-admin C (no Logging tab) has no tab and gets 403, phone width, no JavaScript errors.
- Bug found by this test and fixed: the Logging tab asked for `logging/logging/config`.

### NOT tested (needs a live Discord server / real packages)
- `npm install` and the real discord.js / Express / ws (test doubles were used). The browser test had no real WebSocket, so live refresh in the browser was not run; the server side of it (subscribe, deny, isolation) is covered by the Stage 4A test.
- Real voice and message events from Discord, partial users, thread messages, large real logs on the Render free tier.
- Safari / Firefox / real phones (Chromium only). Date-time inputs look different per browser.
- The screens next to Logging (Live chat etc.) were not re-driven in the browser; only their code paths touched by the new hooks (`activateTab`, `openGuild`, WebSocket handler, Back button) were exercised.

## Stage 5A - Bot DM Inbox and conversation system: DONE

### Inbox tab
- New navigation tab **Inbox** (assignable to co-admins like the other tabs; head admin always has it). It is not tied to a server, so it can also be opened with the **Inbox** button on the server list (a co-admin with only the Inbox tab needs no server). Unread total is shown as a red badge on that button and on the Inbox tab.
- Conversation list: one row per Discord user with avatar, username, latest-message preview ("You:" when the bot wrote last), time, unread badge. Sorted by latest activity, search by name or ID, loading / empty / error (Retry) states. On phones the list and the conversation are shown one at a time with a Back button.
- Live over the existing WebSocket: `inbox:message` (new message + updated conversation + unread total) and `inbox:read`. After a dropped connection reconnects the list and open conversation reload.

### DM collection (`messageCreate`, DMs only)
- New intent `DirectMessages` (not privileged; the `Channel` partial was already there). DM text is readable without the Message Content intent.
- Servers are never collected for Inbox. Bots, system messages and DMs whose other person cannot be identified are skipped.
- Stored per message: id, conversation (DM channel) id, user id, direction (`in` / `out`), timestamp, text (max 4000 chars), username, attachment metadata (id, name, size, type, link, width, height; max 10). Username and avatar URL are kept per conversation and refreshed on every message (not repeated on every stored message).
- Bot replies (messages the bot itself sends into a DM) are stored as `out` and shown on the right. Missing user data falls back to "Unknown user" and the default avatar.
- Logging (Stage 4) is unchanged and still never reads content. The Inbox handler is a separate listener.

### Conversation view
- Messages oldest to newest, ordered by Discord message id (= creation time, so late arrivals still land in the right place). Latest 50 shown, **Load older messages** pages back (50 at a time, cursor = message id, no duplicates). Opens scrolled to the newest message and stays there while images load.
- Everything is rendered as text (no HTML from Discord is ever interpreted). Images (png/jpg/gif/webp from Discord CDN hosts only) are shown inline and open in a new tab with `noopener`. Other files are links. Plain-text attachments (.txt / text/plain, up to 512 KB) have a **Preview** button: the server fetches the stored Discord link (CDN hosts only, no redirects, 8 s timeout, 64 KB cap) and the browser shows it as plain text. Expired links give a clear message.

### Unread system
- `unread` counter per conversation, stored in the index file, so it survives reloads and restarts. Incoming messages add 1, the bot's own messages add 0.
- No duplicate counting: a message id is refused if it is in a 5000-entry memory window or in the conversation's last 30 stored ids (the latter survives restarts).
- Opening a conversation marks it read (`POST .../read`, or WebSocket `{t:'inbox', a:'read', u}`); a message arriving in the conversation you are looking at is marked read at once. All open dashboards update live.
- Unread is shared by all accounts that have the Inbox tab (one inbox, not one per admin).

### Storage (existing architecture: JSON files under `DATA_DIR`)
- `DATA_DIR/inbox/index.json` (small record per conversation, atomic write) and `DATA_DIR/inbox/msgs/<userId>.jsonl` (append-only, mode 0600; user ids validated as snowflakes before touching a path).
- Discord handlers only touch memory; a 1 s timer writes to disk (messages first, then index; failed writes are retried; queue capped at 5000). A shutdown handler writes what is pending.
- Limits for the Render free tier: history files are never loaded whole (a page read parses one user's file, capped at 8 MB); a file above 1.5 MB is compacted to the newest 2000 messages; at most 2000 conversations (the oldest-activity ones are deleted with their files). A corrupt `index.json` or a bad line is skipped, not fatal.

### Access control (server side, same model as Stage 3 / 4)
- `GET /api/inbox/summary`, `GET /api/inbox/conversations`, `GET .../conversations/:uid/messages`, `POST .../conversations/:uid/read`, `GET .../messages/:mid/attachments/:aid/text`: all need a session (401) and the Inbox tab (**403** for a co-admin without it). The tab is read from the current account record on every request, so removing it works immediately.
- WebSocket: `{t:'inbox', a:'summary'|'read'}` is refused with `ws:denied` without the tab. `inbox:message` / `inbox:read` events are mapped to the `inbox` tab in `EVENT_TABS`, so sockets of accounts without it never receive them (an unmapped event would go to the head only).
- Hiding the tab in the browser is cosmetic only.

### Not changed on purpose
- No reply box, no sending from the dashboard, no delete / edit sync of DMs (messageUpdate / messageDelete are not tracked). Those are not part of 5A.
- No existing route, event or tab was removed or renamed. New: `inbox` tab id, 5 routes, events `inbox:message`, `inbox:read`, `inbox:summary`, WS action `inbox`.

### Checks actually run
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK.
- Backend test, 72 checks, running the real `index.js` with stand-ins for discord.js / Express / ws / multer / cron (npm packages cannot be installed here): DM intent in both modes, DM events through every registered `messageCreate` listener (guild / bot / system / unknown recipient ignored, duplicate event counted once, late message keeps the latest preview, bot reply stored as `out`), fields stored, attachment link filtering, sorting, paging with cursor, mark read, restart persistence (new process state on the same folder: unread, history, dedupe ids), 401 / 403 matrix on all 5 routes, tab revoked live, forbidden calls change nothing, live events only to allowed sockets, WebSocket accept / reject cases, text preview (cap, expired link, wrong type, oversize), file compaction, conversation cap, corrupt index, partial user objects.
- Browser test, 53 checks (Chromium, desktop and 375 px phone) against the REAL route handlers and WebSocket gating, with a stand-in WebSocket: tab and badges, ordering, avatars, previews, inline image, file link, text preview as text, XSS payload shown as text and not run, paging without duplicates, marked read on open, live message and live badge, duplicate event, unread after page reload, search and empty states, no Inbox button for an account without the tab, 403 when the UI is bypassed, WS rejection toast, co-admin with the tab, phone layout.
- Bugs found and fixed by these tests: the conversations list was overwritten by the summary count; queued lines could re-create the file of a pruned conversation; images loading late pushed the newest message out of view.

### NOT tested (needs a live Discord account sending DMs / real packages)
- A real DM reaching the bot: real `Message` / `DMChannel` objects (the tests use plain objects shaped like them), whether `channel.type` is `DM` for a partial channel on a real gateway, `recipientId` on the bot's own outgoing DMs, avatar URL format for users with default avatars.
- DMs sent by the bot before this version started (no event exists), and DMs sent while the bot was offline (not delivered by Discord to bots).
- Real Discord CDN images and attachment links (expiry time, 403 / 404 behaviour of the text preview). Discord signs CDN links and they stop working after a while: old images and previews may show as broken, the stored text and file names stay.
- `npm install` and the real discord.js / Express / ws. The browser test used a stand-in WebSocket (the server-side WebSocket gating was exercised through the real handlers).
- Render free tier: `inbox/` is lost on redeploy unless `DATA_DIR` points at a persistent disk (same as `store.json` and `logs/`). Safari / Firefox / real phones.

## Stage 5B - Website DM reply and auto-reply system: DONE

### Reply from the website (Inbox conversation)
- A message box and a **Send** button sit under every open conversation. **Enter** sends, **Shift+Enter** is a new line (Enter is ignored while a Bengali / other input method is still composing). Unsent text is kept per conversation. Limit 2000 characters (Discord's limit), shown as a counter near the end.
- `POST /api/inbox/conversations/:uid/send` `{ content, clientId }`. The server re-checks the Inbox tab (401 / 403), that the conversation exists (**404**: replies go only to people who already wrote to the bot, never to a random ID), the text (400) and a burst limit of 15 sends / 30 s per account (429).
- The bot sends the DM (mentions are never parsed), the message is stored in the conversation history, and it is shown at once: the sender gets it from the HTTP answer, every other admin from the existing `inbox:message` WebSocket event.
- **No duplicates**: (1) the Send button is disabled while a send is running; (2) the browser reuses one request id (`clientId`) for a retry of the same text and the server answers a repeat with the first result without sending again (a parallel repeat gets 409); (3) Discord's `nonce` + `enforceNonce`; (4) the stored message id check from 5A makes sure the copy of our own message that Discord also pushes through the gateway is stored, counted and shown once, whichever arrives first (tested both orders).
- **Discord restrictions** become clear messages (and the text stays in the box for a retry): DMs closed / bot blocked / no shared server (403), unknown or deleted user (404), "DMs opened too fast" (429), bot not connected (503), anything else Discord says (502, never a raw 401 that would log the admin out). A failed send is never stored.
- Stored messages now carry where they came from: `source` = `web` (with the admin's name), `auto-fixed`, `auto-ai`. The conversation shows "Sent by <name>" / "Auto-reply (fixed text)" / "Auto-reply (AI)".

### Auto-reply settings (Inbox -> **Auto-reply settings**, status chip always visible)
- ON / OFF, mode **Fixed Text** or **AI Answer**, fixed text editor (max 2000), AI extra instructions (max 1500) and "earlier messages the AI may read" (0-10), cooldown (value + seconds / minutes / hours), Save. A **Turn auto-reply off** quick button is always shown while it is ON.
- `GET` / `POST /api/inbox/autoreply`. Everything is validated on the server: types, ranges (cooldown **10 s to 7 days**, whole numbers), text lengths, "ON needs fixed text" and "AI mode needs an AI key". Wrong input returns 400 and changes nothing. A save is written to disk first and only then becomes active.
- Persistent: `DATA_DIR/inbox/autoreply.json` (atomic write, mode 0600). A damaged file is ignored and auto-reply stays OFF.
- Live: a change is pushed to every admin who has the Inbox tab (`inbox:autoreply`); an admin with unsaved edits is not overwritten and gets a notice. The panel also shows "last changed by", and counters since the server started (sent / failed / skipped by cooldown) with the last problem.

### Fixed-text auto-reply
- Only for **direct messages** from real users. Never answered: bots, webhooks, the bot itself, server messages, system messages, messages older than 2 minutes (a replay after reconnect), the same message event twice. Our own reply coming back from Discord cannot trigger anything, so no reply loops.
- Only one reply per cooldown per user (below). A global safety limit of 120 auto-replies per hour protects the bot account from looking like spam.
- Discord errors (DMs closed etc.) are caught: nothing crashes, the failure and the clear reason are shown in the settings panel, and the cooldown still applies so the bot does not keep retrying a user who blocked it.

### AI auto-reply
- Uses the **existing AI integration** only: provider, model, key, name and description come from the AI tab (`askAI`). No other service, no new key, no new package. The AI tab's own on/off switch is not needed for DMs (it controls server mentions); a key is.
- The AI gets the AI-tab description + a note that this is a private DM + the extra Inbox instructions, the last N messages of that conversation as context, and the new message. Answer is cut at 1900 characters. Own timeout of **30 s** for DMs (the server-chat AI keeps 60 s).
- One reply at a time per user: the cooldown is claimed **before** the AI is called and a per-user "busy" flag is kept, so messages sent while the AI is thinking get no second reply. Different users are handled in parallel.
- Errors (quota, timeout, empty answer, key removed) send nothing, are shown in the panel, and release the user to try again after about a minute instead of a full cooldown. If auto-reply is switched off (or the mode changed) while the AI is thinking, the answer is dropped and the cooldown is given back. Attachment-only DMs are not answered in AI mode.
- Replies are sent through Discord and stored as `auto-ai`.

### Cooldown
- Separate for each Discord user. Time of the last attempt is stored in `DATA_DIR/inbox/cooldowns.json` (written 2 s after a change, atomic, mode 0600, entries older than 7 days dropped, at most 20000) and survives restarts. Changing the cooldown applies to existing timers at once. A timestamp from the future (clock change) never blocks for more than one cooldown.
- A reply written by an admin on the website also starts the user's cooldown (when auto-reply is ON), so the bot does not talk over a person.

### Access control (server side)
- Same model as 5A: `/api/inbox/autoreply` (GET, POST) and `/send` need a session (401) and the Inbox tab (**403**), read from the current account record on every request, so removing the tab works immediately. Hiding buttons in the browser is cosmetic only.
- WebSocket: `{t:'inbox', a:'autoreply'}` is refused with `ws:denied` without the tab; unknown Inbox actions (for example trying to send or change settings over the socket) are refused; `inbox:autoreply` is mapped to the `inbox` tab in `EVENT_TABS`, so other accounts never receive settings or DM content. Settings and sends are HTTP-only on purpose.
- Any account with the Inbox tab may change the auto-reply settings (it is one shared inbox). The AI key itself stays head-only and is never returned by these routes.

### Changed code (additive)
- `index.js`: new section "Inbox (Stage 5B)"; `inboxHandle` got optional `forceUid` / `outTag` and returns the record; `msgView` / `inboxClean` keep `source` / `by`; `askAI` got an optional timeout argument (default unchanged); four extra Discord error codes mapped; one new `messageCreate` listener; the shutdown handler also saves cooldowns.
- `public/index.html`: reply box, auto-reply bar and panel, source labels. `package.json` version 5.1.0. No route, WebSocket event, tab or setting of Stage 1-5A was removed or renamed. New: routes `GET/POST /api/inbox/autoreply`, `POST /api/inbox/conversations/:uid/send`; event `inbox:autoreply`; WS action `autoreply`; files `inbox/autoreply.json`, `inbox/cooldowns.json`.

### Checks actually run
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK.
- Backend test, **132 checks**, running the REAL `index.js` over real HTTP and real WebSocket (`ws`) with stand-ins for discord.js / Express / multer / cron / voice (npm packages cannot be installed here) and a fake Gemini endpoint: 401 / 403 matrix on settings and send, about 20 validation cases, persistence on disk (and file mode), website send (attribution, one Discord call, one live event per socket, repeat id, parallel repeat, gateway echo before the REST answer, blank / too long / bad id / unknown conversation, every Discord error, bot offline, burst limit), WebSocket allow / deny / no leak to unauthorized sockets, fixed auto-reply (once, cooldown, per user, duplicate event, bots / webhooks / self / server messages / stale ignored, blocked user, OFF), real 10 s cooldown expiry, cooldown file, AI mode (existing Gemini key and prompt, context, timeout value, one reply under overlap, parallel users, HTTP error, timeout, empty and long answers, attachment-only, switched off mid-answer, key removed), human reply silences the bot, 5A routes unchanged, tab revoked live.
- Restart test (4 checks): settings, cooldowns and tags reload; a user answered before the restart is still in cooldown. Damaged-files test (4 checks): the server starts, auto-reply stays OFF, a save repairs the file.
- Browser test, **51 checks** (Chromium, desktop and 375 px phone) with two admins at once and a real WebSocket: reply box, Enter / Shift+Enter, one message per send, double click, blank / too long, DMs-closed error with text kept and retry, drafts, live sync between admins with sender labels, settings panel (mode switch, inline server errors, cooldown units, chip, quick off, conflict notice, live update), hostile text shown as text, co-admin without Inbox has no button and gets 403 when bypassing the UI, no sideways scrolling, no JavaScript errors.
- Bugs found and fixed by these tests: an unknown Discord error would have reached the browser as the raw Discord status (a 401 would log the admin out); now it is a 502 with a message.

### NOT tested (needs a live Discord server / real packages / real AI credentials)
- `npm install` and the real discord.js / Express / ws / multer. Fake stand-ins were used. In particular: real `user.send()` results, whether Discord echoes `nonce` back on the gateway copy of our own message (if not, a message that arrives from the gateway first can miss its "Sent by" label until it is reloaded; it is still stored and shown once), real `enforceNonce` behaviour, real DM error codes (50007 etc.) for blocked users.
- A real Gemini (or OpenAI / Claude) key: real answer quality, real quota / rate-limit errors, the real 30 s timeout (the test simulates the timeout error and checks the value passed). The Gemini model name in the AI tab (`gemini-3.8-flash` default) is unchanged from earlier stages.
- A real person DMing the bot, real typing indicator, Discord anti-spam reaction to automatic DMs (use a sensible cooldown; the 120 / hour global limit is only a safety net).
- Render free tier: `inbox/autoreply.json` and `inbox/cooldowns.json` are lost on redeploy unless `DATA_DIR` points at a persistent disk (same as the rest of `inbox/`). A cooldown that is still running when Render restarts the service is kept only if the disk is persistent.
- Safari / Firefox / real phones (Chromium only).

## Stage 6A - Bot Profile: server nickname, avatar and banner: DONE

### Navigation and servers
- New navigation tab **Bot Profile** (id `botprofile`). It is a normal assignable tab: the head admin ticks it for a co-admin in the Admins tab (Stage 3), exactly like the other tabs. The head admin always has it. Existing co-admins do NOT get it automatically.
- It can be opened inside a server (like the other tabs) or straight from the server list with the **Bot Profile** button (like Inbox). Inside it a **server selector** lists only the servers the account may use (all for the head admin, only the assigned ones for a co-admin).
- Choosing a server loads the bot's profile *in that server*: nickname, server avatar, server banner, and whether the bot has Change Nickname. Only the per-server profile is read and written (`/guilds/{id}/members/@me`). The bot's global Discord profile is never touched.

### Nickname
- Input with a live counter, **Save** and **Reset to Default**. Limit 32 characters (counted as Unicode characters, so an emoji counts as 1). Checked in the browser and again on the server: empty, whitespace only, control characters, wrong type and more than 32 are refused with a clear message (400) and nothing is sent to Discord.
- The bot's **Change Nickname** permission is checked before every change. If it is missing the dashboard says so, before and after clicking, and the server answers 403 with the same text. Discord's own error text (for example a banned word) is shown as it is.
- Reset sends `nick: null`, the API value that removes the server nickname.

### Avatar and banner
- For each: upload **PNG, JPG or GIF** or paste an **image link**, a **preview ("New (not saved yet)")** before saving, **Save**, **Cancel selection** and **Remove**. Nothing is sent until Save. If nothing was chosen the server answers 400 "Nothing to change" and the current image is kept.
- Each route sends only its own field, so changing the avatar never touches the nickname or the banner (and the other way round). The file is converted to a base64 data URI on the server. **Remove sends `null`**, the API value that resets the image.
- Validation, all on the server: the real type is read from the file content (PNG / JPEG / GIF signature), so a renamed text file or a WebP is refused with 415; size limit (see below) is 413; an empty file is 400.
- **Upload size limit is configurable**: environment variable `PROFILE_IMAGE_MAX_MB` (0.1 to 10, default 8). The browser shows and enforces the same limit (it is sent in the profile response).
- Image links: HTTPS only, no user name / password, port 443 only, at most 2000 characters. The server downloads the image itself, so the link is protected against server-side request forgery: the host name is resolved, any private / loopback / link-local / internal address (also IPv6 and IPv4-mapped) is refused, the connection is pinned to the address that was checked, every redirect (max 3) is checked again, 15 s timeout, the size limit is enforced while downloading, and non-image content types and files that are not really PNG / JPG / GIF are refused.
- Discord errors become clear messages: invalid form body (Discord's own text, for example the "changing your avatar too fast" limit), missing permission, file too large, unknown server, rate limit (429), no answer in 20-25 s (504). A raw upstream 401 is never passed on (it would sign the admin out); it is a 502.

### Access control (server side)
- Four routes: `GET /api/guilds/:gid/bot-profile`, `PUT .../bot-profile/nickname`, `PUT .../bot-profile/avatar`, `PUT .../bot-profile/banner`. Order on every request: session (401), then server access (**403**), then the Bot Profile tab (**403**), and only then is anything about the server looked up, so an unauthorized request learns nothing (no name, no nickname, no image). Access is read from the current account record on every request, so removing the tab or the server works immediately.
- WebSocket: `{t:'botprofile', a:'get', g}` re-checks tab and server, and again after Discord answers. Any other action (nickname / avatar / banner / remove ...) is refused with `ws:denied`: changes are HTTP only. The new event `botprofile:changed` (server id, field name and who changed it, never image data) is mapped to the `botprofile` tab and is a guild event, so it reaches only sockets with the tab AND the server.
- Safety: one change per field and server at a time (a second one gets 409), at most 12 changes per minute per account (429), the Discord call has a time limit, the audit reason of the change names the dashboard account.
- Hiding the tab or buttons in the browser is cosmetic only.

### UI
- Same look as the other tabs (cards, buttons, colours). Preview card (banner, avatar, name) of the saved profile, three editor cards in a responsive grid (3 / 2 / 1 columns, no sideways scrolling at 375 px).
- Loading state while a profile loads, spinner on the button and disabled controls while saving, inline success / error message in each card plus a toast. No page reloads. Another admin's change is picked up live; the text you are typing is kept. Signing out clears everything.

### Changed code (additive)
- `index.js`: new section "Bot Profile (Stage 6A)" (4 routes, helpers, image downloader), `NAV_TABS` + `botprofile`, `EVENT_TABS` / `GUILD_EVENTS` + `botprofile:changed`, one WebSocket action, `Routes` import from discord.js, `dns` / `net` / `https` requires. No route, event, tab or setting of Stage 1-5B was removed or renamed.
- `public/index.html`: new tab, picker button, styles and script. `package.json` version 6.0.0. `.env.example` documents `PROFILE_IMAGE_MAX_MB`.

### Checks actually run
- `node --check index.js`: OK. Syntax check of the script in `public/index.html`: OK.
- Backend test, **186 checks**, running the REAL `index.js` over real HTTP with stand-ins for discord.js / Express / ws / multer / cron / voice (npm packages cannot be installed here): 401 / 403 matrix on all 4 routes (no tab, other server, assigned co-admin on a foreign server), no Discord call and no data in any 403, bad ids, nickname validation (empty, spaces, 33 characters, emoji counted per character, control characters, wrong types), permission missing, PATCH bodies (only the one field, `nick: null` / `avatar: null` / `banner: null`), uploads of PNG / JPG / GIF, rejected WebP / renamed text / oversize / tiny / wrong field name, 21 link cases (http, credentials, port, localhost, 127.0.0.1, 10.x, metadata IP, IPv6 loopback, IPv4-mapped IPv6, private and mixed DNS answers, unknown host, HTML page, fake PNG, WebP, 404, too big, too big streamed, redirect loop, redirect to a private host), redirect followed, connection pinning, Discord errors (50035 text, 50013, 50045, rate limit, timeout, upstream 401), parallel change -> one 409, burst limit, WebSocket allow / deny / unknown actions, events only to allowed sockets, tab or server removed live, Stage 1-5B routes still working.
- Browser test, **102 checks** (Chromium, desktop and 375 px phone) against the real route handlers: tab and picker button, server list, current values, previews, nickname counter and validation without a request, save / reset, Discord error text, loading state, file type / size checks, preview before saving, cancel, saved image, link checks, remove, banner, server switch, missing-permission warning, live update that keeps typed text, no sideways scrolling, logout cleanup, co-admin with the tab (only assigned servers, 403 when bypassing the UI), co-admin without the tab (no button, 403), no JavaScript errors.

### NOT tested (needs a live Discord bot / server / real packages)
- `npm install` and the real discord.js / Express / ws / multer (stand-ins were used). In particular `client.rest.get/patch` with `Routes.guildMember(...)` and the `signal` option were exercised only against a stand-in, not against Discord.
- Whether Discord accepts a per-server **avatar / banner for a bot** on your server and what it answers (the endpoint accepts `avatar`, `banner` and `nick` for the current member, but Discord may refuse some changes, for example an animated GIF or a banner, depending on the account or server). Such a refusal is shown with Discord's own text. Discord's real rate limit for avatar changes is strict (it can allow only a few changes per hour), so repeated tests can be refused with a 400 / 429 message.
- The real CDN image URLs of the current server avatar / banner (hash format and `.gif` for animated hashes follow the documented pattern but were not loaded from Discord), role-hierarchy edge cases, a bot that is the server owner, real image links on the internet (the downloader was tested against a local server with the DNS and HTTPS layer replaced by stand-ins, so real TLS and real DNS were not exercised).
- Render free tier: nothing is stored on disk by this stage. Safari / Firefox / real phones (Chromium only).

## Stage 6B - Bio, Discord profile API, cooldown, final access audit: DONE

### 1. Bio editor (Bot Profile tab, new "Server bio" card)
- Shows the current server bio when Discord returns it. Textarea with live counter (`n / 190`), **Save**, **Remove / Reset** (asks to confirm), inline success / warning / error message plus a toast.
- Limit **190 characters** (counted as Unicode characters; an emoji is 1). Checked in the browser and again on the server: wrong type, empty / whitespace only, control characters (new lines are allowed and normalised) and over-limit return HTTP 400 and send nothing to Discord. 190 is the limit of Discord's "About me" text. It could not be checked against live Discord here (see limitations): Discord's own answer stays the final word, and its error text is shown if it refuses.
- Route: `PUT /api/guilds/:gid/bot-profile/bio` with `{ bio }` or `{ reset: true }` (sends `bio: null`).
- Text typed in the bio box is not overwritten when another field is saved or another admin changes the profile.

### 2. Discord API integration (server-specific profile only)
- All four fields use `client.rest.patch(Routes.guildMember(guildId, '@me'), { body })`. This is `PATCH /guilds/{id}/members/@me`: only the bot's profile in that one server is changed, never the global avatar / banner / profile. Each route sends **only its own field** (`{nick}`, `{avatar}`, `{banner}` or `{bio}`), so the other fields stay as they are (PATCH leaves omitted fields unchanged). Verified: after nickname, avatar, banner and bio were changed one after the other, all four values were still present.
- Images are sent as `data:image/png|jpeg|gif;base64,...`. `null` removes / resets nickname, avatar, banner and bio.
- **Bio support is checked, not assumed.** The answer of Discord is inspected after every bio change:
  - Discord rejects the field (for example "Unknown field" or "Must be 190 or fewer in length"): the real Discord text is shown (HTTP 400).
  - Discord answers OK and returns the same bio: "Server bio saved."
  - Discord answers OK but returns no `bio` field: a yellow warning says the bio **could not be confirmed**, it is not reported as saved.
  - Discord answers OK but returns a different bio: a warning says it was **not applied**.
- Audit log: every change is logged in the Discord audit log as `Dashboard: <account email>`.

### 3. Current profile display
- `GET /api/guilds/:gid/bot-profile` reads the bot's member with `client.rest.get(Routes.guildMember(...))` and shows nickname, server avatar, server banner and bio. Missing values fall back gracefully (default name, default avatar, empty banner).
- If Discord does not include a `bio` in the member data it returns, the card says so ("Discord does not show the current bio to the bot") instead of pretending there is none. In that case it shows the **last bio saved from this dashboard** (clearly labelled, kept in server memory only, lost on restart).
- A failed read gives a clean error message (HTTP 502 / 404), the page stays usable.

### 4. Image and API error handling
- Discord's own error text is shown for rejected images (for example "Invalid image format."). File too large (our limit 413, Discord 50045 -> 413), unsupported types (renamed files, WebP: 415), rate limit (429 with message), timeouts (504), other API failures (502). An upstream 401 is never passed to the browser, because it would sign the admin out.
- **No image data in logs.** discord.js errors carry the request body (= the base64 image). Now: `bpErr` clears `requestBody`, `wrap()` logs only the message, and the `unhandledRejection` / `uncaughtException` handlers print only name, message and code for such errors. Bio text is not logged either. Tested with a marker string inside a fake Discord error and `process.emit('unhandledRejection')`: the marker never appears in the logs.

### 5. Profile change cooldown (server-side)
- At most **4 profile changes per minute per server** (env `PROFILE_CHANGES_PER_MIN`, 1-10). It is shared by nickname, avatar, banner and bio, by every account and every browser tab, and is held in server memory, so repeated API requests cannot get around it.
- Beyond the limit: HTTP **429**, text "Cooldown: this server's bot profile was changed N times in the last minute. Wait X seconds and try again.", header `Retry-After` and JSON `retryAfter`. The check happens before Discord is called.
- Only real attempts are counted: refused requests (bad input, 401 / 403, permission missing, 409 duplicate) do not use up the allowance.
- Other servers, reading a profile, chat, voice, inbox, status, guild list and all other routes are not affected (tested).
- This replaces the 6A limit of 12 changes per minute per account. The 6A rule "one change per field and server at a time (409)" is kept.

### 6. Final access control (re-verified)
- Bio route follows the same order as the others: session (401) -> server (403) -> Bot Profile tab (403) -> only then anything is looked up. A 403 body contains no data.
- WebSocket: `botprofile` accepts only `get`, re-checked for tab and server (also after Discord answers). `set`, `bio`, `nickname` and every other action are refused with `ws:denied`; nothing can be changed over the socket. `botprofile:changed` (server id, field name, who changed it; never text or image) reaches only sockets with the tab AND the server.
- Whole-project audit (see below): every registered route was called without a token, on an unassigned server, with the wrong tab, and (head-only routes) as a co-admin with all tabs. Head admin keeps all servers, all tabs, Admins and Voice AI, and the unchanged login.

### Changed code (additive)
- `index.js`: `PUT .../bot-profile/bio`; view fields `bio`, `bioReadable`, `bioLastSaved`, `limits.bioMax`, `limits.changesPerMin`; `bpCooldown()` replaces `bpThrottle()`; `wrap()` adds `Retry-After`; log-safe error handling; env `PROFILE_CHANGES_PER_MIN`.
- `public/index.html`: Server bio card, counter, handlers.
- `package.json` 6.1.0. `.env.example`: `PROFILE_CHANGES_PER_MIN`, `VOICE_MAX_MB`. No route, event, tab or setting of Stage 1-6A was removed or renamed.

## Stage 6B - Final audit

### Tests actually run in this stage (all passed)
- `node --check index.js`: OK. Syntax check of every inline script in `public/index.html`: OK. `package.json` valid JSON. Every module `index.js` requires is listed in `package.json` (`ffmpeg-static` is used by `prism-media`'s ffmpeg lookup, not required directly). No duplicate element ids in `index.html` (ids built by templates were already present in 6A).
- **Bot Profile backend, 105 checks**, running the real `index.js` over real HTTP and real WebSocket (`ws`) with stand-ins for discord.js / Express / multer / cron / voice: 401 / 403 matrix on all 5 routes (no tab, other server, unknown server), no Discord call on any refused request, bio valid / 190 / 191 / emoji / blank / wrong type / control chars / newlines, exact PATCH route and payloads (`{bio}`, `{bio:null}`, `{nick}`, `{avatar:"data:image/png;base64,..."}`, `{banner}`), all fields preserved, audit reason, cooldown (5th change -> 429 + Retry-After; invalid input not counted; covers all four fields; other servers, reads and unrelated APIs not blocked), bio unconfirmed / mismatch warnings, Discord errors (50035 text, unknown-field rejection, 429, 5xx, upstream 401, image invalid, file too large), uploads (fake image, WebP, oversize), nickname permission, read failure, log safety, WebSocket allow / deny / no PATCH over socket, event isolation, tab removal effective at once.
- **Project-wide access audit, 23 checks**: all 63 registered routes without a token (401), every `:gid` route on an unassigned or unknown server with an all-tabs co-admin (403), every `:gid` route with a wrong-tab co-admin (403), 10 head-only routes closed to co-admins (403), tab-gated routes with the wrong tab (403), WebSocket `listen / mic / logs / inbox / botprofile / vai / send / nickname` refused for wrong tab, unassigned server and HTTP-only actions (`ws:denied`) with no Discord change, `access:changed` pushed on edit, revoked server -> 403 at once, deleted co-admin token dead, head cannot be deleted, head keeps every tab and every server, head login unchanged.
- **Browser test, 21 checks** (Chromium, 1200 px and 375 px): bio card, counter over limit, client-side length error, save, success message, current bio shown, unsaved bio kept when saving the nickname, reset, cooldown error message, no sideways scroll, no JavaScript errors.

### Not re-run in this stage
- The Stage 1-6A test suites of earlier stages were not part of the ZIP and were not re-run. Their recorded results are kept in the sections above. This stage re-verified only syntax, startup, route registration and access control for the whole project (above) plus the new Bot Profile work.

### NOT tested (cannot be tested without these)
- **Live Discord server**: any real Discord call. In particular whether Discord accepts `bio`, `avatar` and `banner` on `PATCH /guilds/{id}/members/@me` for a bot, whether `bio` is returned by the member read, the real bio length limit, real CDN URLs of the server avatar / banner, real rate limits for avatar changes, real DM / reaction / message / channel behaviour.
- **Discord voice connection**: audio quality, microphone, file playback, Discord Voice AI (Stage 2A / 2B).
- **Real admin / co-admin accounts in a real browser session** on the deployed site (tests used generated accounts).
- **AI API credentials**: Gemini / other AI answers, Voice AI, DM AI auto-reply.
- **Render deployment**: `npm install` of the real packages (versions in `package.json` were never installed here), startup on Render, persistent disk, keep-alive ping, free-tier limits.
- Safari, Firefox and real phones (Chromium only).

### Known limitations
- **Server bio may not be supported for bots by Discord.** The code sends `bio` as asked and reports the real outcome. If Discord rejects it, the dashboard shows Discord's text. If Discord accepts but returns no bio, the dashboard says it could not confirm the change. It does not claim success in those cases. The 190-character limit is Discord's "About me" limit and was not verified against the bot endpoint.
- The current bio can only be displayed when Discord includes it in the member data. Otherwise the dashboard shows the last bio saved from the dashboard (memory only, lost on restart).
- Avatar and banner for bots in a server can be refused by Discord (account / server restrictions, animated GIFs); Discord's avatar-change rate limit is strict. The 4-per-minute cooldown is a dashboard safeguard and does not replace Discord's own limit.
- The cooldown is kept in memory: it resets when the server restarts, and it is per server process (one Render instance).
- Without a persistent disk (`DATA_DIR`), `admins.json`, `store.json`, `logs/` and `inbox/` are lost on every redeploy (co-admin accounts disappear).
- Other limitations noted in earlier stages remain (for example: Discord CDN links of old DM attachments expire; voice joins before start are not logged; no packet-loss concealment in voice; the voice log paging cursor is a timestamp).
