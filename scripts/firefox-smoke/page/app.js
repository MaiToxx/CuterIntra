/*
 * The "Intra bundle" of the synthetic page, served as /assets/index.js and
 * loaded exactly like the real one: <script type="module" crossorigin src>
 * in <head>, so it is deferred until the document is parsed and runs before
 * DOMContentLoaded. It is the page's first real script (the one-line inline
 * probe before it only records a fact, see server.mjs). PAGE world. No
 * innerHTML: DOM APIs only.
 *
 * 1. Login, then API client, in the order of the real page. keycloak-js
 *    first gets the token with an XMLHttpRequest to auth.42.fr (the stub
 *    answers after --auth-latency ms, 30 by default); only then does the app
 *    send its intrapy.intra.42.fr requests, with
 *    `Authorization: Bearer <Keycloak JWT>`. hook.js wraps window.fetch to see
 *    that header, stores it in sessionStorage["ft_intrapy_token"] and
 *    dispatches 42_INTRAPY_TOKEN. The stub mints a new JWT for every login, so
 *    a token left in sessionStorage by an earlier load can never pass for a
 *    fresh capture. The app also fetches /locations_stats (hook.js relays the
 *    logtime payload), a /projects/...?cursus_id= URL (hook.js stores the
 *    active cursus id) and /campus (hook.js dispatches 42_CAMPUS_DETECTED; the
 *    extension stores the campus and mounts its Clusters button).
 *
 * 2. The "React app": only the parts of the Intra v3 DOM that Cuter Intra
 *    hooks into, with the exact classes its selectors expect:
 *    - the sidebar main group: <a href="https://profile-v3.intra.42.fr">
 *      inside div.flex.flex-col.w-full (hubSettings.ts findSidebarMainGroup),
 *      the bottom group (div.flex.flex-col.w-full.pb-16) and the slots link
 *      (profile/shortcuts.ts);
 *    - the profile card: p[class="text-sm"] (the login line) inside
 *      .flex.flex-col.lg:flex-row, whose parent is the card (profile-card.ts
 *      findProfileCard), with the seat pill and the stats row;
 *    - the avatar div.rounded-full.w-52.h-52 (AVATAR_SELECTOR), the banner,
 *      the background and the title badge (core/intra/selectors.ts);
 *    - the nav avatar img.aspect-square.h-full.w-full from cdn.intra.42.fr
 *      (visuals.ts) and three dashboard cards (.bg-white.md:h-96).
 *
 * The server replaces __LOGIN__ and __APP_DELAY__: a delay <= 0 renders the
 * app synchronously when the module runs, N > 0 after setTimeout(N).
 */
// Created by the preload script (instrument.js); a bare object otherwise.
const S = window.__smoke || (window.__smoke = { app: {}, marks: {} });
const LOGIN = "__LOGIN__";
const DELAY = __APP_DELAY__;
const now = () => performance.now();
const isNative = (fn) => /\[native code\]/.test(Function.prototype.toString.call(fn));
const read = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return "(sessionStorage threw)";
  }
};

/* ------------------------------------------------- login + API client -- */

const API = "https://intrapy.intra.42.fr/api/v1";
const TOKEN_URL = "https://auth.42.fr/auth/realms/students-42/protocol/openid-connect/token";

S.app.moduleAt = now();
// Information only: on a fast warm reload the bundle (cached, deferred) can
// start before the asynchronously loaded hook.js has run.
S.app.fetchWrappedAtModule = !isNative(window.fetch);
S.api = { startedAt: now() };

/** keycloak-js uses XMLHttpRequest, which hook.js does not watch. */
function keycloakLogin() {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", TOKEN_URL);
    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText).access_token);
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error("token request failed"));
    xhr.send("grant_type=authorization_code&client_id=intra-v3&code=smoke");
  });
}

keycloakLogin()
  .then((jwt) => {
    window.keycloak = { token: jwt, authenticated: true };
    const auth = `Bearer ${jwt}`;
    const get = (path) => fetch(API + path, { headers: { Authorization: auth } });
    S.api.token = auth;
    S.api.loggedInAt = now();
    S.api.fetchWrappedAtFirstRequest = !isNative(window.fetch);
    return get("/users/me").then((r) => {
      S.api.meStatus = r.status;
      S.api.meAt = now();
      // hook.js stores the header before it hands the response back.
      S.api.tokenStoredAfterFirstFetch = read("ft_intrapy_token");
      return Promise.all([
        get(`/users/${LOGIN}/locations_stats`),
        get(`/users/${LOGIN}/projects/marked?cursus_id=21`),
        get(`/users/${LOGIN}/campus`),
      ]);
    });
  })
  .then(() => {
    S.api.doneAt = now();
    S.api.cursusStored = read("ft_active_cursus_id");
  })
  .catch((e) => {
    S.api.error = String(e);
    S.api.doneAt = now();
  });

/* ------------------------------------------------------------- the app -- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "25");
  svg.setAttribute("height", "25");
  svg.setAttribute("viewBox", "0 0 24 24");
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", "12");
  c.setAttribute("cy", "12");
  c.setAttribute("r", "9");
  c.setAttribute("fill", "currentColor");
  svg.append(c);
  return svg;
}

const navLink = (href) =>
  h("a", { href, class: "py-5 w-full flex justify-center hover:opacity-100 opacity-40" }, icon());

const card = (title, ...rows) =>
  h(
    "div",
    { class: "bg-white md:h-96 rounded-lg p-4 flex flex-col overflow-auto" },
    h("span", { class: "font-bold uppercase text-sm", text: title }),
    ...rows,
  );

function render() {
  const sidebar = h(
    "div",
    { class: "fixed left-0 top-0 h-screen w-16 flex flex-col justify-between items-center bg-ft-gray" },
    h(
      "div",
      { class: "flex flex-col w-full" },
      navLink("https://profile-v3.intra.42.fr"),
      navLink("https://projects.intra.42.fr"),
      navLink("https://profile.intra.42.fr/slots"),
      navLink("https://meta.intra.42.fr"),
    ),
    h("div", { class: "flex flex-col w-full pb-16" }, navLink("https://profile.intra.42.fr/users/me/edit")),
  );

  const header = h(
    "div",
    { class: "flex justify-end items-center h-16 px-4" },
    h(
      "div",
      { class: "w-10 h-10 rounded-full overflow-hidden" },
      h("img", {
        class: "aspect-square h-full w-full",
        src: `https://cdn.intra.42.fr/users/small_${LOGIN}.png`,
        alt: LOGIN,
      }),
    ),
  );

  const profileCard = h(
    "div",
    { class: "relative border-neutral-600 bg-ft-gray/50 rounded-lg p-6" },
    h("div", {
      class: "absolute px-2 py-1 border rounded-full border-neutral-600 bg-ft-gray top-2 right-4",
      text: "unavailable",
    }),
    h(
      "div",
      { class: "flex flex-col lg:flex-row gap-6 md:gap-8" },
      h("div", {
        class: "rounded-full w-52 h-52 bg-center bg-cover",
        style: `background-image: url("https://cdn.intra.42.fr/users/large_${LOGIN}.png")`,
      }),
      h(
        "div",
        { class: "flex flex-col gap-2" },
        h("h2", { class: "text-2xl", text: "Smoke Test" }),
        h("p", { class: "text-sm", text: LOGIN }),
        h("span", { class: "text-primary-foreground inline-flex rounded px-2", text: "Smoke tester" }),
      ),
    ),
    h(
      "div",
      { class: "flex gap-4 border-t border-t-neutral-600 pt-4 mt-4" },
      h("div", {}, h("b", { text: "Wallet" }), h("span", { text: "42 ₳" })),
      h("div", {}, h("b", { text: "Evaluation points" }), h("span", { text: "3" })),
    ),
  );

  const main = h(
    "main",
    { class: "ml-16 flex flex-col gap-4 p-4" },
    header,
    h("div", { class: "w-full xl:h-72 bg-center bg-cover bg-ft-black" }),
    profileCard,
    h(
      "div",
      { class: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      card("Logtime"),
      card("Evaluations"),
      card("Achievements", h("div", { class: "grid grid-cols-3" })),
    ),
  );

  document.getElementById("root").append(h("div", { class: "flex min-h-screen" }, sidebar, main));
  S.app.renderedAt = now();
}

if (DELAY > 0) setTimeout(render, DELAY);
else render();
