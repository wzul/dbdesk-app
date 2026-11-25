// dbdesk.app — small progressive enhancement, no framework, no build step.

(function () {
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // Point the two download buttons straight at the current DMG. The asset names
  // are versioned (DB.Desk_<version>_<arch>.dmg), so the version has to come from
  // the release manifest at runtime — never hard-coded, or the link rots on the
  // next release. GitHub's asset host sends no CORS headers, so the manifest is
  // mirrored same-origin at /release/latest.json by the deploy stack. If the
  // fetch fails the buttons keep their release-page href.
  var MANIFEST = '/release/latest.json';
  var buttons = document.querySelectorAll('[data-dl]');
  if (!buttons.length || !window.fetch) return;

  fetch(MANIFEST, { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (m) {
      if (!m || !m.version) return;
      var base = 'https://github.com/wzul/dbdesk-app/releases/download/v' + m.version + '/DB.Desk_' + m.version + '_';
      buttons.forEach(function (btn) {
        var arch = btn.getAttribute('data-dl');
        if (!arch) {                       // nav "Download" button: latest DMG for this Mac
          arch = /arm|aarch/i.test(navigator.userAgent) ? 'aarch64' : 'x64';
        }
        btn.setAttribute('href', base + arch + '.dmg');
      });
      var version = document.querySelector('[data-dl-version]');
      if (version) version.textContent = 'v' + m.version;
      var labels = document.querySelectorAll('[data-dl-label]');
      if (labels[0]) labels[0].textContent = 'Download for Apple silicon';
      if (labels[1]) labels[1].textContent = 'Download for Intel';
    })
    .catch(function () { /* keep the release page links */ });
})();
