// Статический генератор сайта об обманных паттернах.
// Читает content/patterns/*.md, отдаёт dist/ с HTML и общим CSS.
// Модель данных: mechanism (группа) + spheres (теги «где встречается») + related (slug'и).
// Без зависимостей — node build.mjs

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SRC = join(root, 'content');
const OUT = join(root, 'dist');

// Базовый путь для GitHub Pages (проектный сайт живёт под /<repo>/).
// Локально BASE_PATH не задан → пустой префикс. В CI задаётся как "/<repo>".
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const u = p => (typeof p === 'string' && p.startsWith('/')) ? BASE + p : p;

// Порядок групп-механизмов
const MECHANISMS = [
  'Сокрытие информации',
  'Препятствия',
  'Давление',
  'Принуждение',
  'Подмена смысла',
  'Интерфейсные уловки',
  'Сбор данных',
  'Игровые механики',
  'Удержание внимания',
];

// Порядок паттернов внутри сайта
const ORDER = [
  // Сокрытие информации
  'sneaking', 'hidden-costs', 'hidden-subscription', 'disguised-ads', 'fake-installments',
  // Препятствия
  'obstruction', 'hard-to-cancel', 'comparison-prevention',
  // Давление
  'fake-urgency', 'fake-scarcity', 'fake-social-proof', 'upselling', 'scaremongering',
  // Принуждение
  'forced-action', 'nagging',
  // Подмена смысла
  'trick-wording', 'confirmshaming', 'bait-and-switch', 'trick-questions', 'email-push',
  // Интерфейсные уловки
  'visual-interference', 'preselection', 'false-hierarchy',
  // Сбор данных
  'privacy-zuckering', 'friend-spam',
  // Игровые механики
  'loot-boxes', 'virtual-currency',
  // Удержание внимания
  'attention-capture',
];

// ----- утилиты -----
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('[')) {
      try { data[mm[1]] = JSON.parse(v); continue; } catch { /* fallthrough */ }
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[mm[1]] = v;
  }
  return { data, body: m[2] };
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// внутренние ссылки /patterns/<slug>/ -> /patterns/<slug>.html
const fixHref = href =>
  /^\/patterns\/[a-z0-9-]+\/$/.test(href) ? href.replace(/\/$/, '.html') : href;

function inline(text) {
  let t = esc(text);
  t = t.replace(/\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, label, href) => `<a href="${u(fixHref(href))}">${label}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}

function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^---\s*$/.test(line)) { html += '<hr>\n'; i++; continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const lvl = h[1].length; html += `<h${lvl}>${inline(h[2])}</h${lvl}>\n`; i++; continue; }

    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      html += `<blockquote><p>${inline(buf.join(' '))}</p></blockquote>\n`;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const head = line.split('|').map(s => s.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(lines[i].split('|').map(s => s.trim()).filter(Boolean)); i++;
      }
      html += '<div class="table-wrap"><table><thead><tr>' +
        head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>\n';
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      html += '<ul>\n';
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>\n`; i++;
      }
      html += '</ul>\n';
      continue;
    }

    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|[-*]\s|---\s*$)/.test(lines[i]) && !lines[i].includes('|')) {
      buf.push(lines[i]); i++;
    }
    html += `<p>${inline(buf.join(' '))}</p>\n`;
  }
  return html;
}

// ----- шаблон страницы -----
// Разделы сайта (отдельные страницы) — справа в навбаре
const NAV_SECTIONS = [
  ['Каталог', '/patterns/'],
  ['Этичный дизайн', '/ethics.html'],
  ['Манифест', '/manifesto.html'],
];
// Навигация по странице (якоря главной) — слева от разделителя
const NAV_PAGE = [
  ['Закон РФ', '/#laws'],
  ['Куда жаловаться', '/#help'],
  ['О проекте', '/#about'],
];

function layout({ title, description, body, active }) {
  const link = ([label, href]) =>
    `<a href="${u(href)}"${active === href ? ' class="is-active"' : ''}>${label}</a>`;
  const navPage = NAV_PAGE.map(link).join('');
  const navSections = NAV_SECTIONS.map(link).join('');
  const navDrawer = [...NAV_SECTIONS, ...NAV_PAGE].map(link).join('');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();</script>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || '')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${u('/assets/styles.css')}">
</head>
<body>
<header class="navbar">
  <div class="shell navbar__inner">
    <a class="brand" href="${u('/')}">
      <span class="brand__mark">!</span>
      <span class="brand__name">Обманные<span class="brand__dot">.</span>паттерны</span>
    </a>
    <div class="navbar__actions">
      <div class="nav-groups">
        <nav class="nav">${navPage}</nav>
        <span class="nav-divider" aria-hidden="true"></span>
        <nav class="nav nav--sections">${navSections}</nav>
      </div>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Переключить тему">
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      </button>
      <button class="nav-toggle" id="navToggle" aria-label="Открыть меню" aria-expanded="false">☰ Меню</button>
    </div>
  </div>
</header>
<div class="drawer" id="drawer" hidden>
  <div class="drawer__overlay" data-drawer-close></div>
  <div class="drawer__panel" role="dialog" aria-modal="true" aria-label="Меню">
    <div class="drawer__handle"></div>
    <nav class="drawer__nav">${navDrawer}</nav>
  </div>
</div>
<main>
${body}
</main>
<footer class="footer">
  <div class="shell footer__inner">
    <div>
      <p class="footer__brand">Обманные паттерны</p>
      <p class="footer__soft">Просветительский проект о тёмных приёмах в дизайне интерфейсов на примере продуктов СНГ. Материалы не являются юридической консультацией.</p>
    </div>
    <nav class="footer__nav">
      <a href="${u('/patterns/')}">Все типы</a>
      <a href="${u('/#spheres')}">Где встречается</a>
      <a href="${u('/#laws')}">Закон РФ</a>
      <a href="${u('/#help')}">Куда жаловаться</a>
    </nav>
  </div>
</footer>
<script>
(function () {
  var tt = document.getElementById('themeToggle');
  if (tt) tt.addEventListener('click', function () {
    var dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
  });
})();
(function () {
  var t = document.getElementById('navToggle'), d = document.getElementById('drawer');
  if (!t || !d) return;
  function open() { d.hidden = false; requestAnimationFrame(function () { d.classList.add('is-open'); }); t.setAttribute('aria-expanded', 'true'); document.body.style.overflow = 'hidden'; }
  function close() { d.classList.remove('is-open'); t.setAttribute('aria-expanded', 'false'); document.body.style.overflow = ''; setTimeout(function () { d.hidden = true; }, 300); }
  t.addEventListener('click', open);
  d.addEventListener('click', function (e) { if (e.target.hasAttribute('data-drawer-close')) close(); });
  d.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', close); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !d.hidden) close(); });
})();
</script>
</body>
</html>`;
}

// ----- чтение паттернов -----
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'patterns'), { recursive: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

const patternFiles = readdirSync(join(SRC, 'patterns')).filter(f => f.endsWith('.md') && f !== '_index.md');
const patterns = patternFiles.map(f => {
  const { data, body } = parseFrontmatter(readFileSync(join(SRC, 'patterns', f), 'utf8'));
  const htmlSlug = (data.slug || '').replace(/^\/patterns\//, '').replace(/\/$/, '');
  return { ...data, file: f, htmlSlug, spheres: data.spheres || [], related: data.related || [], body };
}).sort((a, b) => ORDER.indexOf(a.htmlSlug) - ORDER.indexOf(b.htmlSlug));

const bySlug = Object.fromEntries(patterns.map(p => [p.htmlSlug, p]));

// группировка по механизму в заданном порядке
const groups = MECHANISMS
  .map(name => ({ name, items: patterns.filter(p => p.mechanism === name) }))
  .filter(g => g.items.length);

const sphereTag = s => `<span class="tag">${esc(s)}</span>`;

// ----- страницы паттернов -----
for (const p of patterns) {
  const article = `
<article class="prose-page">
  <div class="shell prose-page__inner">
    <aside class="prose-aside">
      <a class="back" href="${u('/patterns/')}">← Все типы</a>
      <span class="pill">${esc(p.mechanism)}</span>
      <div class="aside-block">
        <p class="overline">Где встречается</p>
        <div class="tags">${p.spheres.map(sphereTag).join('')}</div>
      </div>
    </aside>
    <div class="prose">
${mdToHtml(p.body.replace(/^#\s+.*\n/, ''))}
    </div>
  </div>
</article>`;
  writeFileSync(join(OUT, 'patterns', p.htmlSlug + '.html'),
    layout({ title: `${p.title} — Обманные паттерны`, description: p.description, body: article, active: '/patterns/' }));
}

// ----- каталог -----
// Английские эквиваленты терминов + ссылка на англ. Википедию.
// По умолчанию — общая статья Deceptive pattern; где есть отдельная статья — она.
const WIKI = 'https://en.wikipedia.org/wiki/Deceptive_pattern';
const EN = {
  'sneaking': ['Sneaking'],
  'hidden-costs': ['Hidden costs'],
  'hidden-subscription': ['Hidden subscription'],
  'disguised-ads': ['Disguised ads'],
  'obstruction': ['Obstruction'],
  'hard-to-cancel': ['Roach motel'],
  'comparison-prevention': ['Comparison prevention'],
  'fake-urgency': ['Fake urgency'],
  'fake-scarcity': ['Fake scarcity'],
  'fake-social-proof': ['Fake social proof'],
  'forced-action': ['Forced action'],
  'nagging': ['Nagging'],
  'trick-wording': ['Trick wording'],
  'confirmshaming': ['Confirmshaming'],
  'bait-and-switch': ['Bait and switch'],
  'trick-questions': ['Trick questions'],
  'email-push': ['Manipulative notifications'],
  'visual-interference': ['Visual interference'],
  'preselection': ['Preselection'],
  'false-hierarchy': ['False hierarchy'],
  'privacy-zuckering': ['Privacy zuckering'],
  'friend-spam': ['Friend spam'],
  'loot-boxes': ['Loot box', 'https://en.wikipedia.org/wiki/Loot_box'],
  'virtual-currency': ['Virtual currency', 'https://en.wikipedia.org/wiki/Virtual_economy'],
  'attention-capture': ['Attention capture', 'https://en.wikipedia.org/wiki/Attention_economy'],
  'scaremongering': ['Scareware', 'https://en.wikipedia.org/wiki/Scareware'],
};

const card = p => {
  const e = EN[p.htmlSlug] || [];
  const enName = e[0];
  const enWiki = e[1] || WIKI;
  return `<div class="card">
  <a class="card__link" href="${u('/patterns/' + p.htmlSlug + '.html')}">
    <h3 class="card__title">${esc(p.title)}</h3>
    <p class="card__desc">${esc(p.description)}</p>
  </a>
  ${enName ? `<a class="card__en" href="${enWiki}" target="_blank" rel="noopener" title="Англ. термин на Википедии">${esc(enName)} ↗</a>` : ''}
  <div class="tags tags--card">${p.spheres.map(sphereTag).join('')}</div>
</div>`;
};

// Материалы по теме (только рабочие ссылки)
const MATERIALS = [
  ['🎯', 'Тёмные паттерны: как уловки в дизайне обманывают пользователей', 'Что это, примеры крупных компаний и попытки регуляторов ограничить практику.', 'https://trends.rbc.ru/trends/industry/60feaaeb9a79473e32ca7b12'],
  ['🧠', 'Тёмные паттерны в дизайне: что это такое', 'Основные типы приёмов, примеры и последствия для бизнеса.', 'https://qwer.agency/tpost/m6jxb7idb1-temnie-patterni-v-dizaine-chto-eto-takoe'],
  ['⚠️', '14 тёмных паттернов, которых стоит избегать', 'Подробный разбор распространённых приёмов с примерами.', 'https://wybex.ru/tutorials/14-design-dark-patterns-youll-want-to-avoid/'],
  ['🪤', 'Как тёмные UX-паттерны заставляют делать то, чего вы не хотите', 'Психологические уловки в интерфейсах и как их замечать.', 'https://say-hi.me/design/dark-ux.html'],
  ['⚖️', 'От конверсии любой ценой — к этичному дизайну', 'Почему манипуляции вредят бизнесу и как проектировать честно.', 'https://blog.digimatix.ru/articles/ot-konversii-lyuboj-cenoj-k-etichnomu-dizajnu/'],
  ['📚', 'Timeweb Community: статьи о дизайне и UX', 'Сообщество с материалами о дизайне, UX и тёмных паттернах.', 'https://timeweb.com/ru/community/'],
  ['🎓', 'What are dark patterns in UX? All you need to know', 'Гайд по тёмным паттернам и этичному дизайну (на англ.).', 'https://www.uxdesigninstitute.com/blog/what-are-dark-patterns-in-ux/'],
  ['🎨', 'Dark Patterns in UX', 'Как распознавать и избегать тёмных паттернов (на англ.).', 'https://adamfard.com/blog/dark-patterns-ux'],
];

const matCard = ([emoji, title, desc, href]) => {
  const host = href.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  return `<a class="card card--mat" href="${href}" target="_blank" rel="noopener">
  <span class="card__emoji">${emoji}</span>
  <h3 class="card__title">${esc(title)}</h3>
  <p class="card__desc">${esc(desc)}</p>
  <span class="card__src">${esc(host)} ↗</span>
</a>`;
};

const catBody = `
<section class="page-head">
  <div class="shell">
    <span class="eyebrow">Каталог</span>
    <h1>Все типы обманных паттернов</h1>
    <p class="lead">${patterns.length} приёмов, которыми сайты и приложения подталкивают вас к невыгодным решениям. Сгруппированы по принципу действия; у каждого помечены сферы, где он встречается.</p>
  </div>
</section>
${groups.map(g => `
<section class="cat">
  <div class="shell">
    <h2 class="cat__title">${esc(g.name)}</h2>
    <div class="grid">${g.items.map(card).join('')}</div>
  </div>
</section>`).join('')}`;
writeFileSync(join(OUT, 'patterns', 'index.html'),
  layout({ title: 'Все типы обманных паттернов', description: 'Каталог из 16 типов обманных паттернов интерфейса на примере продуктов СНГ.', body: catBody, active: '/patterns/' }));

// ----- главная -----
const featured = patterns.slice(0, 6);
const SPHERES = ['🏦 Банки', '🛒 Маркетплейсы', '▶️ Подписки и стриминги', '🚕 Доставка и такси', '📞 Операторы связи', '📱 Игры и приложения', '🌐 Соцсети и контент', '🏛 Госсервисы'];

const homeBody = `
<section class="hero">
  <div class="shell">
    <div class="hero__banner">
      <span class="eyebrow">разбираем тёмные приёмы интерфейсов на примере СНГ</span>
      <h1 class="hero__title">Обманные паттерны заставляют людей делать то, чего они не хотели.</h1>
      <p class="hero__lead">Это не просто «неудобный дизайн». Это намеренно выстроенные ловушки в сайтах и приложениях, которые используют психологию против вас — чтобы вы купили лишнее, отдали данные или подписались, сами того не желая.</p>
      <div class="hero__cta">
        <a class="btn btn--primary" href="${u('/patterns/')}">Смотреть все ${patterns.length} типов</a>
        <a class="btn btn--ghost" href="#what">Что это такое</a>
      </div>
    </div>
  </div>
</section>

<section class="sec" id="what">
  <div class="shell sec__grid">
    <div class="sec__col">
      <h2>Что такое обманные паттерны?</h2>
      <p>Обманные паттерны (англ. <em>deceptive patterns</em>, ранее — <em>dark patterns</em>) — это приёмы в дизайне, которые подталкивают человека к действиям, которых он не планировал: оформить подписку, купить ненужное, отдать больше личных данных.</p>
      <p>Они эксплуатируют особенности восприятия: невнимательность, спешку, доверие к умолчаниям и страх упустить выгоду.</p>
    </div>
    <ul class="sec__pills">
      <li>🛒 Подсовывание</li><li>💬 Обманчивые формулировки</li><li>🚧 Препятствование</li>
      <li>⏰ Ложная срочность</li><li>💸 Скрытые расходы</li><li>☑️ Предвыбор</li>
    </ul>
  </div>
</section>

<section class="sec sec--types">
  <div class="shell">
    <div class="sec__head">
      <h2>${patterns.length} типов обманных паттернов</h2>
      <a class="link-more" href="${u('/patterns/')}">Весь каталог →</a>
    </div>
    <div class="grid">${featured.map(card).join('')}</div>
  </div>
</section>

<section class="sec sec--spheres" id="spheres">
  <div class="shell">
    <h2>Где вы с этим сталкиваетесь</h2>
    <p class="lead">Одни и те же приёмы встречаются в самых разных продуктах. Мы помечаем каждый паттерн сферами, чтобы было видно, где он работает.</p>
    <div class="chips">${SPHERES.map(s => `<span class="chip">${s}</span>`).join('')}</div>
  </div>
</section>

<section class="sec sec--inverse" id="laws">
  <div class="shell sec__grid">
    <div class="sec__col">
      <h2>Что говорит закон РФ</h2>
      <p>Многие обманные паттерны в России уже нарушают закон — в зависимости от приёма и контекста.</p>
    </div>
    <div class="sec__col">
      <p class="overline">Основные нормы</p>
      <p>Закон «О защите прав потребителей» (ст. 10, 16), 152-ФЗ «О персональных данных» (ст. 9), 38-ФЗ «О рекламе» (ст. 5, 18).</p>
      <p class="overline">Что под запретом</p>
      <p>Навязывание услуг, недостоверная цена и реклама, согласия «по умолчанию», скрытые подписки и непрозрачная отмена.</p>
    </div>
  </div>
</section>

<section class="sec" id="help">
  <div class="shell">
    <h2>Куда жаловаться</h2>
    <p class="lead">Если вы столкнулись с обманным приёмом, защитить права помогут профильные ведомства.</p>
    <div class="stats">
      <a class="stat" href="https://www.rospotrebnadzor.ru/" target="_blank" rel="noopener"><span class="stat__num">Роспотреб­надзор ↗</span><span class="stat__lbl">навязывание услуг, недостоверная информация, права потребителя</span></a>
      <a class="stat" href="https://fas.gov.ru/" target="_blank" rel="noopener"><span class="stat__num">ФАС ↗</span><span class="stat__lbl">недобросовестная и недостоверная реклама, спам</span></a>
      <a class="stat" href="https://www.cbr.ru/reception/" target="_blank" rel="noopener"><span class="stat__num">ЦБ РФ ↗</span><span class="stat__lbl">мисселинг и навязывание финансовых услуг и подписок</span></a>
      <a class="stat" href="https://rkn.gov.ru/" target="_blank" rel="noopener"><span class="stat__num">Роскомнадзор ↗</span><span class="stat__lbl">нарушения при обработке персональных данных</span></a>
    </div>
  </div>
</section>

<section class="sec" id="materials">
  <div class="shell">
    <div class="sec__head">
      <h2>Материалы по теме</h2>
    </div>
    <p class="lead">Подборка статей о тёмных паттернах и этичном дизайне — на русском и английском.</p>
    <div class="grid grid--mat">${MATERIALS.map(matCard).join('')}</div>
  </div>
</section>

<section class="sec sec--about" id="about">
  <div class="shell">
    <div class="sec__narrow">
      <h2>О проекте</h2>
      <p>Мы собираем и разбираем обманные паттерны на русском языке и на примере продуктов СНГ, чтобы пользователи научились их замечать, а дизайнеры и продакты — отказываться от тёмных практик. Примеры приводятся по открытым источникам и описывают распространённые практики, а не доказанные нарушения конкретных компаний.</p>
      <a class="btn btn--primary" href="${u('/patterns/')}">Изучить каталог</a>
    </div>
  </div>
</section>`;
writeFileSync(join(OUT, 'index.html'),
  layout({ title: 'Обманные паттерны интерфейсов', description: 'Каталог обманных паттернов (dark patterns) на русском языке на примере продуктов СНГ.', body: homeBody, active: '/' }));

// ----- отдельные страницы (Этичный дизайн, Манифест) -----
for (const page of [
  { file: 'ethics.md', out: 'ethics.html', aside: 'Материалы' },
  { file: 'manifesto.md', out: 'manifesto.html', aside: 'Манифест' },
]) {
  const { data, body } = parseFrontmatter(readFileSync(join(SRC, page.file), 'utf8'));
  const docBody = `
<article class="prose-page">
  <div class="shell prose-page__inner">
    <aside class="prose-aside">
      <a class="back" href="${u('/')}">← На главную</a>
      <span class="pill">${page.aside}</span>
    </aside>
    <div class="prose">
${mdToHtml(body)}
    </div>
  </div>
</article>`;
  writeFileSync(join(OUT, page.out),
    layout({ title: `${data.title} — Обманные паттерны`, description: data.description, body: docBody, active: '/' + page.out }));
}

cpSync(join(root, 'assets', 'styles.css'), join(OUT, 'assets', 'styles.css'));
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`Готово: ${patterns.length} паттернов, ${groups.length} групп → dist/ (BASE="${BASE || '/'}")`);
