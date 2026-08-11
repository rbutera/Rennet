// The only JavaScript on the page: flip between the dark identity and the bright
// room. No storage, no analytics, no network. tokens.css does the rest.
(function () {
  var root = document.documentElement;
  var btn = document.getElementById("scheme");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var next = root.getAttribute("data-scheme") === "light" ? "dark" : "light";
    root.setAttribute("data-scheme", next);
    btn.textContent = next === "light" ? "dark" : "light";
  });
})();
