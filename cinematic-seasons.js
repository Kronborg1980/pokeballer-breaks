/* Local vector seasonal scenes: no image downloads or animation loops. */
(() => {
  'use strict';
  if (window.__pbmCinematicSeasons) return;
  window.__pbmCinematicSeasons = true;

  const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 320" fill="none" aria-hidden="true" focusable="false">${content}</svg>`;
  const sparkles = '<g fill="#fff0b8"><path d="m42 78 5 12 12 5-12 5-5 12-5-12-12-5 12-5ZM255 218l5 12 12 5-12 5-5 12-5-12-12-5 12-5Z"/><circle cx="248" cy="78" r="3"/><circle cx="56" cy="242" r="3"/></g>';
  const ball = (x, y, r, color) => `<g transform="translate(${x} ${y})"><circle r="${r}" fill="#fff3e5" stroke="#261d38" stroke-width="${r * .1}"/><path d="M-${r} 0a${r} ${r} 0 0 1 ${r * 2} 0Z" fill="${color}"/><path d="M-${r} 0h${r * 2}" stroke="#261d38" stroke-width="${r * .12}"/><circle r="${r * .24}" fill="#fff5df" stroke="#261d38" stroke-width="${r * .08}"/><circle r="${r * .11}" fill="#fff"/></g>`;
  const pumpkin = svg(`${sparkles}<ellipse cx="150" cy="279" rx="100" ry="11" fill="#140c24" opacity=".5"/><path d="M149 86q-9-31 15-45l18 9q-24 11-15 40" fill="#81b94b" stroke="#213d32" stroke-width="4"/><ellipse cx="150" cy="181" rx="107" ry="95" fill="#ff9b36" stroke="#ffd280" stroke-width="3"/><path d="M150 87c-62 37-62 151 0 188M150 87c62 37 62 151 0 188" stroke="#c65b2f" stroke-width="5" opacity=".6"/><path d="m88 153 29-20 12 31-34-1ZM212 153l-29-20-12 31 34-1Z" fill="#38223e"/><path d="M44 188h212" stroke="#38223e" stroke-width="12"/><path d="M73 218q77 83 154 0l-25 8-8 18-23-3-21 14-22-14-22 3-9-18Z" fill="#38223e"/>${ball(150, 188, 22, '#c774ff')}`);
  const gengar = svg(`${sparkles}<ellipse cx="150" cy="286" rx="100" ry="12" fill="#140c24" opacity=".5"/><path d="m71 133-21-72 64 35 22-24 11 24 25-28 13 33 63-40-20 83q35 49 13 97l18 24-45-3-22 25-28-8-29 7-25-24-42 4 18-28q-21-52 14-105Z" fill="#8e61c1" stroke="#bca0f3" stroke-width="3"/><path d="m76 146 54 12-13 29-32-12ZM224 146l-54 12 13 29 32-12Z" fill="#ff786c"/><path d="m115 158-2 19m72-19 2 19" stroke="#281f3f" stroke-width="7"/><path d="M81 199q69 31 138 0-11 64-69 65-58-1-69-65Z" fill="#fff4dd" stroke="#452f66" stroke-width="4"/><path d="M90 222q60 24 120 0m-92-13 4 43m28-39v50m28-54-4 43" stroke="#76508b" stroke-width="3"/>`);
  const tree = svg(`${sparkles}<ellipse cx="150" cy="293" rx="110" ry="12" fill="#06312d" opacity=".55"/><rect x="137" y="258" width="27" height="35" rx="5" fill="#9c6850"/><path d="m150 51 61 103h-27l56 67h-31l44 54H47l44-54H60l56-67H89Z" fill="#167c69" stroke="#84ecc5" stroke-width="3"/><path d="m150 68 37 66h-19l39 61h-25l38 56" stroke="#42bd8c" stroke-width="9" stroke-linecap="round"/><path d="M100 151q51 29 100 0M76 218q74 26 147-1" stroke="#f4edbb" stroke-width="5" stroke-linecap="round"/><path d="m150 19 10 20 22 3-16 15 4 22-20-11-20 11 4-22-16-15 22-3Z" fill="#ffe4a0" stroke="#fff4d2" stroke-width="2"/>${ball(126, 165, 13, '#ed5667')}${ball(178, 225, 15, '#ed5667')}${ball(111, 246, 12, '#6ccaf4')}<path d="M64 278h173" stroke="#d9fff2" stroke-width="9" stroke-linecap="round"/>`);
  const winterBall = svg(`${sparkles}<g stroke="#b5f0ff" stroke-width="3" stroke-linecap="round"><path d="M49 133v36m-16-27 32 18m-32 0 32-18M246 105v30m-13-23 26 16m-26 0 26-16"/></g><ellipse cx="150" cy="280" rx="98" ry="12" fill="#092d35" opacity=".5"/>${ball(150, 190, 85, '#e55268')}<path d="M84 122q-3-79 98-82 37 0 54 61-39-22-58-6l-10 19Z" fill="#d94362" stroke="#ffa2ad" stroke-width="3"/><path d="M89 118q55-32 113 0" stroke="#ecfff6" stroke-width="23" stroke-linecap="round"/><circle cx="235" cy="105" r="17" fill="#ecfff6"/><path d="m108 155 13-7" stroke="#ffb1ad" stroke-width="6" stroke-linecap="round"/>`);
  const cake = svg(`${sparkles}<ellipse cx="150" cy="282" rx="118" ry="15" fill="#9a70cc" opacity=".45"/><rect x="57" y="155" width="186" height="119" rx="20" fill="#ee6eaf" stroke="#ffd7ea" stroke-width="3"/><path d="M58 182q18 20 37 0 18-20 37 0 18 20 37 0 18-20 37 0 18 20 37 0v-22q0-13-16-13H75q-17 0-17 13Z" fill="#fff0e5"/>${ball(150, 227, 32, '#b68bfa')}<path d="M104 151v-42m91 42v-42" stroke="#98e7ed" stroke-width="9" stroke-linecap="round"/><path d="m151 63-17 42h17l-9 33 29-47h-19l11-28Z" fill="#ffe08c" stroke="#fff0bb" stroke-width="2"/><path d="M104 101q-11-16 0-28 11 12 0 28Zm91 0q-11-16 0-28 11 12 0 28Z" fill="#ffd870"/><path d="m81 225 6 8m127-8-6 8M93 252l8-4m96 4-8-4" stroke="#ffe6ba" stroke-width="5" stroke-linecap="round"/>`);
  const partyBall = svg(`${sparkles}<ellipse cx="150" cy="282" rx="102" ry="12" fill="#34204e" opacity=".5"/><path d="M103 143Q59 62 75 34q36 5 60 99M171 134q33-81 65-90 17 30-33 113" fill="#ffd66c" stroke="#ffe8a6" stroke-width="3"/><path d="M76 35q-5 23 6 47l28-15q-18-28-34-32ZM236 44q4 18-6 42l-27-11q18-26 33-31Z" fill="#493751"/>${ball(150, 191, 84, '#ffd36a')}<circle cx="90" cy="176" r="15" fill="#ef807e"/><circle cx="210" cy="176" r="15" fill="#ef807e"/><path d="m148 47 37 87-72-2Z" fill="#ba8af5" stroke="#f2d4ff" stroke-width="3"/><path d="m130 91 38 10m-44 9 49 9" stroke="#ffd77d" stroke-width="6"/><circle cx="149" cy="45" r="10" fill="#ffdb87"/>`);

  const artwork = {
    crystal: { left: '', right: '' },
    halloween: { left: pumpkin, right: gengar },
    christmas: { left: tree, right: winterBall },
    birthday: { left: cake, right: partyBall }
  };
  const faviconPaths = {
    crystal: 'favicon-original.svg', halloween: 'favicon-halloween.svg',
    christmas: 'favicon-christmas.svg', birthday: 'favicon-birthday.svg'
  };

  function init() {
    const header = document.querySelector('header');
    if (!header) return;
    const scene = document.createElement('div');
    scene.id = 'pbm-scene';
    scene.setAttribute('aria-hidden', 'true');
    scene.innerHTML = '<div class="pbm-sky"></div><div class="pbm-orbit"></div><div class="pbm-stars"></div><div class="pbm-art pbm-left"></div><div class="pbm-art pbm-right"></div>';
    document.body.insertBefore(scene, document.body.firstChild);

    // A small, deterministic constellation. No per-frame JS and no randomness
    // on refresh: mobile visitors get the same still illustration every time.
    const stars = scene.querySelector('.pbm-stars');
    for (let i = 0; i < 12; i++) {
      const star = document.createElement('i');
      star.className = 'pbm-star';
      star.style.cssText = `left:${(i * 37.7 + 13) % 97}%;top:${(i * 19.9 + 9) % 76}%;--delay:-${i % 5}s`;
      stars.appendChild(star);
    }
    let last = '';
    function update() {
      const key = document.documentElement.getAttribute('data-theme') || 'crystal';
      const theme = Object.prototype.hasOwnProperty.call(artwork, key) ? key : 'crystal';
      if (theme === last) return;
      last = theme;
      const link = document.querySelector('link[rel="icon"]');
      if (link && link.getAttribute('href') !== faviconPaths[theme]) {
        link.setAttribute('type', 'image/svg+xml');
        link.setAttribute('href', faviconPaths[theme]);
      }
      scene.querySelector('.pbm-left').innerHTML = artwork[theme].left;
      scene.querySelector('.pbm-right').innerHTML = artwork[theme].right;
      scene.dataset.season = theme;
    }
    new MutationObserver(update).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme']
    });
    update();
    const pause = () => scene.toggleAttribute('data-paused', document.hidden);
    document.addEventListener('visibilitychange', pause);
    pause();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
