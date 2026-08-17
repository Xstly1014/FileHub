/* ===================================================================
   FileHub · Shared AI client.

   Delegates all transport to the unified App.api client (auth + envelope),
   so there is a single place that knows how to talk to the backend.
   The browser stays keyless; the backend provides local fallbacks when the
   LLM is unavailable (mode: "fallback").
   =================================================================== */
window.App = window.App || {};
App.ai = (function () {
  var api = App.api;
  return {
    base: (api && api.base) || window.FILEHUB_AI_BASE || "http://127.0.0.1:8787/api/v1",
    summarize: function (content) { return api.post("/ai/summarize", { content: content }); },
    summarizeFile: function (fileId) { return api.post("/ai/summarize", { fileId: fileId }); },
    tags: function (name, content) { return api.post("/ai/tags", { name: name, content: content }); },
    links: function (source, candidates) { return api.post("/ai/links", { source: source, candidates: candidates }); },
    chat: function (question, files, workspaceId) { return api.post("/ai/chat", { question: question, files: files || [], workspaceId: workspaceId }); }
  };
})();
