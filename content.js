/**
 * Google Meet Auto Record - Content Script
 *
 * ミーティング参加を検知し、自動で録画を開始する。
 * Google Meet の DOM は動的クラス名を使用するため、
 * aria-label やテキスト内容で要素を特定する。
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

  /**
   * 指定セレクタまたは条件に一致する要素が現れるまで待機する。
   */
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

  /**
   * aria-label を部分一致で検索してボタンを取得する。
   * Google Meet は日本語/英語で aria-label が変わるため両方対応。
   */
  function findButtonByAriaLabel(labels) {
    for (const label of labels) {
      const buttons = document.querySelectorAll(
        `button[aria-label*="${label}"], [role="button"][aria-label*="${label}"]`
      );
      if (buttons.length > 0) return buttons[0];
    }
    return null;
  }

  /**
   * テキスト内容を含む要素を探す。
   */
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

  /**
   * ミーティングに参加しているか判定する。
   * 通話コントロールバー（マイク・カメラボタン等）が存在するかで判定。
   */
  function isInMeeting() {
    // 通話終了ボタンの存在チェック
    const leaveButton = findButtonByAriaLabel([
      "通話から退出",
      "Leave call",
      "Salir de la llamada",
    ]);
    if (leaveButton) return true;

    // 通話コントロールバーの存在チェック
    const controls = document.querySelector(
      '[data-call-controls="true"], [data-is-muted]'
    );
    if (controls) return true;

    // マイクボタンの存在チェック
    const micButton = findButtonByAriaLabel([
      "マイクをオフ",
      "マイクをオン",
      "Turn off microphone",
      "Turn on microphone",
    ]);
    if (micButton) return true;

    return false;
  }

  // --- 録画操作 ---

  /**
   * 「その他のオプション」メニューを開く
   */
  async function openMoreOptionsMenu() {
    log("「その他のオプション」メニューを開きます...");
    const moreButton = findButtonByAriaLabel([
      "その他のオプション",
      "More options",
      "Más opciones",
    ]);
    if (!moreButton) {
      throw new Error("「その他のオプション」ボタンが見つかりません");
    }
    moreButton.click();
    await sleep(1000);
  }

  /**
   * メニューから「録画」または「ミーティングを録画」を選択
   */
  async function clickRecordingMenuItem() {
    log("録画メニュー項目を探しています...");

    const menuItem = await waitForElement(() => {
      // メニュー項目からテキストで検索
      return findElementByText("li, [role='menuitem'], [role='option']", [
        "ミーティングを録画",
        "録画を管理",
        "録画",
        "Record meeting",
        "Manage recording",
        "Recording",
      ]);
    }, 5000);

    if (!menuItem) {
      throw new Error("録画メニュー項目が見つかりません");
    }
    log("録画メニュー項目をクリックします");
    menuItem.click();
    await sleep(1500);
  }

  /**
   * 「録画を開始」ボタンをクリック
   */
  async function clickStartRecording() {
    log("「録画を開始」ボタンを探しています...");

    const startButton = await waitForElement(() => {
      // ボタンのテキストから検索
      const btn = findElementByText("button, [role='button']", [
        "録画を開始",
        "Start recording",
        "Iniciar grabación",
      ]);
      if (btn) return btn;

      // aria-label からも検索
      return findButtonByAriaLabel([
        "録画を開始",
        "Start recording",
      ]);
    }, 5000);

    if (!startButton) {
      throw new Error("「録画を開始」ボタンが見つかりません");
    }
    log("「録画を開始」ボタンをクリックします");
    startButton.click();
    await sleep(1500);
  }

  /**
   * 同意/確認ダイアログがあれば「開始」をクリック
   */
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

  /**
   * 既に録画中かどうかを確認する
   */
  function isAlreadyRecording() {
    // 「REC」インジケーターの存在チェック
    const recIndicator = findElementByText("*", ["REC"]);
    if (
      recIndicator &&
      recIndicator.closest &&
      recIndicator.closest('[data-recording="true"]')
    ) {
      return true;
    }

    // 録画停止ボタンの存在チェック
    const stopButton = findButtonByAriaLabel([
      "録画を停止",
      "Stop recording",
    ]);
    if (stopButton) return true;

    // 録画中を示す赤いドットの存在チェック
    const recordingDot = document.querySelector(
      '[data-recording-indicator], [aria-label*="Recording"]'
    );
    if (recordingDot) return true;

    return false;
  }

  /**
   * 録画を開始するメインフロー
   */
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
      // ステップ 1: 「その他のオプション」メニューを開く
      await openMoreOptionsMenu();

      // ステップ 2: 「録画」メニュー項目をクリック
      await clickRecordingMenuItem();

      // ステップ 3: 「録画を開始」ボタンをクリック
      await clickStartRecording();

      // ステップ 4: 確認ダイアログがあれば承認
      await confirmRecordingDialog();

      log("録画の開始に成功しました！");

      // background script に成功を通知
      chrome.runtime.sendMessage({
        type: "RECORDING_STATUS",
        status: "started",
      });
    } catch (error) {
      warn(`録画の開始に失敗しました: ${error.message}`);
      hasAttemptedRecording = false; // リトライ可能にする

      chrome.runtime.sendMessage({
        type: "RECORDING_STATUS",
        status: "failed",
        error: error.message,
      });
    }
  }

  // --- メイン監視ループ ---

  async function monitorMeeting() {
    log("ミーティング監視を開始します...");
    let retryCount = 0;

    const checkInterval = setInterval(async () => {
      if (!isEnabled) return;

      if (meetingDetected && hasAttemptedRecording) {
        // 既に処理済み
        return;
      }

      if (isInMeeting()) {
        if (!meetingDetected) {
          meetingDetected = true;
          log("ミーティングへの参加を検知しました！");

          // ミーティング参加後、UIが安定するまで少し待機
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

    // ページ離脱時にクリーンアップ
    window.addEventListener("beforeunload", () => {
      clearInterval(checkInterval);
      meetingDetected = false;
      hasAttemptedRecording = false;
    });
  }

  // --- 設定の読み込み ---

  function loadSettings() {
    chrome.storage.sync.get({ autoRecordEnabled: true }, (items) => {
      isEnabled = items.autoRecordEnabled;
      log(`自動録画: ${isEnabled ? "有効" : "無効"}`);
    });
  }

  // --- 設定変更の監視 ---

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.autoRecordEnabled) {
      isEnabled = changes.autoRecordEnabled.newValue;
      log(`自動録画設定が変更されました: ${isEnabled ? "有効" : "無効"}`);
    }
  });

  // --- background script からのメッセージ受信 ---

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
    }
    return true;
  });

  // --- 初期化 ---

  function init() {
    // meet.google.com のミーティングページのみで動作
    if (!window.location.href.match(/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i)) {
      log("ミーティングページではないためスキップします");
      return;
    }

    log("初期化中...");
    loadSettings();
    monitorMeeting();
  }

  // DOM 準備完了後に初期化
  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
