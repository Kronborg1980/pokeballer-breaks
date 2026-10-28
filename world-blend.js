/* Static local artwork and modal keyboard support for the familiar neon shop. */
(() => {
  'use strict';
  const worlds = {
    crystal:{file:'original',label:'POKEBALLER MIKE',alt:'Suicune beside a moonlit lake and a lantern-lit Pokémon shop'},
    halloween:{file:'halloween',label:'HALLOWEEN',alt:'Gengar at a haunted woodland Pokémon shop with glowing pumpkins'},
    christmas:{file:'christmas',label:'CHRISTMAS',alt:'Suicune visiting a snowy Pokémon village with Christmas lights'},
    birthday:{file:'birthday',label:'BIRTHDAY',alt:'Pikachu celebrating in a courtyard with balloons and birthday lights'}
  };
  const image = document.getElementById('collector-world-image');
  function dressWorld() {
    const world = worlds[document.documentElement.dataset.theme] || worlds.crystal;
    if (image && image.dataset.world !== world.file) {
      image.dataset.world = world.file;
      image.srcset = `assets/worlds/${world.file}-mobile.webp 960w, assets/worlds/${world.file}.webp 1536w`;
      image.sizes = '(max-width:768px) 100vw, (max-width:1294px) 96vw, 1250px';
      image.src = `assets/worlds/${world.file}.webp`;
      image.alt = world.alt;
      document.getElementById('collector-world-title').textContent = world.label;
    }
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.href = `favicon-${world.file}.svg`;
  }
  new MutationObserver(dressWorld).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  dressWorld();

  const modals = [...document.querySelectorAll('.image-modal')];
  const triggers = new WeakMap(),opened = new WeakMap();
  let savedOverflow = '';
  function sync() {
    let anyOpen = false;
    for (const modal of modals) {
      const open = modal.style.display === 'flex';
      anyOpen ||= open;
      if (open && !opened.get(modal)) {
        triggers.set(modal,modal.pbmTrigger || document.activeElement);
        delete modal.pbmTrigger;
        queueMicrotask(() => {
          (modal.querySelector('#co-name') || modal.querySelector('button,a[href],input,textarea'))?.focus({preventScroll:true});
        });
      } else if (!open && opened.get(modal)) {
        const trigger = triggers.get(modal);
        if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({preventScroll:true});
      }
      opened.set(modal,open);
    }
    if (anyOpen && !document.body.classList.contains('world-modal-open')) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      document.body.classList.add('world-modal-open');
    } else if (!anyOpen && document.body.classList.contains('world-modal-open')) {
      document.body.style.overflow = savedOverflow;
      document.body.classList.remove('world-modal-open');
    }
  }
  const observer = new MutationObserver(sync);
  modals.forEach(modal => observer.observe(modal,{attributes:true,attributeFilter:['style']}));
  document.addEventListener('keydown',event => {
    if (event.key !== 'Tab') return;
    const modal = modals.find(element => element.style.display === 'flex');
    if (!modal) return;
    const controls = [...modal.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
      .filter(element => element.getClientRects().length);
    const first = controls[0],last = controls[controls.length-1];
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault();last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      event.preventDefault();first.focus();
    }
  });
  sync();
})();
