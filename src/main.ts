// 회의 옆자리 — entry point. Modules are wired here step by step (see docs/01-legacy-분석보고서.md §6).
const app = document.getElementById("app")!;
app.innerHTML = `<header><h1>회의 옆자리</h1><span id="status" class="status">STANDBY</span></header>`;
document.documentElement.dataset.ready = "1";
