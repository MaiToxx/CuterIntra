# Cuter Intra — 42 Mulhouse edition

Cuter Intra adds quality-of-life features to the 42 Intra v3 profile pages: a logtime calendar, a live cluster map, custom profiles and looks, shortcuts, a friends widget, correction stats, and a few secrets. Everything works with your Intra session alone; the optional cloud account is a sign-in with that same session, no password and no OAuth page.

An unofficial student project, not affiliated with or endorsed by 42.

### 📅 Logtime
Replace the default logtime view with a monthly calendar showing your logged hours at a glance, with weekly totals. Switch to a **heatmap** of your whole history or a **compact** view of past months as summary cards. Set a monthly goal (default 140 h) and follow a progress bar with your percentage and remaining hours; track your daily average and last active day, or use **emoji mode** to turn hours into monthly "earnings". Custom colours and rainbow palettes; your subscribed 42 events appear as markers on the days. Signed in, **Load older months** brings back your whole logtime history, not only the months the Intra loads.

### 🖥️ Clusters
On campuses whose cluster files define it, directional markers on the cluster map show which way each seat faces. Pick a cluster from a dropdown, set a default one, open profiles in a new tab. Your campus is detected automatically.

### 🗺️ Live cluster map
Open an interactive cluster map from the **Clusters** button in the Intra sidebar or from your profile: seat occupancy with avatars, taken/total badges, a Wi-Fi users tab, room tabs, **zoom** (30%–300%), a campus selector with the campus's local clock, and a refresh every minute while the tab is visible. Click any seat to open that student's profile. Works for every campus with cluster data; Mulhouse is included.

### 👤 Profile
Personalise your profile with a custom avatar, banner and background: click your avatar to open the editor with zoom, drag-to-reposition and a live preview, plus a transparent or solid colour behind the avatar. Your custom avatar also appears in the site navigation bar. Reorder or hide the dashboard cards (Logtime, Agenda, Evaluations, Projects, Achievements, Thursday Roulette) by dragging them. Wallet, level, rank, score and seat show as coloured badges under the header, with a **campus flag**. Projects become colour-coded badges (green for projects, red for exams), every graded project is listed with date and score, pending evaluations are sorted into "To feedback", "Evaluator" and "Evaluated", achievements get a full list with a glow on milestones, and frozen students get a freeze card with a live countdown. The Thursday Roulette card counts your roulette wins and your evaluations as corrector per month, with your success rate, and signed in, the Outstanding flags you received and gave. A **Phoenix/Pegasus tracker** shows whether you meet your weekly thresholds. Click any seat label to jump to the cluster map with that seat highlighted.

### ✨ Public profile ☁️
Show every Cuter Intra visitor who you are: a status with an emoji, pronouns, a short bio, flair emoji, a greeting, your GitHub, GitLab, LinkedIn, website and Discord handle; a styled name (gradient, rainbow, glow, neon, fonts), an avatar frame, a level bar style, a header gradient and a page effect (snow, stars, fireflies, confetti, bubbles, sakura, rain or embers). Only presentation values and short texts are published, and everything a visitor receives is validated in their browser before it touches the page. Visitors can turn other people's extras off.

### 🎨 Customize
A **Customize** tab restyles every Intra page live: accent colour (with gradient), your own page, card and text colours, a background image or one of 13 built-in gradients, six card styles, per-card borders and colours, fonts and size, density, rounded corners, scrollbar style, custom CSS, 58 theme presets that colour the whole page in their own hue (Catppuccin, Tokyo Night, Gruvbox, Rosé Pine, Nord, Everforest, Kanagawa, Solarized, Sakura, Sage…). Save looks as presets, share them as theme codes, and optionally **publish your look ☁️** so other Cuter Intra users see your profile the way you styled it.

### 🔗 Shortcuts
Up to 8 quick-access links on your profile as colourful buttons, each with a name, URL, colour and emoji (or the site's icon). Drag to reorder; optionally hide the default links.

### 👥 Friends
A friends panel in the bottom-right corner: add friends by login, see their avatar, level bar, wallet, correction points, location and online status; follow or unfollow from any profile; sort by name, level, wallet, points or online; a badge with the number of friends online. Data comes from the Intra itself, is cached for 5 minutes, and refreshes when you reload the page or press refresh.

### 📆 Calendar sync ☁️
Subscribe to your 42 events in Google Calendar, Apple Calendar or Outlook through a private ICS link, with a QR code for phones. Events are pushed every time you open your own profile, each with a 15-minute reminder. Your booked evaluations of the next 14 days are added too, with the same reminder, and an option adds every campus event and exam, the ones you are not registered for shown as free time. Regenerate the link at any time.

### 📄 Subject tracker ☁️
On project pages, a badge shows when the subject PDF last changed. When you are signed in, opening a project page sends the project's name to the Cuter Intra server (at most every 15 minutes per project), and the subject PDF's address the first time or when it changes, so every user sees subject updates. Turn off *Share with the community* in the Extras tab to keep it local.

### ⚡ Lighten the Intra
Three switches make the Intra page itself cheaper: skip laying out off-screen rows in long cards, pause animations while the tab is hidden, and connect early to the image server.

### 📢 Announcements
A banner at the top of profile pages shows Cuter Intra service announcements (Notice, Warning or Critical) with optional links. Dismiss one and it stays dismissed in every tab and after a restart until a new announcement is posted.

### ☁️ Cloud account (optional)
Click **Sign in with 42** in the popup: after showing what it sends, the extension signs you in with the Intra session your browser already holds (the worker verifies it against 42's public keys and never stores it). Push or pull your settings, or let auto-push sync them as you change them; your custom visuals and, if you choose, your public profile and look become visible to other Cuter Intra users. Wipe all your cloud data in one click.

### ⚙️ Settings hub
All settings in one place, from the gear in the Intra sidebar: Profile, Extras, Clusters, Logtime, Shortcuts, Calendar, Customize, Advanced and About tabs; feature toggles, per-feature reset, backup and restore as JSON, theme toggle and cloud status. Everything works from the keyboard and with a screen reader, and respects your system's reduce-motion setting.

---

**Privacy**: settings are stored locally. The cloud account is optional and opt-in; signing in sends your current Intra session token once to the Cuter Intra server, which checks it against 42's public keys and does not store it. No third-party analytics, tracking or advertising. The server keeps one row per signed-in user (a hash of the login and the date of the first sign-in) for the public user counter in the About tab. Uploaded images are stored without their location or camera metadata. Full privacy policy: https://github.com/MaiToxx/CuterIntra/blob/main/PRIVACY.md
