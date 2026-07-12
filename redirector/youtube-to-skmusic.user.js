// ==UserScript==
// @name         YouTube → SK Music Redirector
// @namespace    https://skmusic.shalomkarr.workers.dev/
// @version      1.0.0
// @description  Sends YouTube & YouTube Music — and their Techloq block pages — to the matching page on SK Music: videos → /song, playlists → /playlists, channels → /artists, anything else → home.
// @author       Shalom Karr
// @match        *://www.youtube.com/*
// @match        *://youtube.com/*
// @match        *://m.youtube.com/*
// @match        *://music.youtube.com/*
// @match        *://youtu.be/*
// @match        *://filter.techloq.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Shalom-Karr/SK-Music/main/redirector/youtube-to-skmusic.user.js
// @downloadURL  https://raw.githubusercontent.com/Shalom-Karr/SK-Music/main/redirector/youtube-to-skmusic.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Where everything gets sent.
  const SK = 'https://skmusic.shalomkarr.workers.dev';

  // A Techloq block page sometimes fills in the blocked URL a moment after it loads, so we poll for it.
  const TECHLOQ_MAX_TRIES = 1200;    // ~5 minutes at 250ms
  const TECHLOQ_INTERVAL_MS = 250;

  // Never act inside an iframe/embed. This is critical: SK Music plays audio through a youtube.com/embed
  // iframe, and this script @matches youtube.com — the guard is what stops it from redirecting (and
  // breaking) SK Music's own player.
  if (window.top !== window.self) return;

  const VIDEO_RE   = /(?:\/watch\?(?:.*&)?v=|\/(?:v|e|embed|shorts|live)\/|youtu\.be\/)([A-Za-z0-9_-]{11})/;
  const LIST_RE    = /[?&]list=([A-Za-z0-9_-]{10,})/;
  const CHANNEL_RE = /\/(?:channel|browse)\/(UC[A-Za-z0-9_-]{20,})/;
  const YT_HOST    = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/;

  // Map any YouTube / YouTube Music URL to the matching SK Music page (or home). Returns null if the URL
  // isn't a YouTube URL at all (used on Techloq pages to leave non-YouTube blocks alone).
  function skTarget(raw) {
    if (!raw) return null;
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (!YT_HOST.test(u.hostname)) return null;

    const path = u.pathname;
    const vid  = (raw.match(VIDEO_RE) || [])[1] || (path === '/watch' ? u.searchParams.get('v') : null);
    const list = (raw.match(LIST_RE) || [])[1];
    const chan = (raw.match(CHANNEL_RE) || [])[1];

    // A watch / short / embed page (or a youtu.be link) → the song — even if it also carries a &list=.
    const isWatch = path === '/watch' || u.hostname.indexOf('youtu.be') !== -1 || /^\/(shorts|embed|live|v|e)\//.test(path);
    if (vid && isWatch) return SK + '/song/' + vid;

    // A playlist page — or any bare list= with no video — → the playlist.
    if (list && (path === '/playlist' || !vid)) return SK + '/playlists/' + list;

    // A channel → the artist. Only /channel/UC… and /browse/UC… carry a usable channel id; @handles,
    // /c/name and /user/name don't, so those fall through to home.
    if (chan) return SK + '/artists/' + chan;

    // Home or anything else on YouTube → SK Music home.
    return SK + '/';
  }

  function go(target) {
    if (!target || target === location.href) return;
    try { window.stop(); } catch (e) {}   // halt YouTube before it finishes loading
    location.replace(target);             // replace, so Back doesn't bounce into the blocked page
  }

  // Pull the blocked URL out of a Techloq block page: the ?redirectUrl= query first, then the rendered
  // block link, then any YouTube URL in the page text as a last resort.
  function techloqBlockedUrl() {
    try {
      const r = new URLSearchParams(location.search).get('redirectUrl');
      if (r) return decodeURIComponent(r);
    } catch (e) {}
    const a = document.querySelector('div.block-url a, .block-url a, a[href*="youtube.com"], a[href*="youtu.be"]');
    if (a && a.href) return a.href;
    const text = (document.body && document.body.textContent) || '';
    const m = text.match(/https?:\/\/[^\s"'<>]*(?:youtube\.com|youtu\.be)[^\s"'<>]*/);
    return m ? m[0] : null;
  }

  let tries = 0;
  function techloqTick() {
    const target = skTarget(techloqBlockedUrl());
    if (target) { go(target); return; }                                  // only redirect YouTube blocks
    if (++tries < TECHLOQ_MAX_TRIES) setTimeout(techloqTick, TECHLOQ_INTERVAL_MS);
  }

  if (location.hostname.indexOf('filter.techloq.com') !== -1) {
    techloqTick();               // Techloq block page: find the blocked YouTube URL, then redirect
  } else {
    go(skTarget(location.href));  // on YouTube itself: redirect immediately
  }
})();
