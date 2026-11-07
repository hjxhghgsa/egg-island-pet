const icons = {
  settings:'<path d="m9.5 3-.7 2.3-2 .9-2.2-.6-1.8 3.1 1.5 1.7-.2 2.2L2.5 14l1.8 3.1 2.2-.4 1.9 1.2.5 2.3h3.6l.8-2.2 2-1 2.2.6 1.8-3.1-1.5-1.7.2-2.2L21.5 9l-1.8-3.1-2.2.4-1.9-1.2L15.1 3Z"/><circle cx="12" cy="11.6" r="3"/>',
  lantern:'<path d="M9 6V4a3 3 0 0 1 6 0v2M7 7h10l2 13H5L7 7ZM8 12h8M12 12v5"/>',
  bag:'<path d="M7 8h10l2 12H5L7 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2M9 13h6"/>',
  outfit:'<path d="m8 4-5 4 3 4 2-1v9h8v-9l2 1 3-4-5-4a4 4 0 0 1-8 0Z"/>',
  pet:'<ellipse cx="12" cy="16" rx="5.6" ry="4.2"/><ellipse cx="5.6" cy="10.6" rx="2" ry="2.8" transform="rotate(-25 5.6 10.6)"/><ellipse cx="10" cy="6.8" rx="1.9" ry="2.6"/><ellipse cx="15" cy="7" rx="1.9" ry="2.6"/><ellipse cx="19" cy="11" rx="1.8" ry="2.6" transform="rotate(22 19 11)"/>',
  photo:'<path d="M3 7h5l2-3h4l2 3h5v13H3Z"/><circle cx="12" cy="13" r="4"/>',
  time:'<circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4.2 4.2l1.5 1.5m12.6 12.6 1.5 1.5M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5"/>',
  sound:'<path d="m4 10 4-1 5-4v14l-5-4-4-1Zm13-3a7 7 0 0 1 0 10m2-13a11 11 0 0 1 0 16"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  leaf:'<path d="M19 4C8 2 3 8 6 15c6 6 15 0 13-11Z"/><path d="M4 21 15 9"/>',
  envelope:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
};
const svg = (name,cls='') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.leaf}</svg>`;
const esc = (value) => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const flowers = [{id:'jasmine',name:'借你的茉莉',en:'JASMINE',desc:'把细小的温柔，种进风里。',color:'#eee8cf'}, {id:'tears',name:'落泪的繁花',en:'BLOOM',desc:'那些来不及说的话，都会开花。',color:'#d89db0'},{id:'sun',name:'明年的向日葵',en:'SUNFLOWER',desc:'朝着光，慢慢长成自己的模样。',color:'#dfb955'}];
const times = [{id:'sunrise',name:'日出',clock:'05:40',en:'A new beginning',colors:['#b0bcc8','#ecc0a2']},{id:'noon',name:'中午',clock:'12:00',en:'Under the sun',colors:['#7cb9d7','#e7e9d0']},{id:'sunset',name:'夕阳',clock:'17:30',en:'Stay a little longer',colors:['#bc9bb8','#efbd99']},{id:'blue',name:'蓝调时间',clock:'18:40',en:'Between day & dream',colors:['#465d91','#aba6cb']},{id:'night',name:'夜晚',clock:'22:00',en:'A sky full of wishes',colors:['#182b4e','#61678e']}];
const qualityOptions=[
  {id:'mobile',name:'轻量',en:'LIGHT',tag:'轻盈出发',desc:'为手机与低功耗设备，留一份流畅的海风。'},
  {id:'balanced',name:'平衡',en:'BALANCED',tag:'自在漫游',desc:'在风景的细节与流畅之间，找到刚好的节奏。'},
  {id:'ultra',name:'影院',en:'CINEMATIC',tag:'细腻漫游',desc:'更细腻的光影、草甸与海面，慢慢看一场岛屿电影。'},
  {id:'extreme',name:'极致',en:'EXTREME',tag:'4070 Ti SUPER',desc:'用更丰富的云海与实时反射，留下最完整的风景。'}
];
const logo=(classes='')=>`<span class="image-logo ${classes}"><img src="assets/logo.png" alt="" aria-hidden="true"></span>`;
export function createUI(handlers={}) {
  const ui = document.createElement('div'); ui.id='island-ui';
  ui.innerHTML=`
  <div id="opening" class="opening">
    <header class="opening-brand"><span class="visually-hidden">欢迎来到蛋岛</span>${logo("header-logo")}<small>WELCOME TO EGG ISLAND</small></header>
    <div class="opening-content"><div class="eyebrow"><i></i> AN ISLAND BETWEEN SEA & SKY</div><h1 class="opening-title"><span class="visually-hidden">欢迎来到蛋岛</span>${logo("title-logo")}</h1><div class="opening-rule"></div><p class="opening-poem">光是遇见过，已是最美丽的诗歌。</p><p class="opening-copy opening-credit">制作@DAiKONAUT</p><button id="start-exploring" class="primary start-btn" disabled><span>正在唤醒小岛</span>${svg('arrow')}</button><div class="loading-row"><div class="loading-track"><i id="load-bar"></i></div><span id="load-number">00%</span></div><div id="load-status" class="load-status">海风正在赶来的路上</div></div>
    <div class="opening-footer"><span>光是遇见过，已是最美丽的诗歌。</span><span>3D EXPLORATION EXPERIENCE <i>✧</i></span></div>
  </div>
  <div id="hud" class="hud" hidden>
    <header class="hud-brand"><div><h2><span class="visually-hidden">欢迎来到蛋岛</span>${logo("hud-logo")}</h2><p>光是遇见过，已是最美丽的诗歌。</p></div></header>
    <div class="chapter"><span>THE ISLAND JOURNAL</span><div><i></i><span id="place-label">海风草甸</span></div></div>
    <div class="top-tools"><button class="small-round settings-button" data-open="settings" aria-label="画质设置" title="画质设置">${svg('settings')}</button><button id="music-button" class="small-round" aria-label="关闭背景音乐" title="背景音乐">${svg('sound')}</button><div class="time-pill">${svg('time')}<span id="time-label">夕阳</span></div></div>
    <nav class="main-nav" aria-label="岛屿工具">${[{id:'bag',label:'背包',en:'JOURNAL'},{id:'outfit',label:'换装',en:'WARDROBE'},{id:'pet',label:'宠物',en:'COMPANION'},{id:'photo',label:'拍照',en:'MOMENTS'},{id:'time',label:'时间',en:'DAYLIGHT'}].map(n=>`<button class="nav-button" data-open="${n.id}" aria-label="${n.label}"><span class="nav-icon">${svg(n.id)}</span><span class="nav-label">${n.label}<small>${n.en}</small></span></button>`).join('')}</nav>
    <div class="journal-status"><span class="journal-symbol">${svg('envelope')}</span><div><p>岛屿手记 <span id="collected-count">00</span><em>/ 18</em></p><div class="collection-track"><i id="collection-progress"></i></div><small>幸好我们的心连成一片一片...</small></div></div>
    <div class="controls-guide"><span><kbd>W A S D</kbd> / 方向键行走</span><span>拖动鼠标环绕 · 滚轮缩放</span><span><kbd>E</kbd> 互动 <i>·</i> <kbd>Shift</kbd> 奔跑</span></div>
    <button id="interaction-prompt" class="interaction-prompt" hidden><kbd>E</kbd><span></span>${svg('arrow')}</button>
    <div id="vehicle-controls" class="vehicle-controls" hidden></div>
    <div id="lookzone" aria-label="拖动转动视角"></div><div id="joystick" aria-label="拖动控制移动"><div class="joystick-ring"></div><div class="knob"></div></div>
  </div>
  <div id="panel-shade" class="panel-shade" hidden></div><aside id="side-panel" class="side-panel" hidden role="dialog" aria-modal="true"></aside>
  <div id="postcard-overlay" class="postcard-overlay" hidden role="dialog" aria-modal="true"></div>
  <div id="photo-controls" class="photo-controls" hidden><div class="photo-top"><div class="photo-caption"><span>COLLECT A LITTLE LIGHT</span><h3>把这一刻，留在岛上。</h3></div><button id="photo-close" class="small-round" aria-label="退出拍照">${svg('close')}</button></div><div class="viewfinder"><i></i><i></i><i></i><i></i><span>EGG ISLAND · A MOMENT TO KEEP</span></div><div class="photo-bottom"><div class="photo-tabs"><button class="selected" data-photo="panorama">全景</button><button data-photo="selfie">自拍</button><button id="trace-photo" title="渐进路径追踪，静止镜头采样；首次需要加载">光追照片</button></div><button id="shutter" class="shutter" aria-label="拍照并下载"><span></span></button><p>轻触快门，保存此刻的风景</p><p id="trace-photo-note" class="trace-photo-note">渐进路径追踪 · 静止镜头采样；首次需要加载</p></div></div>
  <div id="island-toast" class="island-toast" role="status">${svg('leaf')}<span></span></div><div id="photo-flash" class="photo-flash"></div>`;
  document.body.append(ui);
  const $=s=>ui.querySelector(s), $$=s=>[...ui.querySelectorAll(s)];
  const state={started:false,panel:null,postcard:false,photo:false,vehicle:'off',toastTimer:0,performance:{}};
  const call=(name,...args)=>handlers[name]?.(...args);
  const show=(el,visible)=>{el.hidden=!visible;};
  function closePanel(){ state.panel=null;state.postcard=false;show($('#postcard-overlay'),false); show($('#side-panel'),false);show($('#panel-shade'),false);$$('[data-open]').forEach(b=>b.classList.remove('active')); }
  function endPhoto(options={}){state.photo=false;show($('#photo-controls'),false);show($('#hud'),state.started);if(!options.silent)call('closePhoto');}
  function panelShell(title,eyebrow,description,body){ return `<div class="panel-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><button class="panel-close small-round" aria-label="关闭面板">${svg('close')}</button></div><p class="panel-description">${description}</p>${body}<div class="panel-footer">TAKE YOUR TIME <span>✧</span> 让美好慢一点发生</div>`; }
  function bindPanel(){ $$('[data-lantern]').forEach(b=>b.addEventListener('click',()=>call('setLantern',b.dataset.lantern==='use'))); $('.panel-close')?.addEventListener('click',closePanel);$$('[data-character]').forEach(b=>b.addEventListener('click',()=>{call('selectCharacter',b.dataset.character);$$('[data-character]').forEach(n=>n.classList.toggle('selected',n.dataset.character===b.dataset.character));}));$$('[data-pet]').forEach(b=>b.addEventListener('click',()=>{call('selectPet',b.dataset.pet);$$('[data-pet]').forEach(n=>n.classList.toggle('selected',n.dataset.pet===b.dataset.pet));}));$$('[data-time]').forEach(b=>b.addEventListener('click',()=>{call('selectTime',b.dataset.time);$$('[data-time]').forEach(n=>n.classList.toggle('selected',n.dataset.time===b.dataset.time));}));$$('[data-plant]').forEach(b=>b.addEventListener('click',()=>{call('plant',b.dataset.plant);closePanel();}));$$('[data-card]').forEach(b=>b.addEventListener('click',()=>call('viewCard',b.dataset.card)));$$('[data-quality]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.quality;$$('[data-quality]').forEach(n=>n.classList.toggle('selected',n.dataset.quality===id));call('setQuality',id);})); }
  function openPanel(kind,data={}) {
    if(kind==='photo'){closePanel();state.photo=true;show($('#hud'),false);show($('#photo-controls'),true);call('photo','panorama');$$('[data-photo]').forEach(b=>b.classList.toggle('selected',b.dataset.photo==='panorama'));return;}
    if(state.photo) endPhoto();state.panel=kind;show($('#side-panel'),true);show($('#panel-shade'),true);$$('[data-open]').forEach(b=>b.classList.toggle('active',b.dataset.open===kind));
    if(kind==='bag'){
      const collected=data.collected||[];
      $('#side-panel').innerHTML=panelShell('把相遇，收进口袋。','YOUR LITTLE COLLECTION','来信与种子，都是值得珍藏的小事。',`<div class="section-heading"><h3>随身物品</h3><span>夜行的小小光芒</span></div><div class="lantern-item"><span class="lantern-art">${svg('lantern')}</span><div><b>手提灯</b><small>${data.lanternEnabled?'已携带 · 入夜后自动亮起':'已收起 · 留在背包里'}</small></div><button class="lantern-toggle" data-lantern="${data.lanternEnabled?'stow':'use'}">${data.lanternEnabled?'收起':'使用'}</button></div><div class="section-heading"><h3>花的种子</h3><span>已种下 ${data.planted||0} 株</span></div><div class="flower-list">${flowers.map(f=>`<button class="flower-option" data-plant="${f.id}"><span class="flower-art" style="--flower:${f.color}">✿</span><span><b>${f.name}</b><small>${f.desc}</small></span><span class="seed-number">${data.flowers?.[f.id]??'∞'}<small>种下 ${svg('arrow')}</small></span></button>`).join('')}</div><p class="field-note">${svg('leaf')} 走到池塘右侧的花圃，选择一颗种子。</p><div class="section-heading postcard-heading"><h3>岛屿来信</h3><span>${String(collected.length).padStart(2,'0')} / 18</span></div><div class="postcard-grid">${Array.from({length:18},(_,i)=>{const card=collected.find(c=>Number(c.id)===i+1)||collected.find(c=>String(c.id).replace(/^0+/,'')===String(i+1));return card?`<button class="postcard-thumb" data-card="${esc(card.id)}" title="${esc(card.title)}"><img src="${esc(card.src)}" alt="${esc(card.title)}"><span>${String(i+1).padStart(2,'0')}</span></button>`:`<div class="empty-card">${svg('envelope')}<span>${String(i+1).padStart(2,'0')}</span></div>`;}).join('')}</div>`);
    } else if(kind==='outfit'){
      $('#side-panel').innerHTML=panelShell('今天，成为谁？','A DIFFERENT KIND OF YOU','换一个模样，带着同样的好奇心出发。',`<div class="selection-cards">${[{id:'cake',name:'蛋糕纯',en:'THE SWEET DAY',cls:'cake',desc:'把柔软与甜，穿在身上。'},{id:'jade',name:'珠玉纯',en:'THE QUIET GLOW',cls:'jade',desc:'像一颗温润的光，走进山海。'}].map(c=>`<button class="selection-card ${data.selected===c.id?'selected':''}" data-character="${c.id}">${data.previews?.[c.id]?`<span class="asset-preview"><img src="${esc(data.previews[c.id])}" alt="${c.name}"></span>`:`<span class="character-art ${c.cls}"><i class="char-head"></i><i class="char-hair"></i><i class="char-body"></i><i class="char-leg l"></i><i class="char-leg r"></i><i class="art-spark">✧</i></span>`}<span class="option-check">${svg('check')}</span><span class="selection-text"><small>${c.en}</small><b>${c.name}</b><p>${c.desc}</p></span></button>`).join('')}</div><div class="gentle-note">${svg('leaf')} 每一种模样，都有属于自己的风景。</div>`);
    } else if(kind==='pet'){
      $('#side-panel').innerHTML=panelShell('有你，就不孤单。','YOUR LITTLE COMPANION','走得再远，总有小小的伙伴乘风而来。',`<div class="selection-cards">${[{id:'egg',name:'蛋仔',en:'A POCKET OF SUNSHINE',cls:'egg-pet',desc:'圆滚滚的快乐，跟着你去远方。'},{id:'rabbit',name:'高定兔',en:'A SOFT LITTLE FRIEND',cls:'rabbit-pet',desc:'轻轻地陪伴，慢慢地长大。'}].map(c=>`<button class="selection-card ${data.selected===c.id?'selected':''}" data-pet="${c.id}">${data.previews?.[c.id]?`<span class="asset-preview"><img src="${esc(data.previews[c.id])}" alt="${c.name}"></span>`:`<span class="pet-art ${c.cls}"><i class="pet-ear l"></i><i class="pet-ear r"></i><i class="pet-body"></i><i class="pet-eye l"></i><i class="pet-eye r"></i><i class="pet-blush l"></i><i class="pet-blush r"></i><i class="art-spark">✧</i></span>`}<span class="option-check">${svg('check')}</span><span class="selection-text"><small>${c.en}</small><b>${c.name}</b><p>${c.desc}</p></span></button>`).join('')}</div><div class="gentle-note">${svg('pet')} 伙伴会在空中轻轻漂浮，陪你一起看海。</div>`);
    } else if(kind==='time'){
      $('#side-panel').innerHTML=panelShell('让光，停在此刻。','THE COLOUR OF TIME','小岛的时间，由你的心情决定。',`<div class="time-options">${times.map(t=>`<button class="time-option ${data.selected===t.id?'selected':''}" data-time="${t.id}"><span class="time-swatch" style="--sky-top:${t.colors[0]};--sky-bottom:${t.colors[1]}"><i class="${t.id==='night'?'moon':'sun'}"></i><i class="swatch-hill"></i></span><span class="time-option-copy"><b>${t.name}<em>${t.clock}</em></b><small>${t.en}</small></span><span class="time-check">${svg('check')}</span></button>`).join('')}</div><div class="gentle-note">${svg('time')} 日子很长，喜欢的光可以多留一会儿。</div>`);
    } else if(kind==='settings'){
      const selected=data.selected||(typeof data.quality==='string'?data.quality:data.quality?.id)||'ultra';
      const current=qualityOptions.find(q=>q.id===selected)||qualityOptions[2];
      $('#side-panel').innerHTML=panelShell('让风景，再细腻一点。','PICTURE & PERFORMANCE','为此刻的设备，挑选适合自己的岛屿光影。',`<div class="quality-feature-caption">反射水面 <i>·</i> 体积散射 <i>·</i> 光圈景深</div><div class="quality-options">${qualityOptions.map((q,i)=>`<button class="quality-option ${selected===q.id?'selected':''}" data-quality="${q.id}"><span class="quality-level" aria-hidden="true">${Array.from({length:4},(_,n)=>`<i class="${n<=i?'filled':''}"></i>`).join('')}</span><span class="quality-copy"><span><b>${q.name}</b><em>${q.tag}</em></span><small>${q.desc}</small></span><span class="quality-check">${svg('check')}</span></button>`).join('')}</div><p class="quality-note">桌面默认极致画质，适合 RTX 4070 Ti SUPER。画质即时切换，探索进度自动保存。</p><section class="performance-card" aria-label="当前渲染状态"><div class="performance-header"><span>此刻的小岛</span><small id="performance-quality-label">${current.name}</small></div><div class="performance-main"><span><b id="performance-fps">—</b><small>FPS · 实时帧率</small></span><div><span>当前设备</span><p id="performance-gpu">正在识别</p></div></div><dl class="performance-details"><div><dt>渲染比例</dt><dd id="performance-render-scale">—</dd></div><div><dt>草甸细节</dt><dd id="performance-grass">—</dd></div><div><dt>实时反射</dt><dd id="performance-reflection">—</dd></div><div><dt>照片光追</dt><dd id="performance-ray-tracing">未启用</dd></div></dl></section><div class="gentle-note">${svg('leaf')} 光影会随时间变化，喜欢的风景值得慢慢看。</div>`);
      setPerformance({...data,...data.stats,qualityLabel:current.name});
    }
    bindPanel();$('.panel-close')?.focus({preventScroll:true});
  }
  function showPostcard(card,collected=false){state.postcard=true;const el=$('#postcard-overlay');el.innerHTML=`<button class="postcard-close small-round" aria-label="关闭明信片">${svg('close')}</button><div class="postcard-intro"><span class="eyebrow postcard-subtitle">幸好我们的心连成一片一片...</span><h2>${collected?'重读一段温柔。':'原来，风也会寄信。'}</h2></div><figure class="postcard-paper"><img src="${esc(card.src)}" alt="${esc(card.title)}"><figcaption><span>${esc(card.title)}</span><i>NO. ${String(card.id).padStart(2,'0')} / 18</i></figcaption></figure><button class="primary postcard-collect">${collected?'收好这封来信':'放入背包'}${svg(collected?'check':'envelope')}</button><p class="postcard-note">${collected?'每一次重逢，都有新的心情。':'有些话，只想在这座岛上说给你听。'}</p>`;show(el,true);const close=()=>{state.postcard=false;show(el,false);};$('.postcard-close').addEventListener('click',close);$('.postcard-collect').addEventListener('click',()=>{if(!collected) call('collect',card.id);close();});$('.postcard-collect').focus({preventScroll:true});}
  $('#start-exploring').addEventListener('click',()=>call('start'));
  $$('[data-open]').forEach(b=>b.addEventListener('click',()=>{if(state.panel===b.dataset.open)closePanel();else call('open',b.dataset.open);}));
  $('#panel-shade').addEventListener('click',closePanel);$('#interaction-prompt').addEventListener('click',()=>call('action'));$('#music-button').addEventListener('click',()=>call('toggleMusic'));$('#photo-close').addEventListener('click',endPhoto);
  $$('[data-photo]').forEach(b=>b.addEventListener('click',()=>{call('photo',b.dataset.photo);$$('[data-photo]').forEach(n=>n.classList.toggle('selected',n===b));}));
  show($('#trace-photo'),typeof handlers.tracePhoto==='function');show($('#trace-photo-note'),typeof handlers.tracePhoto==='function');
  $('#trace-photo').addEventListener('click',()=>call('tracePhoto'));
  $('#shutter').addEventListener('click',()=>{call('capture');$('#photo-flash').classList.remove('flash');void $('#photo-flash').offsetWidth;$('#photo-flash').classList.add('flash');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(state.postcard){state.postcard=false;show($('#postcard-overlay'),false);}else if(!state.photo)closePanel();}});
  function setText(el,text){if(el.textContent!==String(text))el.textContent=String(text);}
  function setPerformance(stats={}){
    const info=typeof stats.rendererInfo==='object'&&stats.rendererInfo?stats.rendererInfo:typeof stats.rendererInfo==='string'?{gpu:stats.rendererInfo}:{};
    const values=Object.fromEntries(Object.entries({...info,...stats}).filter(([,value])=>value!==undefined));
    if(values.gpuName!==undefined&&values.gpu===undefined)values.gpu=values.gpuName;
    if(values.renderer!==undefined&&values.gpu===undefined)values.gpu=values.renderer;
    if(values.grassCount!==undefined&&values.grass===undefined)values.grass=values.grassCount;
    if(values.pixelRatio!==undefined&&values.renderScale===undefined)values.renderScale=values.pixelRatio;
    if(values.quality!==undefined&&values.qualityLabel===undefined){const key=typeof values.quality==='string'?values.quality:values.quality?.id;const option=qualityOptions.find(q=>q.id===key);if(option)values.qualityLabel=option.name;}
    state.performance={...state.performance,...values};
    const p=state.performance;
    const write=(selector,value)=>{const el=$(selector);if(el)setText(el,value);};
    if(p.rayTracing!==undefined){
      const rt=p.rayTracing,active=typeof rt==='object'?!!(rt.active||rt.enabled):rt===true||rt==='active';
      const loading=typeof rt==='object'?!!rt.loading:rt==='loading';
      const samples=p.traceSamples??p.samples??(typeof rt==='object'?rt.samples:undefined);
      $('#trace-photo')?.classList.toggle('selected',active||loading);
      const status=loading?'正在准备光追照片…':active?'渐进路径追踪 · 静止镜头采样'+(Number.isFinite(Number(samples))?' · '+Math.round(Number(samples))+' 次采样':''):'渐进路径追踪 · 静止镜头采样；首次需要加载';
      write('#trace-photo-note',p.traceStatus||status);
      write('#performance-ray-tracing',loading?'正在加载':active?'渐进采样中':'未启用');
    }
    if(state.panel!=='settings')return;
    if(p.fps!==undefined)write('#performance-fps',Number.isFinite(Number(p.fps))?Math.round(Number(p.fps)):'—');
    if(p.gpu!==undefined)write('#performance-gpu',p.gpu||'未知设备');
    if(p.qualityLabel!==undefined)write('#performance-quality-label',p.qualityLabel);
    if(p.renderScale!==undefined)write('#performance-render-scale',typeof p.renderScale==='number'?Math.round(p.renderScale*100)+'%':p.renderScale);
    if(p.grass!==undefined)write('#performance-grass',typeof p.grass==='number'?p.grass.toLocaleString('zh-CN')+' 株':p.grass);
    if(p.reflection!==undefined)write('#performance-reflection',typeof p.reflection==='boolean'?(p.reflection?'已开启':'已关闭'):p.reflection);
  }
  return {
    ready(){const b=$('#start-exploring');b.disabled=false;b.querySelector('span').textContent='开始探索';$('#load-bar').style.width='100%';setText($('#load-number'),'100%');setText($('#load-status'),'海风已至，等你登岛');},
    progress(text,percent){setText($('#load-status'),text);const p=Math.max(0,Math.min(100,percent||0));$('#load-bar').style.width=p+'%';setText($('#load-number'),String(Math.round(p)).padStart(2,'0')+'%');},
    setStarted(){state.started=true;$('#opening').classList.add('leaving');setTimeout(()=>show($('#opening'),false),950);show($('#hud'),true);ui.classList.add('started');},
    showToast(msg){clearTimeout(state.toastTimer);setText($('#island-toast span'),msg);$('#island-toast').classList.add('visible');state.toastTimer=setTimeout(()=>$('#island-toast').classList.remove('visible'),3600);},
    update(data={}){if(['quality','qualityLabel','gpu','gpuName','rendererInfo','fps','rayTracing','samples','traceSamples','traceStatus','renderScale','grass','reflection'].some(key=>data[key]!==undefined))setPerformance(data);if(data.count!==undefined){setText($('#collected-count'),String(data.count).padStart(2,'0'));$('#collection-progress').style.width=(data.count/18*100)+'%';}if(data.timeLabel)setText($('#time-label'),data.timeLabel);if(data.location)setText($('#place-label'),data.location);if(data.interaction!==undefined){setText($('#interaction-prompt span'),data.interaction);show($('#interaction-prompt'),!!data.interaction&&!state.photo);}if(data.music!==undefined){$('#music-button').classList.toggle('muted',!data.music);$('#music-button').setAttribute('aria-label',data.music?'关闭背景音乐':'开启背景音乐');}if(data.vehicle!==undefined&&state.vehicle!==data.vehicle){state.vehicle=data.vehicle;const vc=$('#vehicle-controls');show(vc,data.vehicle!=='off'&&!!data.vehicle);if(data.vehicle==='egg'){vc.innerHTML=`<div class="vehicle-label">蛋 · 乘着风，去看看更远的地方。<span>高度 <b id="altitude-number">0</b> m</span></div><div><button data-vehicle="up">↑ 上升</button><button data-vehicle="down">↓ 下降</button><button data-vehicle="exit">离开蛋</button></div>`;}else if(data.vehicle==='shell'){vc.innerHTML=`<div class="vehicle-label shell-label">珠玉 · 在海声里休息<small>把这一刻，留给海浪与自己。</small></div><button data-vehicle="exit">起身 ${svg('arrow')}</button>`;}else if(data.vehicle==='flight'){vc.innerHTML=`<div class="vehicle-label">云海之上的一小片自由。<span>高度 <b id="altitude-number">0</b> m</span></div><button data-travel>交换 · 返回主岛 ${svg('arrow')}</button>`;}vc.querySelectorAll('[data-vehicle]').forEach(b=>b.addEventListener('click',()=>call('vehicle',b.dataset.vehicle)));vc.querySelector('[data-travel]')?.addEventListener('click',()=>call('travel'));}if(data.altitude!==undefined&&$('#altitude-number'))setText($('#altitude-number'),Math.round(data.altitude));},
    openPanel,closePanel,endPhoto,showPostcard,setPerformance,isBlocking(){return !state.started||!!state.panel||state.postcard;}
  };
}

