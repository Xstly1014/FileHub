/* ===================================================================
   FileHub · Unified authenticated API client (single source of truth).

   - Unwraps the backend envelope { code, message, data, traceId } -> data.
   - On 401: single-flight refresh-token rotation, then replays the request.
   - Falls back to the demo account only when there is no session at all.
   Replaces the three separate auth code paths (audit P1-9 / P1-10).
   =================================================================== */
window.App = window.App || {};
App.api = (function () {
  var base = window.FILEHUB_API_BASE || "http://127.0.0.1:8787";
  var API = base.replace(/\/$/, "") + "/api/v1";

  function auth() { return localStorage.getItem("fh_access") || ""; }
  function refresh() { return localStorage.getItem("fh_refresh") || ""; }
  function clearSession() { localStorage.removeItem("fh_access"); localStorage.removeItem("fh_refresh"); }

  function raw(path, options) {
    options = options || {}; options.headers = options.headers || {};
    if (!options.headers.Authorization && auth()) options.headers.Authorization = "Bearer " + auth();
    return fetch(API + path, options);
  }

  function doRefresh() {
    var rt = refresh();
    if (!rt) return Promise.reject(new Error("no refresh token"));
    return fetch(API + "/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt })
    }).then(function (r) {
      if (!r.ok) { clearSession(); throw new Error("session expired"); }
      return r.json();
    }).then(function (d) {
      var t = d.data || {};
      localStorage.setItem("fh_access", t.accessToken || "");
      localStorage.setItem("fh_refresh", t.refreshToken || "");
      return t.accessToken;
    });
  }

  // Single-flight refresh: concurrent 401s share one refresh round-trip.
  var refreshing = null;
  function refreshOnce() {
    if (!refreshing) {
      refreshing = doRefresh().catch(function () {}).then(function () { refreshing = null; });
    }
    return refreshing;
  }

  function parse(r) {
    return r.json().catch(function () { return null; }).then(function (j) {
      if (!r.ok) { throw new Error((j && j.message) || ("API error " + r.status)); }
      return j ? j.data : null;
    });
  }

  function request(path, options) {
    return raw(path, options).then(function (r) {
      if (r.status === 401) {
        if (refresh()) {
          return refreshOnce().then(function () { return raw(path, options); });
        }
        if (!auth()) {
          return demoAuth().then(function () { return raw(path, options); });
        }
      }
      return r;
    }).then(parse);
  }

  function demoAuth() {
    var body = { email: "demo@filehub.local", password: "FileHubDemo123!", displayName: "Demo User" };
    return fetch(API + "/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 409) return fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return r;
      })
      .then(function (r) { if (!r.ok) throw new Error("authentication failed"); return r.json(); })
      .then(function (d) {
        var t = d.data || {};
        localStorage.setItem("fh_access", t.accessToken || "");
        localStorage.setItem("fh_refresh", t.refreshToken || "");
        return t;
      });
  }

  function upload(path, file) {
    var fd = new FormData();
    fd.append("upload", file, file.name || "file");
    return request(path, { method: "POST", body: fd });
  }

  return {
    base: API, raw: raw, request: request, demoAuth: demoAuth, upload: upload,
    get: function (p) { return request(p); },
    post: function (p, b) { return request(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); },
    put: function (p, b) { return request(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); },
    patch: function (p, b) { return request(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); },
    del: function (p) { return request(p, { method: "DELETE" }); }
  };
})();
