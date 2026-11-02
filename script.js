(() => {
  'use strict';

  const previousSections = new Set(['#workflow', '#stack', '#capabilities', '#architecture']);
  if (document.body.dataset.page === 'overview' && previousSections.has(location.hash)) {
    const details = new URL('./details.html', location.href);
    details.hash = location.hash;
    location.replace(details.href);
    return;
  }

  const menu = document.querySelector('.menu-toggle');
  const navigation = document.getElementById('primary-nav');
  if (!menu || !navigation) return;

  const closeMenu = () => {
    menu.setAttribute('aria-expanded', 'false');
    navigation.classList.remove('is-open');
    const label = menu.querySelector('.sr-only');
    if (label) label.textContent = '打开导航菜单';
  };

  menu.addEventListener('click', () => {
    const opened = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(opened));
    navigation.classList.toggle('is-open', opened);
    const label = menu.querySelector('.sr-only');
    if (label) label.textContent = opened ? '关闭导航菜单' : '打开导航菜单';
  });

  navigation.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    closeMenu();
    if (link.hash && link.origin === location.origin && link.pathname === location.pathname) {
      const section = document.getElementById(link.hash.slice(1));
      if (section) {
        section.setAttribute('tabindex', '-1');
        section.focus({ preventScroll: true });
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      menu.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (menu.getAttribute('aria-expanded') === 'true' && !event.target.closest('.site-header')) closeMenu();
  });

  const wideViewport = window.matchMedia('(min-width: 651px)');
  wideViewport.addEventListener('change', (event) => {
    if (event.matches) closeMenu();
  });

  const navLinks = [...navigation.querySelectorAll('a[href^="#"]')];
  const sections = navLinks.map((link) => document.getElementById(link.hash.slice(1))).filter(Boolean);
  if (!('IntersectionObserver' in window)) return;

  const visibleSections = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleSections.add(entry.target.id);
      else visibleSections.delete(entry.target.id);
    }
    const active = sections.find((section) => visibleSections.has(section.id));
    for (const link of navLinks) {
      if (active && link.hash === `#${active.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }, { rootMargin: '-100px 0px -50% 0px', threshold: 0 });

  sections.forEach((section) => observer.observe(section));
})();
