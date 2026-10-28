/* A collectible-style product sheet. Product state and checkout stay authoritative
   in the storefront; opening a sheet never reserves stock or submits an order. */
(() => {
  'use strict';
  if (window.PBMDetails) return;

  let dialog, currentId = null, opener = null, locked = false;
  let savedOverflow = '', savedPadding = '', savedRootOverflow = '';
  const number = value => Math.max(0, Math.trunc(Number(value) || 0));
  const currentItem = () => (window.storeItems || []).find(item => String(item.id) === currentId);
  const text = (selector, value) => { dialog.querySelector(selector).textContent = value; };

  function safeUrl(value) {
    if (!String(value || '').trim()) return '';
    try {
      const url = new URL(String(value), location.href);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  function timestamp(value) {
    return typeof centralToMs === 'function' ? centralToMs(value) : null;
  }

  function saleState(item) {
    if (!item || item.hidden) return 'unavailable';
    if (number(item.stock) === 0) return 'sold';
    const now = Date.now(), end = timestamp(item.scheduleEnd), live = timestamp(item.goLiveTime);
    if (end && now >= end) return 'closed';
    if (live && now < live) return 'upcoming';
    return 'open';
  }

  function lockScroll() {
    if (locked) return;
    savedOverflow = document.body.style.overflow;
    savedPadding = document.body.style.paddingRight;
    savedRootOverflow = document.documentElement.style.overflow;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    if (gap > 0) document.body.style.paddingRight = (parseFloat(getComputedStyle(document.body).paddingRight) + gap) + 'px';
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    locked = true;
  }

  function cleanup(restoreFocus = true) {
    if (!locked) return;
    document.body.style.overflow = savedOverflow;
    document.body.style.paddingRight = savedPadding;
    document.documentElement.style.overflow = savedRootOverflow;
    locked = false;
    currentId = null;
    if (restoreFocus && opener && opener.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  function close(restoreFocus = true) {
    if (!dialog || !dialog.open) return;
    dialog.close();
    cleanup(restoreFocus);
  }

  function init() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.id = 'collector-details';
    dialog.className = 'cd-dialog';
    dialog.setAttribute('aria-labelledby', 'cd-title');
    dialog.innerHTML = `
      <div class="cd-sheet">
        <div class="cd-topline"><span class="cd-edition">THE PBM COLLECTION</span><button type="button" class="cd-close" aria-label="Close break details" autofocus><span aria-hidden="true">×</span></button></div>
        <div class="cd-layout">
          <div class="cd-art-column">
            <div class="cd-collectible"><div class="cd-card-top"><span class="cd-tier"></span><span class="cd-card-mark" aria-hidden="true">✦</span></div><div class="cd-image-wrap"><img class="cd-image" alt=""></div><div class="cd-card-bottom"><span>POKEBALLER MIKE</span><span class="cd-card-number"></span></div></div>
            <span class="cd-art-caption">A little closer to your next favorite.</span>
          </div>
          <div class="cd-copy">
            <span class="cd-status"></span>
            <h2 id="cd-title"></h2>
            <div class="cd-price-line"><strong class="cd-price"></strong><span class="cd-price-unit"></span></div>
            <p class="cd-shipping"></p>
            <div class="cd-rule"></div>
            <h3 class="cd-section-label">The details</h3>
            <p class="cd-description"></p>
            <dl class="cd-facts"><div><dt>Availability</dt><dd class="cd-stock"></dd></div><div class="cd-limit-row"><dt>Per collector</dt><dd class="cd-limits"></dd></div><div class="cd-schedule-row"><dt>Schedule</dt><dd class="cd-schedule"></dd></div></dl>
            <div class="cd-action-zone"><button type="button" class="cd-action cd-pack-action"><span class="cd-action-label">Choose your packs</span><svg class="cd-arrow" aria-hidden="true" focusable="false" viewBox="0 0 20 20"><path d="M4 16 16 4M4 4h12v12"/></svg></button><a class="cd-action cd-link-action" target="_blank" rel="noopener noreferrer"><span class="cd-link-label">Join this break</span><svg class="cd-arrow" aria-hidden="true" focusable="false" viewBox="0 0 20 20"><path d="M4 16 16 4M4 4h12v12"/></svg></a><p class="cd-action-note"></p></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.querySelector('.cd-close').addEventListener('click', () => close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    dialog.querySelector('.cd-pack-action').addEventListener('click', () => {
      const item = currentItem();
      if (saleState(item) !== 'open') { render(item); return; }
      const id = item.id;
      document.dispatchEvent(new CustomEvent('pbm:checkout-trigger', { detail: { trigger: opener } }));
      close(false);
      if (typeof openCheckout === 'function') {
        openCheckout(id);
        document.querySelector('#co-name')?.focus({ preventScroll: true });
      }
    });
    dialog.querySelector('.cd-link-action').addEventListener('click', event => {
      const item = currentItem();
      if (saleState(item) !== 'open' || !safeUrl(item?.googleFormLink)) {
        event.preventDefault();
        render(item);
        return;
      }
      event.currentTarget.href = safeUrl(item.googleFormLink);
      // Keep the original storefront's intentional click tracking behavior.
      if (typeof trackClick === 'function') trackClick(item.id);
    });
  }

  function render(item) {
    const state = saleState(item), isPack = item?.type === 'pack';
    const unit = isPack && typeof unitsOf === 'function' ? unitsOf(item) : { one: 'spot', many: 'spots' };
    const tierKey = isPack ? item.displayTier || 'pack' : item?.type;
    const tiers = { baller: 'BALLER BUNDLE', bundle: 'BUNDLE BREAK', msrp: 'MSRP BREAK', pack: 'SINGLE PACKS' };
    text('.cd-tier', tiers[tierKey] || 'POKÉMON BREAK');
    text('#cd-title', item?.name || 'This break is unavailable');
    text('.cd-card-number', item ? '#' + String((window.storeItems || []).indexOf(item) + 1).padStart(3, '0') : '—');
    const img = dialog.querySelector('.cd-image');
    const image = safeUrl(item?.image);
    // Relative first-party images are also supported, including local previews.
    let localImage = '';
    try { const parsed = new URL(item?.image || '', location.href); if (item?.image && parsed.origin === location.origin) localImage = parsed.href; } catch {}
    const src = image || localImage;
    if (src) img.src = src; else img.removeAttribute('src');
    img.alt = item?.name || 'Break artwork';
    dialog.querySelector('.cd-image-wrap').classList.toggle('cd-no-image', !src);
    text('.cd-price', '$' + (typeof priceTag === 'function' ? priceTag(item?.price) : (Number(item?.price) || 0).toFixed(2)));
    text('.cd-price-unit', 'per ' + unit.one);
    text('.cd-description', item?.description || 'Take a closer look at the break, then choose your spot below.');
    text('.cd-shipping', isPack ? 'Shipping included · Opened live with Mike' : 'Opened live with Pokeballer Mike');
    const statuses = { open: 'AVAILABLE NOW', upcoming: 'COMING UP', sold: 'SOLD OUT', closed: 'BREAK CLOSED', unavailable: 'UNAVAILABLE' };
    text('.cd-status', statuses[state]);
    dialog.querySelector('.cd-status').dataset.state = state;
    text('.cd-stock', number(item?.stock) + ' ' + (number(item?.stock) === 1 ? unit.one : unit.many) + ' remaining');
    dialog.querySelector('.cd-limit-row').hidden = !isPack;
    if (isPack) {
      const limits = typeof limitsFor === 'function' ? limitsFor(item) : { min: 1, maxBuy: 10 };
      text('.cd-limits', `${limits.min}–${limits.maxBuy} ${unit.many} · one order per email`);
    }
    const schedule = [];
    if (item?.goLiveTime) schedule.push('Opens ' + item.goLiveTime.replace('T', ' ') + ' Central');
    if (item?.scheduleEnd) schedule.push('Closes ' + item.scheduleEnd.replace('T', ' ') + ' Central');
    dialog.querySelector('.cd-schedule-row').hidden = !schedule.length;
    text('.cd-schedule', schedule.join(' · '));
    const button = dialog.querySelector('.cd-pack-action'), link = dialog.querySelector('.cd-link-action');
    const externalUrl = safeUrl(item?.googleFormLink);
    button.hidden = !isPack && state === 'open' && !!externalUrl;
    link.hidden = !button.hidden;
    button.disabled = state !== 'open' || !isPack;
    text('.cd-action-label', state !== 'open' ? statuses[state] : !isPack ? 'Details coming soon' : 'Choose your ' + unit.many);
    text('.cd-link-label', item?.type === 'msrp' ? 'Join the wheel' : 'Lock in your spot');
    if (externalUrl) link.href = externalUrl; else link.removeAttribute('href');
    text('.cd-action-note', state === 'upcoming' ? 'Purchases open at the scheduled time.' : state === 'open' && isPack ? 'Choose quantity and review your total before reserving.' : state === 'open' && externalUrl ? 'Continues to this break’s entry page in a new tab.' : 'Discover another break in the collection.');
  }

  function open(id, trigger) {
    const item = (window.storeItems || []).find(entry => String(entry.id) === String(id));
    if (!item || item.hidden) return;
    init();
    currentId = String(id);
    opener = trigger || document.activeElement;
    render(item);
    if (!dialog.open) {
      lockScroll();
      dialog.showModal();
      dialog.querySelector('.cd-close').focus({ preventScroll: true });
    }
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-details-id]');
    if (!trigger) return;
    event.preventDefault();
    open(trigger.dataset.detailsId, trigger);
  });
  window.PBMDetails = { open, close };
})();
