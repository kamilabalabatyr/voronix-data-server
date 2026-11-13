// The analytics dashboard served at / and /dashboard. One page, no build step:
// it asks for the business's API key once (kept in this browser only), reads
// /v1/analytics and draws the charts with Chart.js.
export const DASHBOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoroniX Analytics</title>
<script src="/chart.umd.js"></script>
<style>
  :root { --bg:#F5F5F0; --card:#FFFFFD; --ink:#141A33; --muted:#4A5068; --line:#DEDDD4; --accent:#5B5BD6; --accent2:#E8873A; --good:#2F8F6B; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  header { background:var(--ink); color:#F5F5F0; padding:20px 24px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
  header h1 { margin:0; font-size:22px; font-weight:650; }
  header small { color:#B9BEDA; }
  main { max-width:1200px; margin:0 auto; padding:24px 16px 48px; }
  .grid { display:grid; gap:16px; }
  .kpis { grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); margin-bottom:16px; }
  .two { grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px; min-width:0; }
  .card h2 { margin:0 0 4px; font-size:17px; }
  .card p.sub { margin:0 0 12px; color:var(--muted); font-size:14px; }
  .kpi b { display:block; font-size:30px; font-weight:700; margin-top:4px; }
  .kpi span { color:var(--muted); font-size:14px; }
  .chart { position:relative; height:280px; }
  .card { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  .login { max-width:460px; margin:60px auto; }
  input { width:100%; padding:12px; border:1px solid var(--line); border-radius:10px; font:inherit; margin:10px 0; }
  button { background:var(--accent); color:#fff; border:0; border-radius:10px; padding:11px 18px; font:inherit; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:#F5F5F0; border:1px solid #4A5068; padding:7px 12px; font-size:14px; }
  .err { color:#B42318; margin-top:8px; }
  .hidden { display:none; }
  code { background:#ECEBE4; padding:1px 5px; border-radius:5px; }
</style>
</head>
<body>
<header>
  <div><h1>VoroniX Analytics</h1><small id="biz">Аналитика бизнеса из общей базы CRM и ИИ</small></div>
  <div><button class="ghost hidden" id="refresh">Обновить</button> <button class="ghost hidden" id="logout">Сменить ключ</button></div>
</header>
<main>
  <section class="card login" id="login">
    <h2>Вход</h2>
    <p class="sub">Введите API-ключ бизнеса (<code>vxd_…</code>). Он сохранится только в этом браузере.</p>
    <input id="key" placeholder="vxd_..." autocomplete="off">
    <button id="go">Показать аналитику</button>
    <div class="err" id="err"></div>
  </section>

  <section id="dash" class="hidden">
    <div class="grid kpis">
      <div class="card kpi"><span>Выручка (завершённые визиты)</span><b id="k-revenue">—</b></div>
      <div class="card kpi"><span>Завершённых визитов</span><b id="k-visits">—</b></div>
      <div class="card kpi"><span>Отмены и неявки</span><b id="k-lost">—</b></div>
      <div class="card kpi"><span>Чаты → запись (конверсия)</span><b id="k-conv">—</b></div>
    </div>
    <div class="grid two">
      <div class="card"><h2>Выручка по услугам</h2><p class="sub">Какие услуги приносят деньги, ₸</p><div class="chart"><canvas id="c-services"></canvas></div></div>
      <div class="card"><h2>Откуда приходят записи</h2><p class="sub">Записи по каналам и доля потерянных (отмена + неявка)</p><div class="chart"><canvas id="c-channels"></canvas></div></div>
      <div class="card"><h2>Дни недели</h2><p class="sub">Сколько записей и какой процент теряется</p><div class="chart"><canvas id="c-weekdays"></canvas></div></div>
      <div class="card"><h2>По месяцам</h2><p class="sub">Выручка и завершённые визиты</p><div class="chart"><canvas id="c-months"></canvas></div></div>
      <div class="card"><h2>Мастера</h2><p class="sub">Визиты, выручка и неявки</p><table id="t-masters"></table></div>
      <div class="card"><h2>Воронка чатов</h2><p class="sub">Сколько диалогов в мессенджерах закончились записью</p><table id="t-funnel"></table></div>
      <div class="card"><h2>Качество ИИ</h2><p class="sub">Точность модели по версиям (F1 и доля полностью верных ответов)</p><div class="chart"><canvas id="c-ai"></canvas></div><p class="sub" id="ai-empty"></p></div>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const money = (n) => Number(n).toLocaleString("ru-RU") + " ₸";
const DAYS = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const C = { accent: "#5B5BD6", accent2: "#E8873A", good: "#2F8F6B", grid: "#E6E5DD", ink: "#4A5068" };
let charts = [];
const store = { get() { try { return localStorage.getItem("vx-key"); } catch { return null; } }, set(v) { try { v ? localStorage.setItem("vx-key", v) : localStorage.removeItem("vx-key"); } catch {} } };

function chart(id, cfg) {
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: C.ink } } },
    scales: cfg.type === "doughnut" ? {} : { x: { grid: { color: C.grid }, ticks: { color: C.ink } }, y: { grid: { color: C.grid }, ticks: { color: C.ink }, beginAtZero: true } } }, cfg.options || {});
  const el = $(id);
  charts.push(new Chart(el, cfg));
}
function table(id, head, rows) {
  $(id).innerHTML = "<tr>" + head.map(([t, n]) => '<th class="' + (n ? "n" : "") + '">' + t + "</th>").join("") + "</tr>" +
    rows.map((r) => "<tr>" + r.map((v, i) => '<td class="' + (head[i][1] ? "n" : "") + '">' + v + "</td>").join("") + "</tr>").join("");
}

async function load() {
  const key = store.get();
  if (!key) return showLogin();
  const res = await fetch("/v1/analytics", { headers: { Authorization: "Bearer " + key } }).catch(() => null);
  if (!res || !res.ok) { store.set(null); return showLogin(res ? (res.status === 401 ? "Ключ не подошёл." : "Ошибка сервера " + res.status) : "Сервер не отвечает, попробуйте через минуту."); }
  draw(await res.json());
}
function showLogin(msg) { $("login").classList.remove("hidden"); $("dash").classList.add("hidden"); $("refresh").classList.add("hidden"); $("logout").classList.add("hidden"); $("err").textContent = msg || ""; }

function draw(d) {
  charts.forEach((c) => c.destroy()); charts = [];
  $("login").classList.add("hidden"); $("dash").classList.remove("hidden"); $("refresh").classList.remove("hidden"); $("logout").classList.remove("hidden");
  $("biz").textContent = d.business + " · данные на " + new Date().toLocaleString("ru-RU");

  const revenue = d.services.reduce((s, r) => s + r.revenue, 0);
  const visits = d.services.reduce((s, r) => s + r.completed, 0);
  const all = d.channels.reduce((s, r) => s + r.bookings, 0);
  const lost = d.services.reduce((s, r) => s + r.lost, 0);
  const chats = d.funnel.reduce((s, r) => s + r.chats, 0), booked = d.funnel.reduce((s, r) => s + r.booked, 0);
  $("k-revenue").textContent = money(revenue);
  $("k-visits").textContent = visits;
  $("k-lost").textContent = all ? Math.round((100 * lost) / all) + "%" : "—";
  $("k-conv").textContent = chats ? Math.round((100 * booked) / chats) + "% (" + booked + " из " + chats + ")" : "нет чатов";

  table("t-masters", [["Мастер"], ["Визиты", 1], ["Выручка", 1], ["Неявки", 1]],
    d.masters.map((r) => [r.name, r.completed, money(r.revenue), r.no_show + (r.no_show_pct != null ? " (" + r.no_show_pct + "%)" : "")]));
  table("t-funnel", [["Канал"], ["Чатов", 1], ["Записи", 1], ["Конверсия", 1], ["Человеку", 1]],
    d.funnel.map((r) => [r.channel, r.chats, r.booked, r.conversion_pct + "%", r.handed_to_human]));
  if (typeof Chart === "undefined") return;

  chart("c-services", { type: "bar", data: { labels: d.services.map((r) => r.name), datasets: [{ label: "Выручка, ₸", data: d.services.map((r) => r.revenue), backgroundColor: C.accent, borderRadius: 6 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false } } } });
  chart("c-channels", { type: "bar", data: { labels: d.channels.map((r) => r.channel), datasets: [
    { label: "Записей", data: d.channels.map((r) => r.bookings), backgroundColor: C.accent, borderRadius: 6, yAxisID: "y" },
    { label: "Потеряно, %", data: d.channels.map((r) => r.lost_pct), type: "line", borderColor: C.accent2, backgroundColor: C.accent2, yAxisID: "p" }] },
    options: { scales: { p: { position: "right", beginAtZero: true, grid: { display: false }, ticks: { color: C.ink, callback: (v) => v + "%" } } } } });
  chart("c-weekdays", { type: "bar", data: { labels: d.weekdays.map((r) => DAYS[r.weekday]), datasets: [
    { label: "Записей", data: d.weekdays.map((r) => r.bookings), backgroundColor: C.accent, borderRadius: 6, yAxisID: "y" },
    { label: "Потеряно, %", data: d.weekdays.map((r) => r.lost_pct), type: "line", borderColor: C.accent2, backgroundColor: C.accent2, yAxisID: "p" }] },
    options: { scales: { p: { position: "right", beginAtZero: true, grid: { display: false }, ticks: { color: C.ink, callback: (v) => v + "%" } } } } });
  chart("c-months", { type: "bar", data: { labels: d.months.map((r) => r.month), datasets: [
    { label: "Выручка, ₸", data: d.months.map((r) => r.revenue), backgroundColor: C.good, borderRadius: 6, yAxisID: "y" },
    { label: "Визитов", data: d.months.map((r) => r.completed), type: "line", borderColor: C.accent, backgroundColor: C.accent, yAxisID: "v" }] },
    options: { scales: { v: { position: "right", beginAtZero: true, grid: { display: false }, ticks: { color: C.ink } } } } });

  if (d.aiQuality.length) {
    $("ai-empty").textContent = "";
    chart("c-ai", { type: "line", data: { labels: d.aiQuality.map((r) => "v" + r.version), datasets: [
      { label: "F1", data: d.aiQuality.map((r) => r.f1), borderColor: C.accent, backgroundColor: C.accent },
      { label: "Полностью верно", data: d.aiQuality.map((r) => r.exact), borderColor: C.good, backgroundColor: C.good }] },
      options: { scales: { y: { min: 0, max: 1, grid: { color: C.grid }, ticks: { color: C.ink } } } } });
  } else {
    $("c-ai").parentElement.style.display = "none";
    $("ai-empty").textContent = "ИИ ещё не сохраняла версии модели на этот сервер. График появится, когда VoroniX AI переобучится.";
  }
}

$("go").onclick = () => { const v = $("key").value.trim(); if (!v.startsWith("vxd_")) { $("err").textContent = "Ключ начинается с vxd_"; return; } store.set(v); load(); };
$("key").addEventListener("keydown", (e) => e.key === "Enter" && $("go").click());
$("logout").onclick = () => { store.set(null); showLogin(); };
$("refresh").onclick = load;
load();
</script>
</body>
</html>`;
