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

  // --- デバッグ: ページ上の全ボタンをダンプ ---

  function debugDumpButtons() {
    const buttons = document.querySelectorAll('button, [role="button"]');
    log(`===== ページ上のボタン一覧 (${buttons.length}個) =====`);
    buttons.forEach((btn, i) => {
      const info = {
        index: i,
        tag: btn.tagName,
        ariaLabel: btn.getAttribute("aria-label"),
        dataTooltip: btn.getAttribute("data-tooltip"),
        title: btn.getAttribute("title"),
        text: btn.textContent.trim().substring(0, 50),
        className: btn.className.substring(0, 80),
        rect: btn.getBoundingClientRect(),
      };
      // 画面下部 (Y > 画面高さの70%) にあるボタンのみ詳細出力
      if (info.rect.top > window.innerHeight * 0.6) {
        console.log(`${LOG_PREFIX} ボタン[${i}]:`, JSON.stringify(info, null, 2));
      }
    });
    log("===== ダンプ終了 =====");
  }

  function debugDumpMenuItems() {
    log("===== 表示中のメニュー項目 =====");
    const selectors = [
      'li', '[role="menuitem"]', '[role="option"]',
      '[role="menuitemradio"]', '[role="listitem"]',
    ];
    const seen = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const text = el.textContent.trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          console.log(`${LOG_PREFIX} メニュー項目 [${sel}]:`, text);
        }
      });
    }
    // ポップアップ/オーバーレイ内の要素も探す
    document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]').forEach((container) => {
      console.log(`${LOG_PREFIX} メニューコンテナ:`, container.tagName, container.getAttribute("role"), container.innerHTML.substring(0, 500));
    });
    log("===== メニューダンプ終了 =====");
  }

  // --- 要素検索 ---

  function findButtonByAttributes(labels) {
    for (const label of labels) {
      const lower = label.toLowerCase();
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
        const tooltip = (btn.getAttribute("data-tooltip") || "").toLowerCase();
        const title = (btn.getAttribute("title") || "").toLowerCase();
        if (ariaLabel.includes(lower) || tooltip.includes(lower) || title.includes(lower)) {
          return btn;
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
    const leaveButton = findButtonByAttributes([
      "通話から退出", "Leave call",
    ]);
    if (leaveButton) return true;

    const micButton = findButtonByAttributes([
      "マイクをオフ", "マイクをオン",
      "Turn off microphone", "Turn on microphone",
    ]);
    if (micButton) return true;

    return false;
  }

  // --- 録画操作 ---

  /**
   * 縦3点 (⋮) ボタンを探す。
   * 複数の方法で検索し、見つからない場合はデバッグ情報を出力。
   */
  async function findMoreOptionsButton() {
    let btn = null;

    // 方法1: aria-label / data-tooltip / title 属性
    btn = findButtonByAttributes([
      "その他のオプション",
      "その他",
      "More options",
    ]);
    if (btn) { log("方法1 (属性) で3点ボタンを発見"); return btn; }

    // 方法2: material icon "more_vert" テキスト
    const icons = document.querySelectorAll("i, span");
    for (const icon of icons) {
      if (icon.textContent.trim() === "more_vert") {
        btn = icon.closest("button") || icon.closest('[role="button"]');
        if (btn) { log("方法2 (more_vert アイコン) で3点ボタンを発見"); return btn; }
      }
    }

    // 方法3: 退出ボタンの近くにあるボタンを探す
    // 退出ボタン (赤い電話ボタン) を基準に、その直前のボタンが3点メニュー
    const leaveBtn = findButtonByAttributes([
      "通話から退出", "Leave call",
    ]);
    if (leaveBtn) {
      const leaveRect = leaveBtn.getBoundingClientRect();
      const candidates = [];
      const allButtons = document.querySelectorAll('button, [role="button"]');
      for (const b of allButtons) {
        if (b === leaveBtn) continue;
        const r = b.getBoundingClientRect();
        // 同じ行（Y座標が近い）で、退出ボタンの左側にあるボタン
        if (Math.abs(r.top - leaveRect.top) < 30 && r.right < leaveRect.left && r.right > leaveRect.left - 200) {
          candidates.push({ btn: b, distance: leaveRect.left - r.right });
        }
      }
      // 退出ボタンに最も近いボタンを選択
      candidates.sort((a, b) => a.distance - b.distance);
      if (candidates.length > 0) {
        log(`方法3 (退出ボタン隣接) で3点ボタン候補を発見 (距離: ${candidates[0].distance.toFixed(0)}px)`);
        return candidates[0].btn;
      }
    }

    // 方法4: 画面下部の右寄りにある小さめのボタンを探す
    // 3点ボタンはアイコンのみで、テキストが空または非常に短い
    const allButtons = document.querySelectorAll('button, [role="button"]');
    const bottomRight = [];
    for (const b of allButtons) {
      const r = b.getBoundingClientRect();
      const screenW = window.innerWidth;
      const screenH = window.innerHeight;
      // 画面下部20%、中央〜右寄り
      if (r.top > screenH * 0.8 && r.left > screenW * 0.4 && r.left < screenW * 0.8) {
        const text = b.textContent.trim();
        const ariaLabel = b.getAttribute("aria-label") || "";
        // テキストが空かアイコンテキストのみ
        if (text.length <= 15 && !ariaLabel.includes("マイク") && !ariaLabel.includes("カメラ")) {
          bottomRight.push({ btn: b, x: r.left, label: ariaLabel, text });
        }
      }
    }
    // X座標が大きい（右寄り）順にソート、退出ボタン以外で最も右のもの
    bottomRight.sort((a, b) => b.x - a.x);
    for (const item of bottomRight) {
      if (!item.label.includes("退出") && !item.label.includes("Leave")) {
        log(`方法4 (位置ベース) で候補発見: label="${item.label}", text="${item.text}"`);
        return item.btn;
      }
    }

    return null;
  }

  async function openMoreOptionsMenu() {
    log("縦3点メニューボタンを探しています...");

    // デバッグ: 全ボタンの情報を出力
    debugDumpButtons();

    const moreButton = await waitForElement(findMoreOptionsButton, 8000, 1000);

    log("3点メニューボタンをクリックします...");
    moreButton.click();
    await sleep(1500);
  }

  async function clickRecordingMenuItem() {
    log("録画メニュー項目を探しています...");

    // デバッグ: メニュー項目をダンプ
    debugDumpMenuItems();

    const menuItem = await waitForElement(() => {
      // 非常に広いセレクタで検索
      return findElementByText(
        'li, [role="menuitem"], [role="option"], [role="menuitemradio"], [role="listitem"], div[tabindex], span[tabindex]',
        [
          "録画を管理する",
          "録画を管理",
          "ミーティングを録画",
          "Manage recording",
          "Record meeting",
          "Recording",
        ]
      );
    }, 8000);

    if (!menuItem) {
      // もう一度ダンプしてから失敗
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
      return findButtonByAttributes(["録画を開始", "Start recording"]);
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
          "開始",
          "Start",
          "同意して録画",
          "Agree and record",
          "了解",
          "OK",
          "Accept",
        ]);
      }, 5000);

      if (confirmButton) {
        log("確認ダイアログの「開始」をクリックします");
        confirmButton.click();
        await sleep(1000);
      }
    } catch {
      log("確認ダイアログは表示されませんでした（不要の場合あり）");
    }
  }

  function isAlreadyRecording() {
    const stopButton = findButtonByAttributes(["録画を停止", "Stop recording"]);
    if (stopButton) return true;

    const recordingDot = document.querySelector(
      '[data-recording-indicator], [aria-label*="Recording"]'
    );
    if (recordingDot) return true;

    return false;
  }

  // --- メインフロー ---

  async function startRecording() {
    if (!isEnabled) {
      log("自動録画は無効です");
      return;
    }
    if (hasAttemptedRecording) {
      log("既に録画開始を試行済みです");
      return;
    }
    if (isAlreadyRecording()) {
      log("既に録画中です");
      hasAttemptedRecording = true;
      return;
    }

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
      chrome.runtime.sendMessage({
        type: "RECORDING_STATUS",
        status: "failed",
        error: error.message,
      });
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
      log(`自動録画設定が変更されました: ${isEnabled ? "有効" : "無効"}`);
    }
  });

  // --- メッセージ受信 ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_STATUS") {
      sendResponse({
        isEnabled,
        meetingDetected,
        hasAttemptedRecording,
        isRecording: isAlreadyRecording(),
      });
    } else if (message.type === "TOGGLE_ENABLED") {
      isEnabled = message.enabled;
      chrome.storage.sync.set({ autoRecordEnabled: isEnabled });
      sendResponse({ isEnabled });
    } else if (message.type === "RETRY_RECORDING") {
      hasAttemptedRecording = false;
      startRecording();
      sendResponse({ status: "retrying" });
    } else if (message.type === "DEBUG_DUMP") {
      debugDumpButtons();
      debugDumpMenuItems();
      sendResponse({ status: "dumped" });
    }
    return true;
  });

  // --- 初期化 ---

  function init() {
    if (!window.location.href.match(/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i)) {
      log("ミーティングページではないためスキップします");
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
