/*
 * Android TV / TV box D-pad focus navigation for the Capacitor WebView.
 *
 * This file is intentionally a plain static script (not part of the React bundle):
 * it only activates on Android devices without a touch screen, so phones,
 * tablets, desktop and iOS builds keep their original behaviour byte-for-byte.
 *
 * Force-enable for debugging: localStorage.setItem('foliaTvDpad', '1')
 */
(function () {
  'use strict';

  var ua = navigator.userAgent || '';
  var isAndroid = /Android/i.test(ua);
  var isMobileUa = /Mobile/i.test(ua);
  var noTouch = (navigator.maxTouchPoints || 0) === 0;
  var forced = false;
  try { forced = localStorage.getItem('foliaTvDpad') === '1'; } catch (e) { /* ignore */ }

  // Android TV WebView UA has no "Mobile" token. Some boxes wrongly send it,
  // so a device with zero touch points is treated as a TV as well.
  if (!forced && !(isAndroid && (!isMobileUa || noTouch))) return;
  if (window.__foliaTvDpadInstalled) return;
  window.__foliaTvDpadInstalled = true;

  var style = document.createElement('style');
  style.textContent = [
    '[data-tv-focusable]{outline:none}',
    '[data-tv-focusable]:focus{',
    '  outline:3px solid #7dd3fc !important;',
    '  outline-offset:2px !important;',
    '  box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 20px rgba(125,211,252,.5) !important;',
    '  position:relative;z-index:2147483000;',
    '}'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  var SELECTOR = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[tabindex]',
    '[class*="btn"]', '[class*="Btn"]', '[class*="button"]', '[class*="Button"]'
  ].join(',');
  var NATIVE = /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/;

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
    var s;
    try { s = getComputedStyle(el); } catch (e) { return false; }
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) < 0.15) return false;
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  function scan() {
    var nodes = document.querySelectorAll(SELECTOR);
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      if (el.hasAttribute('tabindex')) {
        if (el.getAttribute('tabindex') === '-1') continue;
      } else {
        // React onClick handlers are not visible on the DOM node; computed
        // cursor:pointer is the best signal for custom clickable divs.
        if (!NATIVE.test(el.tagName)) {
          try { if (getComputedStyle(el).cursor !== 'pointer') continue; } catch (e) { continue; }
        }
        el.setAttribute('tabindex', '0');
      }
      el.setAttribute('data-tv-focusable', '1');
      list.push(el);
    }
    return list;
  }

  function center(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function move(dir) {
    var list = scan();
    if (!list.length) return;
    var cur = document.activeElement;
    var from;
    if (cur && cur !== document.body && visible(cur)) from = center(cur);
    else { list[0].focus({ preventScroll: true }); return; }

    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === cur) continue;
      var c = center(el);
      var dx = c.x - from.x;
      var dy = c.y - from.y;
      var horizontal = dir === 'left' || dir === 'right';
      var main = horizontal ? dx : dy;
      var cross = horizontal ? dy : dx;
      var ok = dir === 'right' ? main > 12 : dir === 'left' ? main < -12
             : dir === 'down' ? main > 12 : main < -12;
      if (!ok) continue;
      // Prefer the element straight ahead; penalise off-axis candidates.
      var score = Math.abs(main) + Math.abs(cross) * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) {
      best.focus({ preventScroll: false });
      try { best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    }
  }

  var KEY_NAMES = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  var KEY_CODES = { 19: 'up', 20: 'down', 21: 'left', 22: 'right' };

  document.addEventListener('keydown', function (e) {
    var dir = KEY_NAMES[e.key] || KEY_CODES[e.keyCode];
    if (dir) {
      e.preventDefault();
      e.stopPropagation();
      move(dir);
      return;
    }
    // DPAD_CENTER / Enter / Space on custom divs (native controls already
    // handle activation themselves).
    if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 23) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-tv-focusable') && !NATIVE.test(t.tagName)) {
        e.preventDefault();
        t.click();
      }
    }
  }, true);

  // Give the first screen an initial focus so the very first arrow key works.
  function initialFocus() {
    var list = scan();
    if (list.length && (!document.activeElement || document.activeElement === document.body)) {
      list[0].focus({ preventScroll: true });
    }
  }
  if (document.readyState === 'complete') setTimeout(initialFocus, 900);
  else window.addEventListener('load', function () { setTimeout(initialFocus, 900); });
})();
