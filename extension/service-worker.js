// Passes the button's requests on to the Python server.
// The Classroom page itself isn't allowed to call 127.0.0.1, but the extension is
// (see host_permissions in manifest.json).

const SERVER = "http://127.0.0.1:8000"; // keep in sync with PORT in functionality/server.py

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "scan:start") {
    call("/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.context),
    }).then(sendResponse);
    return true; // answering asynchronously
  }
  if (msg.type === "scan:status") {
    call(`/scan/${msg.id}`).then(sendResponse);
    return true;
  }
});

async function call(path, options) {
  let res;
  try {
    res = await fetch(SERVER + path, options);
  } catch {
    return { state: "error", message: "Python server isn't running. Run server.py." };
  }
  const body = await res.json().catch(() => ({}));
  return res.ok ? body : { state: "error", message: body.message ?? `The Python server answered ${res.status}.` };
}
