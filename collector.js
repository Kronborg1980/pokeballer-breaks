/* The illustrated storefront: static art, current stock, deliberate interactions. */
(() => {
  'use strict';
  const worlds = {
    crystal: {file:'original',title:'THE MOONLIGHT COLLECTION',alt:'Suicune in a moonlit lake beside a lantern-lit Pokémon shop'},
    halloween: {file:'halloween',title:'THE MIDNIGHT MASQUERADE',alt:'Gengar outside a haunted woodland Poké Mart with glowing pumpkin lanterns'},
    christmas: {file:'christmas',title:'A VERY MERRY COLLECTION',alt:'Suicune visiting a snowy Pokémon village with warm windows and Christmas trees'},
    birthday: {file:'birthday',title:'A LITTLE EXTRA MAGIC',alt:'Pikachu celebrating in a lantern-lit courtyard with balloons and birthday decorations'}
  };
  const image = document.getElementById('collector-world-image');
  function dressWorld() {
    const theme = document.documentElement.dataset.theme;
    const world = worlds[theme] || worlds.crystal;
    if (image && image.dataset.world !== world.file) {
      image.dataset.world = world.file;
      image.srcset = `assets/worlds/${world.file}-mobile.webp 960w, assets/worlds/${world.file}.webp 1536w`;
      image.sizes = '(max-width:768px) 100vw, (max-width:1440px) 96vw, 1400px';
      image.src = `assets/worlds/${world.file}.webp`;
      image.alt = world.alt;
      document.getElementById('collector-world-title').textContent = world.title;
    }
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.href = `favicon-${world.file === 'original' ? 'original' : world.file}.svg`;
  }
  new MutationObserver(dressWorld).observe(document.documentElement, {attributes:true,attributeFilter:['data-theme']});
  dressWorld();

  let featureSignature = '';
  function updateFeature() {
    const button = document.getElementById('featured-break');
    if (!button) return;
    const now = Date.now();
    const items = (window.storeItems || []).filter(item => {
      const end = centralToMs(item.scheduleEnd);
      return !item.hidden && toInt(item.stock) > 0 && (!end || end > now);
    });
    const available = items.find(item => !centralToMs(item.goLiveTime) || centralToMs(item.goLiveTime) <= now);
    const item = available || items.sort((a,b) => (centralToMs(a.goLiveTime) || 0) - (centralToMs(b.goLiveTime) || 0))[0];
    if (!item) {button.hidden = true;featureSignature = '';return;}
    const signature = JSON.stringify([item.id,item.name,item.price,item.stock,item.goLiveTime,item.type,item.stockLabelType,!!available]);
    if (signature === featureSignature) return;
    featureSignature = signature;
    button.hidden = false;
    button.dataset.detailsId = String(item.id);
    button.setAttribute('aria-label', `Explore ${item.name}`);
    document.getElementById('featured-break-title').textContent = item.name;
    document.getElementById('featured-break-price').textContent = '$' + priceTag(item.price);
    document.getElementById('featured-break-status').textContent = available ? 'YOUR NEXT OPENING' : 'COMING UP NEXT';
    const units = item.type === 'pack' ? unitWord(item,toInt(item.stock)) : (toInt(item.stock) === 1 ? 'spot' : 'spots');
    document.getElementById('featured-break-stock').textContent = `${toInt(item.stock)} ${units} available`;
  }
  document.addEventListener('pbm:inventory', updateFeature);
  updateFeature();

  // Keep the existing, tested checkout flow, with proper keyboard containment.
  const modals = [...document.querySelectorAll('.image-modal')];
  const triggers = new WeakMap();
  const openState = new WeakMap();
  let checkoutTrigger = null;
  document.addEventListener('pbm:checkout-trigger',event => {checkoutTrigger = event.detail?.trigger || null;});
  let savedOverflow = '';
  function syncModals() {
    let anyOpen = false;
    for (const modal of modals) {
      const open = modal.style.display === 'flex';
      anyOpen ||= open;
      if (open && !openState.get(modal)) {
        const active = document.activeElement;
        triggers.set(modal, modal.id === 'checkoutModal' && checkoutTrigger ? checkoutTrigger : active);
        if (modal.id === 'checkoutModal') checkoutTrigger = null;
        queueMicrotask(() => {
          const focus = modal.querySelector('#co-name') || modal.querySelector('button,a[href],input,textarea');
          focus?.focus({preventScroll:true});
        });
      } else if (!open && openState.get(modal)) {
        const trigger = triggers.get(modal);
        if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({preventScroll:true});
      }
      openState.set(modal,open);
    }
    if (anyOpen && !document.body.classList.contains('collector-modal-open')) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      document.body.classList.add('collector-modal-open');
    } else if (!anyOpen && document.body.classList.contains('collector-modal-open')) {
      document.body.style.overflow = savedOverflow;
      document.body.classList.remove('collector-modal-open');
    }
    const guide = document.getElementById('collector-payment-guide');
    if (guide) {
      guide.textContent = stripeLive()
        ? 'Choose your quantity and add your details. Your packs are held while you complete secure Stripe Checkout. Your order is confirmed when payment is verified.'
        : 'Reserve your packs first, then continue to Streamlabs. Copy your order reference and break name into the tip message with your YouTube username, so Mike can match your payment.';
    }
  }
  const observer = new MutationObserver(syncModals);
  document.addEventListener('pbm:settings', syncModals);
  modals.forEach(modal => observer.observe(modal,{attributes:true,attributeFilter:['style']}));
  document.addEventListener('keydown',event => {
    if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
    const modal = modals.find(element => element.style.display === 'flex');
    if (!modal) return;
    const controls = [...modal.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
      .filter(element => element.getClientRects().length);
    const first = controls[0],last = controls[controls.length - 1];
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault();last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      event.preventDefault();first.focus();
    }
  });
  syncModals();

  // Keep the first screen unobstructed; quick navigation appears in the shop.
  const quickNav = document.querySelector('.collector-mobile-nav');
  const hero = document.querySelector('.collector-hero');
  if (quickNav && hero && 'IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      quickNav.hidden = entries[0].isIntersecting;
    }).observe(hero);
  }
})();
