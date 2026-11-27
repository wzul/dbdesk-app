// dbdesk.app — small progressive enhancement, no framework, no build step.

(function () {
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // Download buttons are driven by the release manifest, never by hard-coded
  // filenames: the assets carry the version (DB.Desk_<version>_<arch>.<ext>), so a
  // link written today would 404 on the next release. GitHub's asset host sends no
  // CORS headers, so the manifest is mirrored same-origin at /release/latest.json
  // by the deploy stack.
  //
  // A platform only appears once the manifest actually lists it — a build that has
  // not shipped yet is not advertised. If the fetch fails, every platform button
  // stays hidden and the release-page link still works.
  var MANIFEST = '/release/latest.json';
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-dl]'));
  if (!buttons.length || !window.fetch) return;

  function detect() {
    var ua = (navigator.userAgent || '').toLowerCase();
    var arm = /arm64|aarch64/.test(ua);
    // A Mac's user agent never says which CPU it has — Apple silicon and Intel
    // Safari send the same string. Default to Apple silicon, and keep both macOS
    // buttons visible in the download block so nobody is stuck.
    if (/mac|darwin/.test(ua)) return 'darwin-aarch64';
    if (/windows|win32|win64/.test(ua)) return arm ? 'windows-aarch64' : 'windows-x86_64';
    if (/linux|x11/.test(ua)) return arm ? 'linux-aarch64' : 'linux-x86_64';
    return 'darwin-aarch64';
  }

  var LABELS = {
    'darwin-aarch64': 'macOS · Apple silicon',
    'darwin-x86_64': 'macOS · Intel',
    'windows-x86_64': 'Windows · x64',
    'windows-aarch64': 'Windows · arm64',
    'linux-x86_64': 'Linux · x64',
    'linux-aarch64': 'Linux · arm64'
  };

  function shortLabel(key) {
    if (key === 'windows-x86_64') return 'Download for Windows (x64)';
    if (key === 'windows-aarch64') return 'Download for Windows (arm64)';
    if (key === 'linux-x86_64') return 'Download for Linux (x64)';
    if (key === 'linux-aarch64') return 'Download for Linux (arm64)';
    if (key === 'darwin-aarch64') return 'Download for macOS (Apple silicon)';
    return 'Download for macOS (Intel)';
  }

  // The manifest is cacheable for five minutes at the edge; the query string keeps a
  // freshly published release from being hidden behind an older copy.
  fetch(MANIFEST + '?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (m) {
      if (!m || !m.version || !m.platforms) return;
      var platforms = m.platforms;
      var auto = detect();
      var anyShown = false;
      var tagBase = 'https://github.com/wzul/dbdesk-app/releases/download/v' + m.version + '/DB.Desk_' + m.version + '_';

      // latest.json lists what the *updater* downloads. On macOS that is the
      // .app.tar.gz, but a first-time visitor wants the DMG — same release, same
      // version, so derive it rather than publishing a second manifest field.
      function downloadUrl(key, entry) {
        if (key === 'darwin-aarch64') return tagBase + 'aarch64.dmg';
        if (key === 'darwin-x86_64') return tagBase + 'x64.dmg';
        return entry.url;
      }

      var autoBtn = null;

      buttons.forEach(function (btn) {
        var key = btn.getAttribute('data-dl');
        if (key === 'auto') { autoBtn = btn; key = auto; }
        var entry = platforms[key];
        if (!entry || !entry.url) {          // platform not published yet
          btn.hidden = true;
          return;
        }
        btn.setAttribute('href', downloadUrl(key, entry));
        var label = btn.querySelector('[data-dl-label]');
        if (label) label.textContent = btn.hasAttribute('data-dl-short') ? shortLabel(key) : (LABELS[key] || label.textContent);
        btn.hidden = false;
        anyShown = true;
      });

      var version = document.querySelector('[data-dl-version]');
      if (version) version.textContent = 'v' + m.version;

      // Debian/Ubuntu/Mint and Fedora/RHEL/openSUSE get their native packages; only
      // offered once Linux is actually published. The names are the ones release.yml
      // stages, derived from the same tag.
      var extras = document.querySelector('[data-dl-extras]');
      if (extras) {
        var linuxKey = platforms['linux-x86_64'] ? 'x64' : platforms['linux-aarch64'] ? 'arm64' : '';
        if (linuxKey) {
          var rel = 'https://github.com/wzul/dbdesk-app/releases/download/v' + m.version + '/DB.Desk_' + m.version + '_' + linuxKey;
          var deb = extras.querySelector('[data-dl-deb]');
          var rpm = extras.querySelector('[data-dl-rpm]');
          if (deb) deb.setAttribute('href', rel + '.deb');
          if (rpm) rpm.setAttribute('href', rel + '.rpm');
          extras.hidden = false;
        } else {
          extras.hidden = true;
        }
      }

      // This visitor's platform may not be published yet (a Windows or Linux
      // visitor while only macOS is out): keep the primary button on the release
      // page instead of leaving the hero without a download at all.
      if (autoBtn && autoBtn.hidden) {
        autoBtn.hidden = false;
        autoBtn.setAttribute('href', 'https://github.com/wzul/dbdesk-app/releases/latest');
        var autoLabel = autoBtn.querySelector('[data-dl-label]');
        if (autoLabel) autoLabel.textContent = 'All downloads';
      }

      // If nothing at all is published for a known platform, fall back to the
      // release page rather than an empty button row.
      if (!anyShown) {
        buttons.forEach(function (btn) {
          btn.hidden = false;
          btn.setAttribute('href', 'https://github.com/wzul/dbdesk-app/releases/latest');
        });
      }
    })
    .catch(function () { /* keep the release-page links */ });
  // Shortcut labels are written as ⌘ in the markup because that is the idiom on a Mac.
  // A Windows or Linux visitor would be told to press a key they do not have, so swap
  // the symbol in place — text nodes only, so no markup or attributes are touched, and
  // the page still reads ⌘ when scripting is off.
  // navigator.platform is non-empty on every browser, so the UA fallback below it never
  // ran; prefer the modern hint and only then the deprecated one.
  var isMac = navigator.userAgentData && navigator.userAgentData.platform
    ? /mac/i.test(navigator.userAgentData.platform)
    : /mac/i.test(navigator.platform || navigator.userAgent || '');
  if (!isMac && document.body) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentNode && node.parentNode.nodeName;
        if (parent === 'SCRIPT' || parent === 'STYLE') return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.indexOf('\u2318') !== -1
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    });
    var hits = [];
    while (walker.nextNode()) hits.push(walker.currentNode);
    hits.forEach(function (node) {
      node.nodeValue = node.nodeValue.replace(/\u2318\s*/g, 'Ctrl+');
    });
  }
})();
