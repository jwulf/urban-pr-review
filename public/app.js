// urban-pr-review web UI — a tiny dependency-free SPA over the JSON API.

let scope = "active";
const listEl = document.getElementById("list");
const statusLine = document.getElementById("status-line");
const submitMsg = document.getElementById("submit-msg");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_LABEL = {
  converging: "Converging",
  waiting_review: "Waiting for review",
  escalated: "Escalated — needs you",
  converged: "Converged",
  abandoned: "Abandoned",
};

function roundRow(r) {
  return `<li class="round round-${esc(r.status)}">
    <span class="rn">#${esc(r.round_no)}</span>
    <span class="rs">${esc(r.status ?? "")}</span>
    <span class="rsum">${esc(r.summary ?? "")}</span>
  </li>`;
}

function escalationBlock(pr) {
  const open = pr.openEscalation;
  if (!open) return "";
  return `<div class="escalation">
    <div class="esc-head">${open.kind === "blocker" ? "🚧 Blocked" : "❓ Question"} (round ${esc(open.round_no)})</div>
    <div class="esc-q">${esc(open.question)}</div>
    <form class="answer-form" data-prkey="${esc(pr.pr_key)}">
      <textarea placeholder="Answer to unblock and resume…" required></textarea>
      <button type="submit">Answer &amp; resume</button>
    </form>
  </div>`;
}

function card(pr) {
  const label = STATUS_LABEL[pr.status] ?? pr.status;
  const rounds = (pr.rounds ?? []).map(roundRow).join("") || `<li class="empty">no rounds yet</li>`;
  return `<details class="card status-${esc(pr.status)}" ${pr.openEscalation ? "open" : ""}>
    <summary>
      <span class="pr-key">${esc(pr.pr_key)}</span>
      <span class="badge b-${esc(pr.status)}">${esc(label)}</span>
      <span class="round-count">round ${esc(pr.current_round)}</span>
      ${pr.title ? `<span class="pr-title">${esc(pr.title)}</span>` : ""}
    </summary>
    <div class="card-body">
      <a class="pr-link" href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.url)}</a>
      ${escalationBlock(pr)}
      ${pr.outcome ? `<div class="outcome"><strong>Outcome:</strong> ${esc(pr.outcome)}</div>` : ""}
      <ol class="rounds">${rounds}</ol>
    </div>
  </details>`;
}

async function load() {
  try {
    const res = await fetch(`/api/prs?scope=${scope}`);
    const prs = await res.json();
    listEl.innerHTML = prs.length
      ? prs.map(card).join("")
      : `<p class="empty">No ${scope === "history" ? "converged" : "active"} PRs.</p>`;
    statusLine.textContent = `${prs.length} ${scope} PR(s) · updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    listEl.innerHTML = `<p class="empty error">Failed to load: ${esc(err)}</p>`;
  }
}

// submit
document.getElementById("submit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("pr-input");
  const raw = input.value.trim();
  if (!raw) return;
  submitMsg.textContent = "Submitting…";
  const res = await fetch("/api/prs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: raw }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    submitMsg.textContent = body.alreadyRunning
      ? `Already converging: ${body.prKey}`
      : `Started: ${body.prKey}`;
    input.value = "";
    scope = "active";
    syncTabs();
    load();
  } else {
    submitMsg.textContent = `Error: ${body.error ?? res.status}`;
  }
});

// answer escalation (event delegation)
listEl.addEventListener("submit", async (e) => {
  if (!e.target.classList.contains("answer-form")) return;
  e.preventDefault();
  const prKey = e.target.dataset.prkey;
  const answer = e.target.querySelector("textarea").value.trim();
  if (!answer) return;
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Resuming…";
  const res = await fetch(`/api/prs/${encodeURIComponent(prKey)}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  if (res.ok) load();
  else {
    btn.disabled = false;
    btn.textContent = "Answer & resume";
  }
});

// tabs
function syncTabs() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.scope === scope));
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    scope = t.dataset.scope;
    syncTabs();
    load();
  }));

load();
setInterval(load, 5000);
