/**
 * Google Meet Auto Record - Content Script
 *
 * ミーティング参加を検知し、自動で録画を開始する。
 */

(function () {
  "use strict";

  const LOG_PREFIX = "[Meet Auto Record]";
  const POLL_INTERVAL_MS = 2000;
  const MAX_RETRY = 30;

  let isEnabled = true;
  let hasAttemptedRecording = false;
  let meetingDetected = false;

  // --- ユーティリティ ---

  function log(msg) {
    console.log(`${LOG_PREFIX} ${msg}`);
  }

  function warn(msg) {
    console.warn(`${LOG_PREFIX} ${msg}`);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForElement(finder, timeoutMs = 10000, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const el = finder();
        if (el) {
          clearInterval(timer);
          resolve(el);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("要素が見つかりませんでした (タイムアウト)"));
        }
      }, intervalMs);
    });
  }

  // --- デバッグ ---

  /**
   * ツールバー付近の全インタラクティブ要素をダンプ。
   * button / role=button だけでなく、data-tooltip を持つ要素や
   * 画面下部のクリック可能な要素を全て出力する。
   */
  function debugDumpToolbar() {
    log("===== ツールバー要素ダンプ =====");

    // data-tooltip を持つ全要素
    const tooltipEls = document.querySelectorAll("[data-tooltip]");
    log(`data-tooltip 付き要素: ${tooltipEls.length}個`);
    tooltipEls.forEach((el, i) => {
      console.log(`${LOG_PREFIX} [tooltip ${i}]`, {
        tag: el.tagName,
        role: el.getAttribute("role"),
        ariaLabel: el.getAttribute("aria-label"),
        dataTooltip: el.getAttribute("data-tooltip"),
        text: el.textContent.trim().substring(0, 40),
        rect: el.getBoundingClientRect(),
      });
    });

    // 画面下部 30% の全クリック可能要素
    const allEls = document.querySelectorAll("*");
    const screenH = window.innerHeight;
    const threshold = screenH * 0.7;
    let count = 0;
    allEls.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top > threshold && r.width > 20 && r.width < 80 && r.height > 20 && r.height < 80) {
        const style = window.getComputedStyle(el);
        if (style.cursor === "pointer" || el.getAttribute("role") || el.tagName === "BUTTON") {
          console.log(`${LOG_PREFIX} [底部要素 ${count}]`, {
            tag: el.tagName,
            role: el.getAttribute("role"),
            ariaLabel: el.getAttribute("aria-label"),
            dataTooltip: el.getAttribute("data-tooltip"),
            text: el.textContent.trim().substring(0, 40),
            x: Math.round(r.left),
            y: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
          count++;
        }
      }
    });
    log(`底部クリック可能要素: ${count}個`);
    log("===== ダンプ終了 =====");
  }

  function debugDumpMenuItems() {
    log("===== メニュー項目ダンプ =====");
    const items = document.querySelectorAll(
      'li, [role="menuitem"], [role="option"], [role="menuitemradio"], [role="listitem"]'
    );
    const seen = new Set();
    items.forEach((el) => {
      const text = el.textContent.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        console.log(`${LOG_PREFIX} メニュー:`, text.substring(0, 80));
      }
    });
    log("===== ダンプ終了 =====");
  }

  // --- 要素検索 ---

  /**
   * data-tooltip / aria-label / title を部分一致で検索。
   * button や role=button に限定せず、全要素を対象にする。
   */
  function findElementByAttribute(labels, exactMatch = false) {
    for (const label of labels) {
      const lower = label.toLowerCase();
      // data-tooltip 持ちの要素を優先的に検索
      const candidates = document.querySelectorAll(
        '[data-tooltip], [aria-label], button, [role="button"]'
      );
      for (const el of candidates) {
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const tooltip = (el.getAttribute("data-tooltip") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();
        if (exactMatch) {
          if (ariaLabel === lower || tooltip === lower || title === lower) return el;
        } else {
          if (ariaLabel.includes(lower) || tooltip.includes(lower) || title.includes(lower)) return el;
        }
      }
    }
    return null;
  }

  function findElementByText(selector, texts) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const textContent = el.textContent.trim().toLowerCase();
      for (const text of texts) {
        if (textContent.includes(text.toLowerCase())) {
          return el;
        }
      }
    }
    return null;
  }

  // --- ミーティング参加検知 ---

  function isInMeeting() {
    if (findElementByAttribute(["通話から退出", "Leave call"])) return true;
    if (findElementByAttribute(["マイクをオフ", "マイクをオン", "Turn off microphone", "Turn on microphone"])) return true;
    return false;
  }

  // --- 録画操作 ---

  /**
   * 縦3点 (⋮) ボタンを探す。
   */
  function findMoreOptionsButton() {
    let btn = null;

    // 方法1: 完全一致で "その他のオプション" を検索
    // ※ "その他" だけだと "その他の参加方法" にヒットするため完全一致優先
    btn = findElementByAttribute(["その他のオプション", "More options"], true);
    if (btn) { log("方法1 (完全一致) で3点ボタンを発見"); return btn; }

    // 方法2: 部分一致 "その他のオプション" (完全一致で見つからなかった場合)
    btn = findElementByAttribute(["その他のオプション", "More options"], false);
    if (btn) { log("方法2 (部分一致) で3点ボタンを発見"); return btn; }

    // 方法3: material icon "more_vert" を含む要素
    const allEls = document.querySelectorAll("i, span, div");
    for (const el of allEls) {
      if (el.textContent.trim() === "more_vert") {
        // 親要素がクリック可能なら返す
        const parent = el.closest('[role="button"]') ||
                       el.closest("button") ||
                       el.closest('[data-tooltip]') ||
                       el.parentElement;
        if (parent) {
          log("方法3 (more_vert アイコン) で3点ボタンを発見");
          return parent;
        }
      }
    }

    // 方法4: マイクボタンと同じ Y 座標の行にある、
    // マイク/カメラ以外のボタンで右寄りのもの
    const micBtn = findElementByAttribute(["マイクをオフ", "マイクをオン"]);
    if (micBtn) {
      const micRect = micBtn.getBoundingClientRect();
      const candidates = [];

      // data-tooltip を持つ要素から、同じツールバー行にあるものを検索
      document.querySelectorAll("[data-tooltip]").forEach((el) => {
        const r = el.getBoundingClientRect();
        // 同じ行 (Y 座標が近い) で、マイクより右にあるもの
        if (
          Math.abs(r.top - micRect.top) < 20 &&
          r.left > micRect.left &&
          r.width > 10 && r.width < 100
        ) {
          const tooltip = el.getAttribute("data-tooltip") || "";
          const ariaLabel = el.getAttribute("aria-label") || "";
          // マイク/カメラ/背景は除外
          if (
            !tooltip.includes("マイク") && !tooltip.includes("カメラ") &&
            !tooltip.includes("背景") && !ariaLabel.includes("マイク") &&
            !ariaLabel.includes("カメラ") && !ariaLabel.includes("背景")
          ) {
            candidates.push({ el, x: r.left, tooltip, ariaLabel });
          }
        }
      });

      // 最も右にあるものが3点ボタンの可能性が高い
      candidates.sort((a, b) => b.x - a.x);
      if (candidates.length > 0) {
        const best = candidates[0];
        log(`方法4 (ツールバー行・右端) で候補発見: tooltip="${best.tooltip}", label="${best.ariaLabel}"`);
        return best.el;
      }
    }

    // 方法5: 画面下部全要素から cursor:pointer で more_vert っぽいものを探す
    const screenH = window.innerHeight;
    const bottomEls = document.querySelectorAll("*");
    for (const el of bottomEls) {
      const r = el.getBoundingClientRect();
      if (r.top > screenH * 0.8 && r.width > 20 && r.width < 80 && r.height > 20 && r.height < 80) {
        const text = el.textContent.trim();
        if (text === "more_vert" || text === "⋮") {
          const clickable = el.closest('[role="button"]') ||
                           el.closest("button") ||
                           el.closest('[data-tooltip]') ||
                           el;
          log(`方法5 (bottom more_vert) で発見`);
          return clickable;
        }
      }
    }

    return null;
  }

  async function openMoreOptionsMenu() {
    log("縦3点メニューボタンを探しています...");
    debugDumpToolbar();

    const moreButton = await waitForElement(findMoreOptionsButton, 10000, 1000);

    log(`3点メニューをクリック: tag=${moreButton.tagName}, tooltip="${moreButton.getAttribute("data-tooltip") || ""}", aria="${moreButton.getAttribute("aria-label") || ""}"`);
    moreButton.click();
    await sleep(1500);
  }

  async function clickRecordingMenuItem() {
    log("録画メニュー項目を探しています...");
    debugDumpMenuItems();

    const menuItem = await waitForElement(() => {
      return findElementByText(
        'li, [role="menuitem"], [role="option"], [role="menuitemradio"], [role="listitem"], div[tabindex], span[tabindex]',
        [
          "録画を管理する",
          "録画を管理",
          "録画をテスト",
          "ミーティングを録画",
          "Manage recording",
          "Record meeting",
          "Recording",
        ]
      );
    }, 8000);

    if (!menuItem) {
      debugDumpMenuItems();
      throw new Error("録画メニュー項目が見つかりません");
    }
    log(`録画メニュー項目「${menuItem.textContent.trim()}」をクリックします`);
    menuItem.click();
    await sleep(1500);
  }

  async function clickStartRecording() {
    log("「録画を開始」ボタンを探しています...");

    const startButton = await waitForElement(() => {
      const btn = findElementByText("button, [role='button'], span, div", [
        "録画を開始",
        "Start recording",
      ]);
      if (btn) return btn;
      return findElementByAttribute(["録画を開始", "Start recording"]);
    }, 8000);

    log("「録画を開始」ボタンをクリックします");
    startButton.click();
    await sleep(1500);
  }

  async function confirmRecordingDialog() {
    log("確認ダイアログを確認しています...");
    await sleep(1000);
    try {
      const confirmButton = await waitForElement(() => {
        return findElementByText("button, [role='button']", [
          "開始", "Start", "同意して録画", "Agree and record", "了解", "OK", "Accept",
        ]);
      }, 5000);
      if (confirmButton) {
        log("確認ダイアログをクリック");
        confirmButton.click();
        await sleep(1000);
      }
    } catch {
      log("確認ダイアログなし（不要の場合あり）");
    }
  }

  function isAlreadyRecording() {
    if (findElementByAttribute(["録画を停止", "Stop recording"])) return true;
    if (document.querySelector('[data-recording-indicator]')) return true;
    return false;
  }

  // --- メインフロー ---

  async function startRecording() {
    if (!isEnabled) { log("自動録画は無効です"); return; }
    if (hasAttemptedRecording) { log("既に試行済み"); return; }
    if (isAlreadyRecording()) { log("既に録画中"); hasAttemptedRecording = true; return; }

    hasAttemptedRecording = true;
    log("自動録画を開始します...");

    try {
      await openMoreOptionsMenu();
      await clickRecordingMenuItem();
      await clickStartRecording();
      await confirmRecordingDialog();
      log("録画の開始に成功しました！");
      chrome.runtime.sendMessage({ type: "RECORDING_STATUS", status: "started" });
    } catch (error) {
      warn(`録画の開始に失敗しました: ${error.message}`);
      hasAttemptedRecording = false;
      chrome.runtime.sendMessage({ type: "RECORDING_STATUS", status: "failed", error: error.message });
    }
  }

  // --- 監視ループ ---

  async function monitorMeeting() {
    log("ミーティング監視を開始します...");
    let retryCount = 0;

    const checkInterval = setInterval(async () => {
      if (!isEnabled) return;
      if (meetingDetected && hasAttemptedRecording) return;

      if (isInMeeting()) {
        if (!meetingDetected) {
          meetingDetected = true;
          log("ミーティングへの参加を検知しました！");
          await sleep(5000);
          await startRecording();
        }
      } else {
        retryCount++;
        if (retryCount > MAX_RETRY) {
          log("ミーティング検知のリトライ上限に達しました");
          clearInterval(checkInterval);
        }
      }
    }, POLL_INTERVAL_MS);

    window.addEventListener("beforeunload", () => {
      clearInterval(checkInterval);
      meetingDetected = false;
      hasAttemptedRecording = false;
    });
  }

  // --- 設定 ---

  function loadSettings() {
    chrome.storage.sync.get({ autoRecordEnabled: true }, (items) => {
      isEnabled = items.autoRecordEnabled;
      log(`自動録画: ${isEnabled ? "有効" : "無効"}`);
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.autoRecordEnabled) {
      isEnabled = changes.autoRecordEnabled.newValue;
      log(`設定変更: ${isEnabled ? "有効" : "無効"}`);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_STATUS") {
      sendResponse({ isEnabled, meetingDetected, hasAttemptedRecording, isRecording: isAlreadyRecording() });
    } else if (message.type === "TOGGLE_ENABLED") {
      isEnabled = message.enabled;
      chrome.storage.sync.set({ autoRecordEnabled: isEnabled });
      sendResponse({ isEnabled });
    } else if (message.type === "RETRY_RECORDING") {
      hasAttemptedRecording = false;
      startRecording();
      sendResponse({ status: "retrying" });
    } else if (message.type === "DEBUG_DUMP") {
      debugDumpToolbar();
      debugDumpMenuItems();
      sendResponse({ status: "dumped" });
    }
    return true;
  });

  // --- 初期化 ---

  function init() {
    if (!window.location.href.match(/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i)) {
      log("ミーティングページではないためスキップ");
      return;
    }
    log("初期化中...");
    loadSettings();
    monitorMeeting();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
