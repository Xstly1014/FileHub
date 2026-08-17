/* ===================================================================
   FileHub · 极简 Hash 路由
   路由表：
     #/              -> 工作区（视图一）
     #/detail/:id    -> 文件详情/编辑（视图二，数据驱动）
   =================================================================== */
window.App = window.App || {};

App.router = (function () {
  var routes = [];

  function add(pattern, handler) {
    var regex = new RegExp("^" + pattern.replace(/:[^/]+/g, "([^/]+)") + "$");
    routes.push({ pattern: pattern, regex: regex, handler: handler });
  }

  function resolve() {
    var path = location.hash.replace(/^#/, "");
    if (path === "" || path === "/") path = "/";
    for (var i = 0; i < routes.length; i++) {
      var m = path.match(routes[i].regex);
      if (m) {
        routes[i].handler(m.slice(1));
        return;
      }
    }
    // 兜底：回到工作区
    if (routes.length) routes[0].handler([]);
  }

  function start() {
    window.addEventListener("hashchange", resolve);
    resolve();
  }

  function go(p) {
    if (location.hash === "#" + p) { resolve(); } else { location.hash = p; }
  }

  return { add: add, start: start, go: go, resolve: resolve };
})();
