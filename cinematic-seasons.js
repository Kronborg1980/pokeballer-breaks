/* PBM Breaks seasonal atmosphere. 'crystal' remains the legacy settings key only. */
(()=>{
'use strict';
if(window.__pbmCinematicSeasons)return;
window.__pbmCinematicSeasons=true;
const svg=(content,viewBox='0 0 300 320')=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+viewBox+'" fill="none" aria-hidden="true">'+content+'</svg>';
const pumpkin=svg('<defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffcb53"/><stop offset=".5" stop-color="#fe7c23"/><stop offset="1" stop-color="#9f3617"/></linearGradient></defs><path d="M152 92q-8-30 10-44l20 3q-22 14-12 45" fill="#39733a"/><ellipse cx="150" cy="193" rx="116" ry="93" fill="url(#p)"/><ellipse cx="150" cy="193" rx="66" ry="91" fill="#e96526" opacity=".55"/><ellipse cx="150" cy="193" rx="27" ry="91" fill="#ffaf3c" opacity=".32"/><path d="m86 177 30-23 16 34-39-1zM214 177l-30-23-16 34 39-1zM104 225q44 28 92 0l-14-12-21 11-13-10-16 10-16-11z" fill="#37192f"/><path d="m92 176 25-15m91 15-25-15" stroke="#ffe1a1" stroke-opacity=".5" stroke-width="3"/><path d="M99 227q49 35 102 0" stroke="#ffd360" stroke-width="3" opacity=".6"/>');
const ghost=svg('<path d="M52 244V133a98 98 0 0 1 196 0v111l-32-23-29 23-37-23-34 23-31-23z" fill="#f2e5ff" fill-opacity=".87" stroke="#fff" stroke-opacity=".8" stroke-width="3"/><ellipse cx="120" cy="150" rx="16" ry="23" fill="#3e244f"/><ellipse cx="182" cy="150" rx="16" ry="23" fill="#3e244f"/><ellipse cx="151" cy="204" rx="14" ry="20" fill="#603264"/><circle cx="88" cy="191" r="12" fill="#ff9bbb" opacity=".55"/><circle cx="212" cy="191" r="12" fill="#ff9bbb" opacity=".55"/>');
const tree=svg('<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#64ffba"/><stop offset=".65" stop-color="#0a875e"/><stop offset="1" stop-color="#064d3b"/></linearGradient></defs><rect x="138" y="267" width="25" height="38" rx="5" fill="#8a6040"/><path d="m150 45 94 218H56z" fill="url(#t)" stroke="#9bf5c2" stroke-width="2"/><path d="M150 68 91 196h118M150 113l-75 128h150" stroke="#b3ffe2" stroke-opacity=".35" stroke-width="4"/><path d="m150 18 10 22 23 2-18 15 5 23-20-12-20 12 5-23-18-15 23-2z" fill="#fff2a7" stroke="#fff7d2" stroke-width="3"/><path d="M90 224q62-14 124 4M109 177q36 17 80-2" stroke="#eaf7ff" stroke-width="6" stroke-linecap="round"/><g fill="#ff7c89"><circle cx="116" cy="212" r="9"/><circle cx="191" cy="242" r="10"/><circle cx="162" cy="137" r="8"/></g><g fill="#ffe3a2"><circle cx="177" cy="194" r="9"/><circle cx="137" cy="248" r="8"/><circle cx="133" cy="159" r="7"/></g>');
const gift=svg('<rect x="40" y="111" width="220" height="156" rx="14" fill="#b82345" stroke="#ff8ca4" stroke-width="4"/><rect x="26" y="102" width="248" height="41" rx="9" fill="#ee526d"/><path d="M135 105h35v162h-35z" fill="#ffda90"/><path d="M42 183h216v28H42z" fill="#ffda90"/><path d="M150 102C97 107 74 73 97 54c27-24 56 25 53 48Zm0 0c53 5 76-29 53-48-27-24-56 25-53 48Z" fill="#ffdc96" stroke="#ffecb9" stroke-width="4"/>');
const cake=svg('<ellipse cx="150" cy="272" rx="125" ry="22" fill="#ffd7eb" opacity=".75"/><rect x="62" y="160" width="176" height="104" rx="20" fill="#ff72b0" stroke="#ffe8f5" stroke-width="4"/><path d="M63 180q20 17 38 0t38 0 38 0 38 0 23 0v25q-19-19-39-2-19 19-39 0-20-19-40 0-19 19-39 0-20-19-38 0z" fill="#fff1f8"/><path d="M95 159v-43m55 43v-60m55 60v-43" stroke="#ffdc84" stroke-width="9" stroke-linecap="round"/><path d="M95 103q-14-21 0-32 14 11 0 32Zm55-17q-14-21 0-32 14 11 0 32Zm55 17q-14-21 0-32 14 11 0 32Z" fill="#ffe674"/><g fill="#fff1a7"><circle cx="100" cy="229" r="7"/><circle cx="147" cy="230" r="7"/><circle cx="198" cy="230" r="7"/></g>');
const balloons=svg('<path d="M93 156q32 68 53 138M192 156q-25 67-46 138M142 126q6 92 4 168" stroke="#ffe6f8" stroke-opacity=".76" stroke-width="3"/><ellipse cx="93" cy="101" rx="53" ry="70" fill="#ff7fc6"/><ellipse cx="193" cy="101" rx="49" ry="69" fill="#ffd176"/><ellipse cx="143" cy="71" rx="40" ry="59" fill="#ab8bff"/><path d="m91 166-8 14h18zM192 166l-8 14h18zM143 127l-8 14h18z" fill="#ffe6f8"/><path d="M75 59q-15 33-13 64M177 59q-12 23-12 51" stroke="#fff" stroke-opacity=".45" stroke-width="6" stroke-linecap="round"/>');
/* No default-theme diamond artwork, slogan, title block or floating centerpiece. */
const artwork={
  crystal: {left:'', right:''},
  halloween: {left:pumpkin, right:ghost},
  christmas: {left:tree, right:gift},
  birthday: {left:cake, right:balloons}
};
function init(){
  if(!document.querySelector('header'))return;
  const scene=document.createElement('div');
  scene.id='pbm-scene';scene.setAttribute('aria-hidden','true');
  scene.innerHTML='<div class="pbm-sky"></div><div class="pbm-mist"></div><div class="pbm-stars"></div><div class="pbm-art pbm-left"></div><div class="pbm-art pbm-right"></div>';
  document.body.insertBefore(scene,document.body.firstChild);
  const stars=scene.querySelector('.pbm-stars');
  const frag=document.createDocumentFragment();
  for(let i=0;i<26;i++){
    const el=document.createElement('i');
    el.className='pbm-star';
    el.style.cssText='left:'+((i*37.7+13)%97)+'%;top:'+((i*19.9+9)%76)+'%;--dur:'+(4+i%7)+'s;--delay:-'+((i*7)%19)+'s';
    frag.appendChild(el);
  }
  stars.appendChild(frag);
  let last='';
  function update(){
    const key=document.documentElement.getAttribute('data-theme')||'crystal';
    const theme=Object.prototype.hasOwnProperty.call(artwork,key)?key:'crystal';
    if(theme===last)return;
    last=theme;
    const art=artwork[theme];
    scene.querySelector('.pbm-left').innerHTML=art.left;
    scene.querySelector('.pbm-right').innerHTML=art.right;
    scene.dataset.season=theme;
  }
  new MutationObserver(update).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  update();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
