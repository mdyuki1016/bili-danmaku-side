(() => {
  const EXT_ID = "bili-dm-side";
  const ROOT_ID = "bili-dm-side-root";

  let rafId = null;
  let currentUrl = location.href;
  let abortCtrl = null;
  let uiCache = null;
  let mountObserver = null;
  let syncTimer = null;
  let videoSwitchTimer = null;
  let boundVideo = null;

  const defaultSettings = {
    enabled: true,
    fontSize: 14,
    theme: "light"
  };

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(defaultSettings, (items) => {
          resolve({
            enabled: Boolean(items.enabled),
            fontSize: Number(items.fontSize) || defaultSettings.fontSize,
            theme: items.theme === "dark" ? "dark" : "light"
          });
        });
      } catch {
        resolve({ ...defaultSettings });
      }
    });
  }

  function saveSettings(settings) {
    try {
      chrome.storage.local.set(settings);
    } catch {
      // no-op
    }
  }

  function getCidFromState() {
    try {
      const state = window.__INITIAL_STATE__;
      if (state) {
        if (state.videoData && state.videoData.cid) return String(state.videoData.cid);
        if (state.epInfo && state.epInfo.cid) return String(state.epInfo.cid);
        if (state.episodeInfo && state.episodeInfo.cid) return String(state.episodeInfo.cid);
        if (state.epList && state.epList.length && state.epList[0].cid) return String(state.epList[0].cid);
      }
    } catch {
      // ignore
    }
    return null;
  }

  function getCidFromScripts() {
    const scripts = Array.from(document.scripts || []);
    for (const s of scripts) {
      const text = s.textContent || "";
      const m = text.match(/"cid"\s*:\s*(\d+)/);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  function getCid() {
    return getCidFromState() || getCidFromScripts();
  }

  function getBvidFromUrl() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  }

  function getEpIdFromUrl() {
    const m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/);
    return m ? m[1] : null;
  }

  function getSeasonIdFromUrl() {
    const m = location.pathname.match(/\/bangumi\/play\/ss(\d+)/);
    return m ? m[1] : null;
  }

  async function fetchCidByBvid(bvid) {
    const p = Number(new URLSearchParams(location.search).get("p") || 1);
    const url = `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}&jsonp=jsonp`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    const list = (data && data.data) || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const idx = Math.max(0, Math.min(list.length - 1, p - 1));
    return list[idx].cid ? String(list[idx].cid) : null;
  }

  async function fetchCidByEpOrSeason(epId, seasonId) {
    const qs = epId ? `ep_id=${epId}` : `season_id=${seasonId}`;
    if (!qs) return null;
    const url = `https://api.bilibili.com/pgc/view/web/season?${qs}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    const eps = data && data.result && data.result.episodes;
    if (!Array.isArray(eps) || eps.length === 0) return null;
    if (epId) {
      const hit = eps.find((e) => String(e.id) === String(epId));
      if (hit && hit.cid) return String(hit.cid);
    }
    return eps[0].cid ? String(eps[0].cid) : null;
  }

  async function resolveCid(maxWaitMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const cid = getCid();
      if (cid) return cid;
      await new Promise((r) => setTimeout(r, 200));
    }

    const bvid = getBvidFromUrl();
    if (bvid) {
      const cid = await fetchCidByBvid(bvid);
      if (cid) return cid;
    }

    const epId = getEpIdFromUrl();
    const seasonId = getSeasonIdFromUrl();
    if (epId || seasonId) {
      const cid = await fetchCidByEpOrSeason(epId, seasonId);
      if (cid) return cid;
    }

    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  function getBestVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (!isVisible(v)) continue;
      if (area <= 0) continue;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best || videos[0];
  }

  function readCurrentTime(video) {
    if (!video) return 0;
    const t = Number(video.currentTime);
    if (Number.isFinite(t) && t > 0) return t;
    try {
      const p = window.player;
      if (p && typeof p.getCurrentTime === "function") {
        const pt = Number(p.getCurrentTime());
        if (Number.isFinite(pt) && pt >= 0) return pt;
      }
    } catch {
      // ignore
    }
    return Number.isFinite(t) ? t : 0;
  }

  function findDanmakuListElement() {
    const selectors = [
      "#danmaku-box",
      "#danmukuBox",
      ".danmaku-box",
      ".danmu-box",
      ".danmaku",
      ".dm-list",
      ".danmu-list",
      "[data-danmaku]",
      "[data-danmu]",
      "[aria-label*=\"弹幕\"]",
      "[class*=\"danmaku\"]",
      "[class*=\"danmu\"]"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findDanmakuHeaderElement() {
    const nodes = Array.from(document.querySelectorAll("div,span,li,button,a"));
    for (const el of nodes) {
      const text = (el.textContent || "").trim();
      if (text === "弹幕列表" && isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  function findEmbedContainer() {
    const listEl = findDanmakuListElement();
    if (listEl && listEl.parentElement && isVisible(listEl)) {
      return { type: "before-list", anchor: listEl };
    }

    const headerEl = findDanmakuHeaderElement();
    if (headerEl && headerEl.parentElement) {
      const container =
        headerEl.closest(".bui-tabs") ||
        headerEl.closest(".tabs") ||
        headerEl.closest("[class*=\"tab\"]") ||
        headerEl.parentElement;
      if (container && container.parentElement) {
        return { type: "before-list", anchor: container };
      }
    }

    const selectors = [
      "#right-container",
      ".right-container",
      ".video-info-container",
      ".right-column",
      ".recommend-list",
      ".rec-list",
      ".bpx-player-right",
      ".bili-layout__column--right"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return { type: "prepend", anchor: el };
    }
    return null;
  }

  function mountRoot(root) {
    const embed = findEmbedContainer();
    if (embed && embed.type === "before-list") {
      root.classList.remove("is-overlay");
      root.classList.add("is-embedded");
      if (embed.anchor.parentElement) {
        embed.anchor.parentElement.insertBefore(root, embed.anchor);
      }
      return true;
    }
    if (embed && embed.type === "prepend") {
      root.classList.remove("is-overlay");
      root.classList.add("is-embedded");
      embed.anchor.prepend(root);
      return true;
    }
    root.classList.remove("is-embedded");
    root.classList.add("is-overlay");
    document.documentElement.appendChild(root);
    return false;
  }

  function createUI(settings) {
    const root = document.createElement("div");
    root.id = ROOT_ID;

    const panel = document.createElement("div");
    panel.id = `${EXT_ID}-panel`;

    const header = document.createElement("div");
    header.className = `${EXT_ID}-header`;

    const title = document.createElement("div");
    title.className = `${EXT_ID}-title`;
    title.textContent = "弹幕时间轴";

    const controls = document.createElement("div");
    controls.className = `${EXT_ID}-controls`;

    const themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.className = `${EXT_ID}-theme`;
    themeBtn.textContent = settings.theme === "dark" ? "Dark" : "Light";
    themeBtn.addEventListener("click", () => {
      settings.theme = settings.theme === "dark" ? "light" : "dark";
      themeBtn.textContent = settings.theme === "dark" ? "Dark" : "Light";
      panel.dataset.theme = settings.theme;
      saveSettings(settings);
    });

    const fontLabel = document.createElement("label");
    fontLabel.textContent = "字号";
    const fontInput = document.createElement("input");
    fontInput.type = "range";
    fontInput.min = "12";
    fontInput.max = "24";
    fontInput.value = String(settings.fontSize);
    fontInput.addEventListener("input", () => {
      const val = Number(fontInput.value) || defaultSettings.fontSize;
      panel.style.setProperty("--dm-font-size", `${val}px`);
      saveSettings({ ...settings, fontSize: val });
      settings.fontSize = val;
    });

    fontLabel.appendChild(fontInput);
    controls.appendChild(fontLabel);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = `${EXT_ID}-toggle`;
    toggleBtn.textContent = "显示";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = `${EXT_ID}-close`;
    closeBtn.textContent = "×";

    header.appendChild(title);
    header.appendChild(controls);
    header.appendChild(toggleBtn);
    header.appendChild(closeBtn);

    const list = document.createElement("div");
    list.className = `${EXT_ID}-list`;

    const status = document.createElement("div");
    status.className = `${EXT_ID}-status`;
    status.textContent = "加载弹幕中…";

    list.appendChild(status);

    panel.appendChild(header);
    panel.appendChild(list);

    root.appendChild(panel);

    mountRoot(root);

    panel.style.setProperty("--dm-font-size", `${settings.fontSize}px`);
    panel.dataset.theme = settings.theme;

    function setEnabled(enabled) {
      settings.enabled = enabled;
      saveSettings(settings);
      panel.classList.toggle("is-hidden", !enabled);
      toggleBtn.textContent = enabled ? "隐藏" : "显示";
    }

    toggleBtn.addEventListener("click", () => setEnabled(!settings.enabled));
    closeBtn.addEventListener("click", () => setEnabled(false));

    setEnabled(settings.enabled);

    controls.appendChild(themeBtn);
    return { root, panel, list, status, settings, setEnabled };
  }

  function ensureUI(settings) {
    if (uiCache && uiCache.root && uiCache.root.isConnected) {
      uiCache.settings.enabled = settings.enabled;
      uiCache.settings.fontSize = settings.fontSize;
      uiCache.panel.style.setProperty("--dm-font-size", `${settings.fontSize}px`);
      uiCache.setEnabled(settings.enabled);
      return uiCache;
    }
    uiCache = createUI(settings);
    return uiCache;
  }

  function startMountObserver(root) {
    if (mountObserver) mountObserver.disconnect();
    mountObserver = new MutationObserver(() => {
      if (!root.isConnected) {
        mountRoot(root);
      }
    });
    mountObserver.observe(document.body, { childList: true, subtree: true });
  }

  async function fetchDanmaku(cid) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    const endpoints = [
      `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
      `https://comment.bilibili.com/${cid}.xml`
    ];
    let xmlText = "";
    let lastStatus = 0;
    let lastErr = null;

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          signal: abortCtrl.signal,
          credentials: "include",
          referrer: location.href,
          headers: {
            Accept: "text/xml,application/xml,text/plain,*/*"
          }
        });
        if (!res.ok) {
          lastStatus = res.status;
          continue;
        }
        xmlText = await res.text();
        if (xmlText && xmlText.includes("<d")) break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!xmlText) {
      if (lastErr) throw lastErr;
      throw new Error(`弹幕接口失败: ${lastStatus || "unknown"}`);
    }

    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const nodes = Array.from(doc.querySelectorAll("d"));

    const items = nodes
      .map((node) => {
        const p = node.getAttribute("p") || "";
        const time = parseFloat(p.split(",")[0]) || 0;
        const text = (node.textContent || "").trim();
        return { time, text };
      })
      .filter((it) => it.text.length > 0)
      .sort((a, b) => a.time - b.time);

    return items;
  }

  function renderDanmaku(listEl, items) {
    listEl.innerHTML = "";
    for (const it of items) {
      const row = document.createElement("div");
      row.className = `${EXT_ID}-item`;
      row.dataset.time = String(it.time);

      const time = document.createElement("span");
      time.className = `${EXT_ID}-time`;
      time.textContent = formatTime(it.time);

      const text = document.createElement("span");
      text.className = `${EXT_ID}-text`;
      text.textContent = it.text;

      row.appendChild(time);
      row.appendChild(text);
      listEl.appendChild(row);
    }
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function findIndexByTime(times, t) {
    let lo = 0;
    let hi = times.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function startSync(video, listEl, settings) {
    if (video.__biliDmSideHandlers) {
      const h = video.__biliDmSideHandlers;
      video.removeEventListener("timeupdate", h.onTimeUpdate);
      video.removeEventListener("seeking", h.onSeeking);
      video.removeEventListener("play", h.onPlay);
      delete video.__biliDmSideHandlers;
    }
    const items = Array.from(listEl.querySelectorAll(`.${EXT_ID}-item`));
    const times = items.map((el) => Number(el.dataset.time) || 0);
    let lastIndex = -1;
    let lastTime = -1;

    const jumpToTime = (t) => {
      const idx = findIndexByTime(times, t);
      if (idx < 0 || !items[idx]) return;
      if (lastIndex >= 0 && items[lastIndex]) {
        items[lastIndex].classList.remove("is-current");
      }
      const el = items[idx];
      el.classList.add("is-current");
      const top = el.offsetTop - listEl.clientHeight * 0.3;
      listEl.scrollTo({ top: Math.max(0, top), behavior: "auto" });
      lastIndex = idx;
      lastTime = t;
    };

    const tick = () => {
      if (!settings.enabled) return;
      if (!video || video.readyState < 1) return;

      const t = readCurrentTime(video);
      if (Math.abs(t - lastTime) < 0.05) return;
      lastTime = t;
      const idx = findIndexByTime(times, t);
      if (idx === lastIndex) return;

      if (lastIndex >= 0 && items[lastIndex]) {
        items[lastIndex].classList.remove("is-current");
      }
      if (idx >= 0 && items[idx]) {
        const el = items[idx];
        el.classList.add("is-current");
        const top = el.offsetTop - listEl.clientHeight * 0.3;
        listEl.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
      lastIndex = idx;
    };

    const onTimeUpdate = () => tick();
    const onSeeking = () => tick();
    const onSeeked = () => jumpToTime(readCurrentTime(video));
    const onLoadedMeta = () => jumpToTime(readCurrentTime(video));
    const onPlay = () => {
      jumpToTime(readCurrentTime(video));
      tick();
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMeta);
    video.addEventListener("play", onPlay);
    video.__biliDmSideHandlers = {
      onTimeUpdate,
      onSeeking,
      onSeeked,
      onLoadedMeta,
      onPlay
    };

    syncTimer = setInterval(() => {
      if (video !== boundVideo) return;
      tick();
    }, 200);

    // One-shot initial align; avoid repeated forced jumps on first load.
    setTimeout(() => {
      if (video === boundVideo) {
        jumpToTime(readCurrentTime(video));
      }
    }, 350);
  }

  function cleanup() {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    if (videoSwitchTimer) clearInterval(videoSwitchTimer);
    videoSwitchTimer = null;
    if (boundVideo && boundVideo.__biliDmSideHandlers) {
      const h = boundVideo.__biliDmSideHandlers;
      boundVideo.removeEventListener("timeupdate", h.onTimeUpdate);
      boundVideo.removeEventListener("seeking", h.onSeeking);
      boundVideo.removeEventListener("seeked", h.onSeeked);
      boundVideo.removeEventListener("loadedmetadata", h.onLoadedMeta);
      boundVideo.removeEventListener("play", h.onPlay);
      delete boundVideo.__biliDmSideHandlers;
    }
    boundVideo = null;
  }

  async function init() {
    cleanup();

    const settings = await loadSettings();
    const ui = ensureUI(settings);
    mountRoot(ui.root);
    startMountObserver(ui.root);
    let video = getBestVideo();

    if (!video) {
      ui.status.textContent = "未找到视频元素";
      return;
    }

    boundVideo = video;
    const cid = await resolveCid();
    if (!cid) {
      ui.status.textContent = "未找到 cid（尝试切换分P或刷新）";
      return;
    }

    try {
      const items = await fetchDanmaku(cid);
      if (!items.length) {
        ui.status.textContent = "弹幕为空";
        return;
      }
      renderDanmaku(ui.list, items);
      startSync(video, ui.list, ui.settings);
      let lastCandidate = boundVideo;
      let stableHit = 0;
      videoSwitchTimer = setInterval(() => {
        const v = getBestVideo();
        if (v && v !== boundVideo) {
          if (v === lastCandidate) {
            stableHit += 1;
          } else {
            lastCandidate = v;
            stableHit = 1;
          }
          if (stableHit >= 2) {
            boundVideo = v;
            startSync(v, ui.list, ui.settings);
            stableHit = 0;
            lastCandidate = v;
          }
        } else {
          lastCandidate = boundVideo;
          stableHit = 0;
        }
      }, 1000);
    } catch (err) {
      ui.status.textContent = "弹幕加载失败";
      console.warn("[bili-dm-side] fetch failed", err);
    }
  }

  function watchUrlChanges() {
    setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        setTimeout(init, 800);
      }
    }, 800);
  }

  function waitForPlayer() {
    let tries = 0;
    const timer = setInterval(() => {
      const video = document.querySelector("video");
      if (video) {
        clearInterval(timer);
        init();
      } else if (tries++ > 30) {
        clearInterval(timer);
        init();
      }
    }, 500);
  }

  function start() {
    waitForPlayer();
    watchUrlChanges();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
