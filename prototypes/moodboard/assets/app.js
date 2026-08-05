/* Rennet prototype · shared runtime.
   Reads ?dir= from the URL, stamps the direction on <html>,
   renders the Rennet wordmark into every .wm slot, and wires the
   per-screen interactions (declared by body[data-screen]). */

(function () {
  var qs = new URLSearchParams(location.search);
  var hq = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  var dir = qs.get("dir") || hq.get("dir") || "glass";
  var scheme = qs.get("scheme") || hq.get("scheme") || "dark";
  if (["reading", "glass", "instrument"].indexOf(dir) < 0) dir = "glass";
  if (["dark", "light"].indexOf(scheme) < 0) scheme = "dark";
  document.documentElement.dataset.dir = dir;
  document.documentElement.dataset.scheme = scheme;

  var GLYPH =
      '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">' +
      '<path d="M2.6 9a6.4 6.4 0 0 1 6.4-6.4V15.4A6.4 6.4 0 0 1 2.6 9Z" fill="var(--mark-ink)"/>' +
      '<path d="M11.4 2.9a6.4 6.4 0 0 1 0 12.2" stroke="var(--mark-ink)" stroke-width="1.4" stroke-linecap="round"/></svg>';

  function renderWordmarks() {
    var slots = document.querySelectorAll(".wm");
    for (var i = 0; i < slots.length; i++) {
      var el = slots[i];
      el.innerHTML = GLYPH + '<span class="wm-rennet">Rennet</span>';
      el.setAttribute("aria-label", "Rennet");
    }
  }
  renderWordmarks();

  var screen = document.body.getAttribute("data-screen");

  /* ————— home: sidebar collapse ————— */
  if (screen === "home") {
    var collapseBtn = document.querySelector(".collapse-btn");
    var homeMain = document.querySelector(".home-main");
    if (collapseBtn && homeMain) {
      collapseBtn.addEventListener("click", function () {
        var collapsed = homeMain.classList.toggle("collapsed");
        collapseBtn.setAttribute("aria-expanded", String(!collapsed));
      });
    }
  }

  /* ————— review: angle switching, chunk select, read state, regeneration ————— */
  if (screen === "review") {
    var panels = {
      sequence: document.getElementById("panel-sequence"),
      decisions: document.getElementById("panel-decisions"),
      other: document.getElementById("panel-other")
    };
    var angleSummaries = {
      spec: {
        title: "Spec",
        copy: "Twelve authoritative requirements, traced from docs/plan.md and AT-1291. Inferred intent is marked and cannot prove the review complete.",
        card: "<b>1 requirement may be stale</b><p>The local edit changed retry behaviour. Re-check the fail-open requirement against draft patchset 8.</p>"
      },
      claims: {
        title: "Claims and evidence",
        copy: "Every behavioural claim paired with the test that should fail without it. One changed behaviour remains unclaimed.",
        card: "<b>11 of 12 claims evidenced</b><p>The logging rework answers no requirement. Treat it as scope creep or add the missing claim.</p>"
      },
      blast: {
        title: "Blast radius",
        copy: "Explainable risk signals only: irreversible writes, public contracts, deletions, fan-in, ownership, and weakened safety nets.",
        card: "<b>2 amber flags</b><p>The migration has no down path. The API-key to organisation key change alters the public meaning of a 429.</p>"
      },
      noise: {
        title: "Noise",
        copy: "The totality floor. Deterministic checkers verified 592 lines; suspected patterns still require a skim.",
        card: "<b>481 verified · 111 suspected</b><p>Generated clients and lockfile updates are attested. Repeated null guards are suspected noise and remain open.</p>"
      }
    };
    var angleButtons = document.querySelectorAll(".angle[data-angle]");

    function showAngle(key) {
      for (var i = 0; i < angleButtons.length; i++) {
        var b = angleButtons[i];
        b.setAttribute("aria-pressed", String(b.dataset.angle === key));
      }
      var target = key === "sequence" || key === "decisions" ? key : "other";
      panels.sequence.hidden = target !== "sequence";
      panels.decisions.hidden = target !== "decisions";
      panels.other.hidden = target !== "other";
      if (target === "other") {
        var summary = angleSummaries[key] || angleSummaries.spec;
        document.getElementById("angle-summary-title").textContent = summary.title;
        document.getElementById("angle-summary-copy").textContent = summary.copy;
        document.getElementById("angle-summary-card").innerHTML = summary.card;
      }
    }
    for (var i = 0; i < angleButtons.length; i++) {
      angleButtons[i].addEventListener("click", function () {
        showAngle(this.dataset.angle);
      });
    }

    var chunkItems = Array.prototype.slice.call(document.querySelectorAll(".chunk-item"));
    function selectChunk(li) {
      chunkItems.forEach(function (c) {
        c.classList.remove("current");
        c.removeAttribute("aria-current");
      });
      li.classList.add("current");
      li.setAttribute("aria-current", "true");
    }
    chunkItems.forEach(function (li) {
      li.addEventListener("click", function () { selectChunk(li); });
      li.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectChunk(li); }
      });
    });

    function refreshCoverage() {
      var cells = document.querySelectorAll(".coverage .cells i");
      var readCount = 0;
      chunkItems.forEach(function (c, idx) {
        var cell = cells[idx];
        if (!cell) return;
        cell.className = "";
        if (c.classList.contains("read") || c.classList.contains("skimmed")) {
          cell.className = "read"; readCount++;
        } else if (c.classList.contains("current")) {
          cell.className = "now";
        }
      });
      var em = document.querySelector(".coverage em");
      var hasStale = document.querySelector(".chunk-item.invalid, .chunk-item.potential");
      if (em) em.textContent = hasStale
        ? readCount + " exact matches remain complete · private"
        : readCount + " of " + chunkItems.length + " read · private";
    }

    function markCurrentRead() {
      var current = document.querySelector(".chunk-item.current");
      if (!current) return;
      if (current.classList.contains("invalid") || current.classList.contains("potential")) return;
      current.classList.remove("skimmed");
      current.classList.add("read");
      var next = current.nextElementSibling;
      if (next && next.classList.contains("chunk-item") && !next.classList.contains("read")) {
        selectChunk(next);
      }
      refreshCoverage();
    }
    var markBtn = document.getElementById("mark-read");
    if (markBtn) markBtn.addEventListener("click", markCurrentRead);
    document.addEventListener("keydown", function (e) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === "r" || e.key === "R") markCurrentRead();
      if (e.key >= "1" && e.key <= "6") {
        var map = { "1": "spec", "2": "sequence", "3": "decisions", "4": "claims", "5": "blast", "6": "noise" };
        showAngle(map[e.key]);
      }
    });

    var updatePanel = document.querySelector(".analysis-update");
    var regenerateBtn = document.getElementById("regenerate-affected");
    var simulateBtn = document.getElementById("simulate-edit");
    var snapshotState = document.getElementById("snapshot-state");
    var staleNotice = document.querySelector(".stale-analysis");

    function regenerateAffected() {
      if (!regenerateBtn || regenerateBtn.disabled) return;
      regenerateBtn.disabled = true;
      regenerateBtn.textContent = "Regenerating 2 affected analyses…";
      updatePanel.classList.add("regenerating");
      if (staleNotice) {
        staleNotice.innerHTML = "<b>Regenerating</b><span>The patchset 7 analysis stays visible while Rennet validates its replacement.</span>";
      }
      window.setTimeout(function () {
        var affected = document.querySelectorAll(".chunk-item.invalid, .chunk-item.potential");
        for (var i = 0; i < affected.length; i++) {
          var item = affected[i];
          item.classList.remove("invalid", "potential", "read", "skimmed");
          item.classList.add("analysis-current");
          item.querySelector(".state").setAttribute("aria-label", "current analysis, reopened for reading");
          item.querySelector("small").textContent = "current · regenerated, needs reading";
        }
        updatePanel.classList.remove("regenerating");
        updatePanel.classList.add("regenerated");
        updatePanel.querySelector("strong").textContent = "Affected analysis regenerated for patchset 8";
        updatePanel.querySelector("span").innerHTML = '<b class="status current">2 refreshed</b><b class="status current">4 exact matches stayed complete</b>';
        updatePanel.querySelector("p").textContent = "The changed occurrences reopened for reading. Unchanged completion was not disturbed.";
        regenerateBtn.hidden = true;
        simulateBtn.hidden = false;
        snapshotState.textContent = "Patchset 8 analysis current · 2 areas reopened";
        var publishChip = document.querySelector(".publish-chip");
        if (publishChip) publishChip.innerHTML = "Preview PR<small>2 areas need reading</small>";
        if (staleNotice) {
          staleNotice.classList.add("replacement-ready");
          staleNotice.innerHTML = "<b>Replacement ready</b><span>Analysis now targets patchset 8. This changed occurrence is reopened for reading.</span>";
        }
        refreshCoverage();
      }, 1000);
    }

    function simulateEdit() {
      var second = chunkItems[1];
      var third = chunkItems[2];
      second.classList.remove("analysis-current", "read", "skimmed");
      second.classList.add("invalid");
      second.querySelector("small").textContent = "invalid · implementation edited";
      third.classList.remove("analysis-current", "read", "skimmed");
      third.classList.add("potential");
      third.querySelector("small").textContent = "potential · dependency changed";
      updatePanel.classList.remove("regenerated");
      updatePanel.querySelector("strong").textContent = "Your edit created draft patchset 9";
      updatePanel.querySelector("span").innerHTML = '<b class="status invalid">1 invalid</b><b class="status potential">1 potentially invalid</b><b class="status current">4 current</b>';
      updatePanel.querySelector("p").textContent = "Old analysis stays visible until replacement succeeds. Exact unchanged occurrences keep their completion state.";
      regenerateBtn.hidden = false;
      regenerateBtn.disabled = false;
      regenerateBtn.innerHTML = 'Regenerate affected only <span class="num">2</span>';
      simulateBtn.hidden = true;
      snapshotState.textContent = "Edit detected · 2 analyses affected";
      var publishChip = document.querySelector(".publish-chip");
      if (publishChip) publishChip.innerHTML = "Preview PR<small>2 analyses stale</small>";
      if (staleNotice) {
        staleNotice.classList.remove("replacement-ready");
        staleNotice.innerHTML = "<b>Invalid after local edit</b><span>This is the previous analysis. It remains visible until its replacement succeeds.</span>";
      }
      refreshCoverage();
    }

    if (regenerateBtn) regenerateBtn.addEventListener("click", regenerateAffected);
    if (simulateBtn) simulateBtn.addEventListener("click", simulateEdit);
    refreshCoverage();
  }

  /* ————— publish: hold-to-sign ————— */
  if (screen === "publish") {
    var modeButtons = document.querySelectorAll("[data-publish-mode]");
    var variants = document.querySelectorAll("[data-publish-variant]");
    function setPublishMode(mode) {
      for (var i = 0; i < modeButtons.length; i++) {
        modeButtons[i].setAttribute("aria-pressed", String(modeButtons[i].dataset.publishMode === mode));
      }
      for (var j = 0; j < variants.length; j++) {
        variants[j].hidden = variants[j].dataset.publishVariant !== mode;
      }
    }
    for (var m = 0; m < modeButtons.length; m++) {
      modeButtons[m].addEventListener("click", function () { setPublishMode(this.dataset.publishMode); });
    }

    var copyBtn = document.querySelector(".copy-preview");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        copyBtn.textContent = "Copied locally";
        var note = document.querySelector('[data-publish-variant="author"] .signed-note');
        if (note) note.style.display = "block";
      });
    }

    var btn = document.querySelector(".sign-btn");
    var sheet = document.querySelector(".sheet");
    if (btn && sheet) {
      var timer = null;
      var HOLD_MS = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 900;
      function start() {
        if (sheet.classList.contains("signed")) return;
        btn.classList.add("holding");
        timer = setTimeout(function () {
          sheet.classList.add("signed");
          btn.classList.remove("holding");
        }, HOLD_MS);
      }
      function cancel() {
        btn.classList.remove("holding");
        if (timer) { clearTimeout(timer); timer = null; }
      }
      btn.addEventListener("pointerdown", start);
      btn.addEventListener("pointerup", cancel);
      btn.addEventListener("pointerleave", cancel);
      btn.addEventListener("keydown", function (e) {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) start();
      });
      btn.addEventListener("keyup", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          if (!sheet.classList.contains("signed")) cancel();
        }
      });
    }
  }
})();
