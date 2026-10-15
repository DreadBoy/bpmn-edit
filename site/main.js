// Copy button for the install command, and hero video autoplay that respects
// prefers-reduced-motion. Without JavaScript the video still has controls.

(function () {
  var video = document.getElementById('hero-video');
  if (video) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    var sync = function () {
      if (reduce && reduce.matches) {
        video.pause();
      } else {
        var p = video.play();
        if (p && p.catch) p.catch(function () { /* autoplay blocked: controls remain */ });
      }
    };
    sync();
    if (reduce && reduce.addEventListener) reduce.addEventListener('change', sync);
  }

  var buttons = document.querySelectorAll('button[data-copy]');
  Array.prototype.forEach.call(buttons, function (button) {
    var label = button.querySelector('.copy-label');
    var status = button.parentNode.querySelector('.copy-status');
    var timer;

    function show(text, done) {
      label.textContent = text;
      button.classList.toggle('is-done', done);
      if (status) status.textContent = done ? 'Command copied to clipboard' : 'Copy failed. Select the command and copy it yourself.';
      clearTimeout(timer);
      timer = setTimeout(function () {
        label.textContent = 'Copy';
        button.classList.remove('is-done');
        if (status) status.textContent = '';
      }, 2000);
    }

    function fallback(text) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      button.focus();
      return ok;
    }

    button.addEventListener('click', function () {
      var text = button.getAttribute('data-copy');
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          function () { show('Copied', true); },
          function () { var ok = fallback(text); show(ok ? 'Copied' : 'Failed', ok); }
        );
      } else {
        var ok = fallback(text);
        show(ok ? 'Copied' : 'Failed', ok);
      }
    });
  });
})();
