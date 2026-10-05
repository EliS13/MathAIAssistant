// Reads course / assignment / student IDs out of a Classroom URL.
//
// Handles the two URL shapes Classroom uses when a teacher opens student work:
//   /c/{course}/a/{work}/submissions/.../student/{student}
//   /g/tg/{course}/{work}#u={student}
// both optionally prefixed by /u/{n}/ for multi-account users.

(function () {
  // Classroom puts base64 of the numeric API id in the URL. Decode it when that is what it is.
  function toApiId(raw) {
    if (!raw) return null;
    try {
      const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
      if (/^\d+$/.test(decoded)) return decoded;
    } catch {}
    return raw;
  }

  function parseClassroomUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.hostname !== "classroom.google.com") return null;

    const path = url.pathname.replace(/^\/u\/\d+/, "");
    let m = path.match(/^\/c\/([^/]+)\/a\/([^/]+)(?:\/.*\/student\/([^/]+))?/);
    if (!m) {
      const tg = path.match(/^\/g\/tg\/([^/]+)\/([^/]+)/);
      if (!tg) return null;
      const student = new URLSearchParams(url.hash.slice(1)).get("u");
      m = [null, tg[1], tg[2], student];
    }

    return {
      courseId: toApiId(m[1]),
      courseWorkId: toApiId(m[2]),
      studentId: toApiId(m[3]),
    };
  }

  globalThis.parseClassroomUrl = parseClassroomUrl;
})();
