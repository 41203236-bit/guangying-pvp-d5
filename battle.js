import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getDatabase, ref, onValue, update } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || '').trim();
const myRole = ((params.get('role') || '').trim().toUpperCase() === 'X') ? 'X' : 'O';
const roomRef = ref(db, `rooms/${roomCode}`);
if(!roomCode) location.href = './index.html';

const sounds = {
  tap: new Audio('sounds/tap.mp3'), atk: new Audio('sounds/atk.mp3'),
  def: new Audio('sounds/def.mp3'), hel: new Audio('sounds/hel.mp3'),
  stn: new Audio('sounds/stn.mp3'), tick: new Audio('sounds/tick.mp3')
};
function playSound(name){ const s=sounds[name]; if(s){ s.pause(); s.currentTime=0; s.play().catch(()=>{}); } }
function stopSound(name){ const s=sounds[name]; if(s){ s.pause(); s.currentTime=0; } }

const boardEl = document.getElementById('board');
for(let i=0;i<9;i++){
  const d = document.createElement('div');
  d.className = 'cell'; d.id = `c-${i}`; d.addEventListener('click', ()=>tap(i));
  boardEl.appendChild(d);
}
document.getElementById('roomCode').textContent = roomCode || '-';

let roomCache = null, state = null, turnTimerInterval = null;

function clone(o){ return JSON.parse(JSON.stringify(o)); }
function wins(){ return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,4,6],[0,4,8],[2,4,6]]; }
function basePlayer(){ return { hp:100, sp:0, skillUsed:0, stunned:0, defending:false }; }
function nextTurnEndsAt(){ return Date.now() + 30000; }
function defaultState(host='O'){ return { turn: host==='X'?'X':'O', grid:Array(9).fill(null), queues:{O:[],X:[]}, data:{O:basePlayer(),X:basePlayer()}, timeLeft:30, turnEndsAt: nextTurnEndsAt() }; }
function asFirebaseArray(v, length){ if(Array.isArray(v)) return v; if(v&&typeof v==='object'){ const arr=Array(length).fill(null); for(const [k,val] of Object.entries(v)){ const i=Number(k); if(Number.isInteger(i)&&i>=0&&i<length) arr[i]=val; } return arr; } return null; }
function normalizeState(raw, host='O'){
  const d = defaultState(host); const s = raw && typeof raw==='object' ? raw : {};
  return {
    turn: s.turn==='O'||s.turn==='X' ? s.turn : d.turn,
    grid: (asFirebaseArray(s.grid,9) || d.grid).map(v => v==='O'||v==='X'?v:null),
    queues: {
      O: (asFirebaseArray(s.queues?.O,9)||[]).filter(n=>Number.isInteger(n)&&n>=0&&n<9),
      X: (asFirebaseArray(s.queues?.X,9)||[]).filter(n=>Number.isInteger(n)&&n>=0&&n<9)
    },
    data: { O:{...d.data.O,...(s.data?.O||{})}, X:{...d.data.X,...(s.data?.X||{})} },
    timeLeft: Number.isFinite(s.timeLeft) ? s.timeLeft : 30,
    turnEndsAt: Number.isFinite(s.turnEndsAt) ? s.turnEndsAt : nextTurnEndsAt()
  };
}
function isGameOver(s){ return (s?.data?.O?.hp ?? 100) <= 0 || (s?.data?.X?.hp ?? 100) <= 0; }
function displayMark(v){ return v==='O'?'◯':v==='X'?'✕':''; }
function checkWin(grid){ const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; return lines.find(l => grid[l[0]] && grid[l[0]]===grid[l[1]] && grid[l[1]]===grid[l[2]]); }
function triggerShake(){ const el=document.getElementById('main-container'); el.classList.add('shake-effect'); setTimeout(()=>el.classList.remove('shake-effect'),300); }
function showFloatText(id, txt, col){ const box=document.getElementById(id); if(!box) return; const el=document.createElement('div'); el.className='float-text'; el.innerText=txt; el.style.color=col; el.style.left='0'; box.appendChild(el); setTimeout(()=>el.remove(),800); }
function drawWinLine(combo){
  const canvas = document.getElementById('win-line-canvas'); if(!combo) { canvas.innerHTML=''; return; }
  const start = document.getElementById('c-'+combo[0]).getBoundingClientRect();
  const end = document.getElementById('c-'+combo[2]).getBoundingClientRect();
  const wrap = document.querySelector('.board-wrapper').getBoundingClientRect();
  const x1 = (start.left + start.width/2) - wrap.left, y1 = (start.top + start.height/2) - wrap.top;
  const x2 = (end.left + end.width/2) - wrap.left, y2 = (end.top + end.height/2) - wrap.top;
  canvas.innerHTML = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="winning-line" />`;
}
function applyTimerAlert(remain){
  const el = document.getElementById('timer-container');
  if(remain <= 10){ el.classList.add('timer-warn'); if(remain>0) { playSound('tick'); } }
  else { el.classList.remove('timer-warn'); stopSound('tick'); }
}
function updateTimerDisplay(){
  if(!state){ return; }
  const phase = roomCache?.phase || 'playing';
  if(phase !== 'playing'){ document.getElementById('timer-container').textContent='--'; document.getElementById('timer-container').classList.remove('timer-warn'); return; }
  const remain = Math.max(0, Math.ceil(((state.turnEndsAt||nextTurnEndsAt()) - Date.now())/1000));
  document.getElementById('timer-container').textContent = String(remain);
  applyTimerAlert(remain);
}
function startTurnTimer(){
  clearInterval(turnTimerInterval); updateTimerDisplay();
  turnTimerInterval = setInterval(async ()=>{
    if(!state || (roomCache?.phase||'playing') !== 'playing') return;
    const remain = Math.max(0, Math.ceil(((state.turnEndsAt||nextTurnEndsAt()) - Date.now())/1000));
    document.getElementById('timer-container').textContent = String(remain);
    applyTimerAlert(remain);
    if(remain <= 0 && myRole === roomCache?.host && !isGameOver(state)){
      const s = clone(state); swapTurnLocal(s); state=s; render(); try{ await pushState(s); }catch{}
    }
  },250);
}
function setOverlay(msg){ const overlay=document.getElementById('overlayWait'); document.getElementById('overlayMsg').textContent=msg; overlay.style.display='flex'; }
function hideOverlay(){ document.getElementById('overlayWait').style.display='none'; }
function setBoardLock(canAct,msg){
  const bw=document.getElementById('board-wrap'), sw=document.getElementById('skill-footer-wrap');
  const bm=document.getElementById('board-lock-mask'), sm=document.getElementById('skill-lock-mask');
  if(canAct){ bw.classList.remove('interaction-locked'); sw.classList.remove('interaction-locked'); bw.style.pointerEvents='auto'; sw.style.pointerEvents='auto'; bm.textContent=''; sm.textContent=''; }
  else { bw.classList.add('interaction-locked'); sw.classList.add('interaction-locked'); bm.textContent=msg||'等待對手回合'; sm.textContent=msg||'不是你的操作階段'; }
}
function applyPerspective(){
  const panelO=document.getElementById('panel-O'), panelX=document.getElementById('panel-X');
  const badgeO=document.getElementById('badge-O'), badgeX=document.getElementById('badge-X');
  panelO.className='side-panel'; panelX.className='side-panel'; badgeO.className='identity-badge'; badgeX.className='identity-badge';
  if(myRole==='O'){ panelO.classList.add('my-side'); panelX.classList.add('enemy-side'); badgeO.classList.add('me'); badgeX.classList.add('enemy'); badgeO.textContent='你 · 光 / O'; badgeX.textContent='對手 · 影 / X'; }
  else { panelX.classList.add('my-side'); panelO.classList.add('enemy-side'); badgeX.classList.add('me'); badgeO.classList.add('enemy'); badgeX.textContent='你 · 影 / X'; badgeO.textContent='對手 · 光 / O'; }
  if(state?.turn==='O') panelO.classList.add('active-side-O');
  if(state?.turn==='X') panelX.classList.add('active-side-X');
}
function renderSkills(){
  const myData = state?.data?.[myRole] || basePlayer();
  let dotsHTML=''; for(let i=0;i<3;i++) dotsHTML += `<div class="u-dot ${i < (3 - (myData.skillUsed||0)) ? 'fill' : ''}"></div>`;
  document.getElementById('usage-dots-container').innerHTML = dotsHTML;
  const skills=[{t:'atk',c:1},{t:'def',c:2},{t:'hel',c:2},{t:'stn',c:3}];
  const canAct = (roomCache?.phase||'playing')==='playing' && state?.turn===myRole && !isGameOver(state);
  const sealed = !!myData.stunned;
  document.getElementById('skill-list-container').innerHTML = skills.map(s=>{
    const can = canAct && !sealed && myData.sp >= s.c && myData.skillUsed < 3;
    return `<button class="s-btn btn-${s.t} ${can?'active':''} ${sealed?'sealed':''}" data-skill="${s.t}"><div class="cost-tag">SP ${s.c}</div></button>`;
  }).join('');
  document.querySelectorAll('[data-skill]').forEach(btn=>btn.addEventListener('click',()=>useSkill(btn.dataset.skill)));
}
function render(){
  if(!state) return;
  const phase = roomCache?.phase || 'playing';
  if(phase === 'playing') hideOverlay(); else if(phase === 'countdown') setOverlay('倒數中…'); else if(phase === 'ended') setOverlay(roomCache?.winner===myRole?'你獲勝了':'戰鬥結束'); else setOverlay('等待戰鬥狀態…');
  document.getElementById('turnText').textContent = phase==='playing' ? (state.turn===myRole ? '現在輪到你操作' : `現在輪到${state.turn==='O'?'光 / O':'影 / X'}`) : '等待戰鬥開始';
  updateTimerDisplay();
  ['O','X'].forEach(p=>{
    const hp = Math.max(0, Math.min(100, Number(state.data?.[p]?.hp ?? 100)));
    const fill=document.getElementById(`hp-fill-${p}`), ghost=document.getElementById(`hp-ghost-${p}`), val=document.getElementById(`hp-val-${p}`), avatar=document.getElementById(`avatar-${p}`);
    fill.style.clipPath = `inset(${100-hp}% 0 0 0)`; ghost.style.clipPath = `inset(${100-hp}% 0 0 0)`; val.innerText=Math.floor(hp)+'%'; val.style.top=`calc(${100-hp}% + 10px)`;
    if(state.data[p].defending) fill.classList.add('defending-bar'); else fill.classList.remove('defending-bar');
    if(state.data[p].stunned) avatar.classList.add('stunned-avatar'); else avatar.classList.remove('stunned-avatar');
    let spHTML=''; const sp=Math.max(0,Math.min(5,Number(state.data?.[p]?.sp ?? 0))); for(let i=0;i<5;i++) spHTML += `<div class="sp-dot ${i<sp?'sp-on':'sp-off'}"></div>`; document.getElementById(`sp-display-${p}`).innerHTML=spHTML;
  });
  for(let i=0;i<9;i++){
    const el=document.getElementById(`c-${i}`); const v=state.grid?.[i]||''; el.textContent=displayMark(v); el.className='cell '+v;
    if(v && state.queues?.[v]?.length===3 && state.queues[v][0]===i) el.classList.add('warning-cell');
  }
  renderSkills(); applyPerspective();
  const canAct = phase==='playing' && state.turn===myRole && !isGameOver(state);
  const msg = phase!=='playing' ? '等待戰鬥開始' : isGameOver(state) ? '戰鬥已結束' : state.turn!==myRole ? '等待對手回合' : '';
  setBoardLock(canAct,msg);
}
function swapTurnLocal(s){
  stopSound('tick');
  if(s.data[s.turn].stunned > 0) s.data[s.turn].stunned--;
  s.data[s.turn].skillUsed = 0;
  s.turn = s.turn==='O'?'X':'O';
  s.data[s.turn].defending = false;
  s.turnEndsAt = nextTurnEndsAt();
  return s;
}
function resetGridLocal(s){ document.getElementById('win-line-canvas').innerHTML=''; s.grid=Array(9).fill(null); s.queues={O:[],X:[]}; return swapTurnLocal(s); }
async function pushState(newState){ await update(roomRef,{ state:newState }); }
async function tap(i){
  if(!state || (roomCache?.phase||'playing')!=='playing' || state.turn!==myRole || state.grid[i] || isGameOver(state)) return;
  playSound('tap');
  const s=clone(state); if(s.queues[s.turn].length>=3){ const old=s.queues[s.turn].shift(); s.grid[old]=null; }
  s.grid[i]=s.turn; s.queues[s.turn].push(i);
  state=s; render();
  const combo = checkWin(s.grid);
  if(combo){ drawWinLine(combo); s.data[s.turn].sp=Math.min(5,s.data[s.turn].sp+1); setTimeout(async ()=>{ resetGridLocal(s); state=s; render(); try{ await pushState(s); }catch{} }, 700); }
  else { swapTurnLocal(s); state=s; render(); try{ await pushState(s); }catch{} }
}
async function useSkill(type){
  if(!state || (roomCache?.phase||'playing')!=='playing' || state.turn!==myRole || isGameOver(state)) return;
  const s=clone(state), p=s.turn, target=p==='O'?'X':'O'; if(s.data[p].stunned>0 || s.data[p].skillUsed>=3) return;
  const cost=type==='atk'?1:type==='stn'?3:2; if(s.data[p].sp<cost) return;
  s.data[p].sp-=cost; s.data[p].skillUsed++; playSound(type);
  if(type==='atk'){ let dmg=10; if(s.data[target].defending){ dmg=5; s.data[target].defending=false; } s.data[target].hp=Math.max(0,s.data[target].hp-dmg); triggerShake(); showFloatText(`hp-box-${target}`,`-${dmg}`,'#ff4b2b'); }
  else if(type==='def'){ s.data[p].defending=true; }
  else if(type==='hel'){ s.data[p].hp=Math.min(100,s.data[p].hp+8); showFloatText(`hp-box-${p}`,'+8','#4CAF50'); }
  else if(type==='stn'){ s.data[target].stunned=3; triggerShake(); showFloatText(`hp-box-${target}`,'SEALED!','#ff00ff'); }
  if(isGameOver(s)){ state=s; render(); try{ await update(roomRef,{ state:s, phase:'ended', winner:p }); }catch{} return; }
  state=s; render(); try{ await pushState(s); }catch{}
}
onValue(roomRef, snap=>{
  const room=snap.val(); if(!room){ location.href='./index.html'; return; }
  roomCache=room; state=normalizeState(room.state, room.host || 'O');
  if((room.phase||'playing')==='playing') startTurnTimer(); else clearInterval(turnTimerInterval);
  render();
});
window.tap = tap; window.useSkill = useSkill;
