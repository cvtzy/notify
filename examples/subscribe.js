// Run this in your website after the visitor clicks an "Enable notifications" button.
// Replace these values with the project details from the ping dashboard.
const PING_API = "https://YOUR-WORKER.workers.dev";
const PING_PROJECT_ID = "YOUR_PROJECT_ID";
const PING_CHANNEL = "general";

function base64UrlToBytes(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

export async function enablePingNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("This browser does not support Web Push.");
  }
  if (!window.isSecureContext) throw new Error("Notifications require HTTPS.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");

  const registration = await navigator.serviceWorker.register("/sw.js");
  const keyResponse = await fetch(`${PING_API}/v1/public-key`);
  if (!keyResponse.ok) throw new Error("Could not load the push public key.");
  const { publicKey } = await keyResponse.json();

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey)
    });
  }

  const response = await fetch(`${PING_API}/v1/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: PING_PROJECT_ID,
      channel: PING_CHANNEL,
      subscription: subscription.toJSON()
    })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Subscription failed.");
  return result; // Contains deviceId. Keep it if you want to unsubscribe this device later.
}

// Example:
// document.querySelector("#enable-push").addEventListener("click", async () => {
//   try { const result = await enablePingNotifications(); console.log("Ping enabled", result); }
//   catch (error) { console.error(error); }
// });
