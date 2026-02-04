/**
 * Google Meet Auto Record - Popup Script
 */

const toggleEnabled = document.getElementById("toggleEnabled");
const meetingDot = document.getElementById("meetingDot");
const meetingStatus = document.getElementById("meetingStatus");
const recordingDot = document.getElementById("recordingDot");
const recordingStatus = document.getElementById("recordingStatus");
const retryBtn = document.getElementById("retryBtn");

// 設定を読み込み
chrome.storage.sync.get({ autoRecordEnabled: true }, (items) => {
  toggleEnabled.checked = items.autoRecordEnabled;
});

// トグル変更時
toggleEnabled.addEventListener("change", () => {
  const enabled = toggleEnabled.checked;
  chrome.storage.sync.set({ autoRecordEnabled: enabled });

  // アクティブなMeetタブに通知
  sendToActiveTab({ type: "TOGGLE_ENABLED", enabled });
});

// ステータス取得
function updateStatus() {
  sendToActiveTab({ type: "GET_STATUS" }, (response) => {
    if (!response) {
      meetingDot.className = "status-dot inactive";
      meetingStatus.textContent = "Google Meet を開いてください";
      recordingDot.className = "status-dot inactive";
      recordingStatus.textContent = "-";
      retryBtn.disabled = true;
      return;
    }

    // ミーティング状態
    if (response.meetingDetected) {
      meetingDot.className = "status-dot active";
      meetingStatus.textContent = "ミーティング参加中";
    } else {
      meetingDot.className = "status-dot inactive";
      meetingStatus.textContent = "ミーティング未検出";
    }

    // 録画状態
    if (response.isRecording) {
      recordingDot.className = "status-dot recording";
      recordingStatus.textContent = "録画中";
      retryBtn.disabled = true;
    } else if (response.hasAttemptedRecording) {
      recordingDot.className = "status-dot inactive";
      recordingStatus.textContent = "録画開始を試行済み";
      retryBtn.disabled = false;
    } else {
      recordingDot.className = "status-dot inactive";
      recordingStatus.textContent = "待機中";
      retryBtn.disabled = !response.meetingDetected;
    }
  });
}

// 再試行ボタン
retryBtn.addEventListener("click", () => {
  retryBtn.disabled = true;
  sendToActiveTab({ type: "RETRY_RECORDING" }, () => {
    setTimeout(updateStatus, 3000);
  });
});

// Google Meet のアクティブタブにメッセージ送信
function sendToActiveTab(message, callback) {
  chrome.tabs.query(
    { active: true, currentWindow: true, url: "https://meet.google.com/*" },
    (tabs) => {
      if (tabs.length === 0) {
        if (callback) callback(null);
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          if (callback) callback(null);
          return;
        }
        if (callback) callback(response);
      });
    }
  );
}

// 初回ステータス更新
updateStatus();

// 定期更新
setInterval(updateStatus, 3000);
