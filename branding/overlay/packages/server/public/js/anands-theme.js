/* Anands Notes - light/dark theme. Follows the OS by default; the toggle stores an override. */
(function () {
	var KEY = 'anands-theme';
	var root = document.documentElement;
	function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
	function systemDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
	function current() { var s = stored(); return (s === 'dark' || s === 'light') ? s : (systemDark() ? 'dark' : 'light'); }
	function apply() { root.setAttribute('data-theme', current()); }
	apply();
	if (window.matchMedia) {
		var mq = window.matchMedia('(prefers-color-scheme: dark)');
		if (mq.addEventListener) mq.addEventListener('change', apply);
	}
	document.addEventListener('DOMContentLoaded', function () {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'anands-theme-toggle';
		function label() {
			var dark = current() === 'dark';
			b.textContent = dark ? '☀' : '☾';
			b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
			b.setAttribute('aria-label', b.title);
		}
		b.addEventListener('click', function () {
			try { localStorage.setItem(KEY, current() === 'dark' ? 'light' : 'dark'); } catch (e) {}
			apply(); label();
		});
		label();
		document.body.appendChild(b);
	});
})();
