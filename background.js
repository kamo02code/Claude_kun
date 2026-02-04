/**
 * Google Meet Auto Record - Background Service Worker
 */

const LOG_PREFIX = "[Meet Auto Record BG]";

// 拡張機能インストール時の初期化
chrome.runtime.onInstalled.addListener(() => {
  console.log(`${LOG_PREFIX} 拡張機能がインストールされました`);

  // デフォルト設定を保存
  chrome.storage.sync.set({
    autoRecordEnabled: true,
  });
});

// content script からのメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECORDING_STATUS") {
    console.log(`${LOG_PREFIX} 録画ステータス: ${message.status}`);

    if (message.status === "started") {
      // バッジを更新して録画中を表示
      chrome.action.setBadgeText({ text: "REC", tabId: sender.tab?.id });
      chrome.action.setBadgeBackgroundColor({
        color: "#FF0000",
        tabId: sender.tab?.id,
      });
    } else if (message.status === "failed") {
      chrome.action.setBadgeText({ text: "ERR", tabId: sender.tab?.id });
      chrome.action.setBadgeBackgroundColor({
        color: "#FF9800",
        tabId: sender.tab?.id,
      });
    }
  }
  return true;
});

// タブ更新時にバッジをリセット
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ text: "", tabId });
  }
});
