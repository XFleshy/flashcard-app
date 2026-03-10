import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";

// ─── Constants ────────────────────────────────────────────────────────────────
const MASTERY_THRESHOLD = 4;
const ROUND_SIZE = 7;

const SET_COLORS  = ["#7c3aed","#0ea5e9","#10b981","#f59e0b","#ef4444","#ec4899","#8b5cf6","#14b8a6"];
const SET_EMOJIS  = ["💻","📚","🧪","🧮","🌍","🏛️","🎨","⚗️","🔬","📐","🎯","🧠"];

const SAMPLE_RAW = "";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const shuffle = (a) => [...a].sort(() => Math.random() - 0.5);
const uid = () => `set_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

function parseCards(raw) {
  return (raw || "").split("\n").map(l => l.trim()).filter(l => l.includes("\t"))
    .map((l, i) => { const [term, ...rest] = l.split("\t"); return { id: i, term: term.trim(), def: rest.join("\t").trim() }; });
}

// ─── Spaced Repetition ────────────────────────────────────────────────────────
function srPriority(p) {
  if (!p) return 50;
  if (p.mastered) return 9999;
  return (p.correctStreak || 0) * 10 - (p.totalIncorrect || 0) * 5;
}
function buildSRQueue(cards, progress, size) {
  const active = cards.filter(c => !progress[c.id]?.mastered);
  if (!active.length) return shuffle([...cards]).slice(0, size);
  const sorted = [...active].sort((a,b) => srPriority(progress[a.id]) - srPriority(progress[b.id]));
  const weak = sorted.slice(0, Math.ceil(size * 0.7));
  const rest = shuffle(sorted.slice(Math.ceil(size * 0.7))).slice(0, Math.floor(size * 0.3));
  return shuffle([...weak, ...rest]);
}

// ─── Sound ────────────────────────────────────────────────────────────────────
function createSound() {
  let ctx = null;
  const get = () => { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; };
  const tone = (c, freq, t, dur, gain=0.06, type="sine") => {
    const o=c.createOscillator(), g=c.createGain(), f=c.createBiquadFilter();
    f.type="lowpass"; f.frequency.value=3200;
    o.connect(f); f.connect(g); g.connect(c.destination);
    o.type=type; o.frequency.setValueAtTime(freq,t);
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(gain,t+0.015);
    g.gain.setValueAtTime(gain,t+dur*0.5);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.start(t); o.stop(t+dur+0.01);
  };
  const play = (type) => {
    try {
      const c=get(), t=c.currentTime;
      if (type==="correct")    { tone(c,880,t,.18,.055); tone(c,1174,t+.09,.22,.045); }
      else if(type==="wrong")  { tone(c,220,t,.15,.08,"triangle"); tone(c,185,t+.07,.18,.06,"triangle"); }
      else if(type==="mastered"){ tone(c,880,t,.22,.07); tone(c,1174,t+.1,.22,.065); tone(c,1568,t+.2,.28,.06); }
      else if(type==="flip")   { tone(c,1000,t,.06,.04); }
      else if(type==="nav")    { tone(c,700,t,.05,.03); }
      else if(type==="sectionEnd"){ tone(c,1046,t,.2,.065); tone(c,880,t+.1,.15,.05); tone(c,1174,t+.22,.25,.06); }
    } catch(_) {}
  };
  return { play };
}
const sound = createSound();

// ─── Confetti ─────────────────────────────────────────────────────────────────
function spawnConfetti(n=20) {
  const colors=["#7c3aed","#c084fc","#f472b6","#34d399","#fbbf24","#fff"];
  for(let i=0;i<n;i++) setTimeout(()=>{
    const el=document.createElement("div"); el.className="confetti";
    el.style.cssText=`left:${15+Math.random()*70}vw;top:${5+Math.random()*25}vh;background:${colors[~~(Math.random()*colors.length)]};width:${6+Math.random()*6}px;height:${6+Math.random()*6}px;border-radius:${Math.random()>.5?"50%":"2px"};animation-duration:${.7+Math.random()*.7}s;animation-delay:${Math.random()*.25}s;`;
    document.body.appendChild(el); setTimeout(()=>el.remove(),1400);
  }, i*28);
}

// ─── MCQ / TF ─────────────────────────────────────────────────────────────────
function buildMCQ(card, all, dir) {
  if (dir==="defToTerm") {
    const w=shuffle(all.filter(c=>c.id!==card.id)).slice(0,3).map(c=>c.term);
    return { questionText:card.def, questionLabel:"Which term matches this definition?", options:shuffle([card.term,...w]), correctAnswer:card.term, isReverse:true };
  }
  const w=shuffle(all.filter(c=>c.id!==card.id)).slice(0,3).map(c=>c.def);
  return { questionText:card.term, questionLabel:"Choose the correct definition", options:shuffle([card.def,...w]), correctAnswer:card.def, isReverse:false };
}
function buildTF(card, all) {
  const isTrue=Math.random()>.5, rev=Math.random()>.5;
  if (rev) { const wt=shuffle(all.filter(c=>c.id!==card.id))[0]?.term||card.term; return{card,shownTerm:isTrue?card.term:wt,shownDef:card.def,mode:"defFirst",isTrue}; }
  const wd=shuffle(all.filter(c=>c.id!==card.id))[0]?.def||card.def;
  return{card,shownTerm:card.term,shownDef:isTrue?card.def:wd,mode:"termFirst",isTrue};
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#0e0b1a; --surface:#150f2b; --surface2:#1c1438; --surface3:#241b47;
  --border:#2e2356; --border2:#3d3070;
  --accent:#7c3aed; --accent2:#9f67ff; --accent-glow:rgba(124,58,237,.25); --accent-light:rgba(159,103,255,.15);
  --violet:#c084fc; --pink:#f472b6; --teal:#34d399; --teal-glow:rgba(52,211,153,.15);
  --yellow:#fbbf24; --red:#f87171; --red-glow:rgba(248,113,113,.12);
  --text:#ede9f8; --text2:#9b91c0; --text3:#5c5480;
  --radius:14px; --card-h:320px;
}
html,body,#root{height:100%;}
body{background:var(--bg);color:var(--text);font-family:'Sora',sans-serif;font-size:14px;line-height:1.6;}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 20% 0%,rgba(124,58,237,.12) 0%,transparent 60%),radial-gradient(ellipse 60% 40% at 80% 100%,rgba(196,132,252,.08) 0%,transparent 60%);pointer-events:none;z-index:0;}
.app{min-height:100vh;position:relative;z-index:1;}

/* ── AUTH SCREEN ── */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
.auth-card{background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:40px 36px;width:100%;max-width:420px;box-shadow:0 24px 64px rgba(0,0,0,.5);}
.auth-logo{font-size:28px;font-weight:800;color:#fff;letter-spacing:-.5px;margin-bottom:6px;}
.auth-logo em{font-style:normal;background:linear-gradient(90deg,var(--accent2),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.auth-tagline{font-size:13px;color:var(--text2);margin-bottom:32px;}
.auth-tabs{display:flex;gap:0;background:var(--surface2);border-radius:10px;padding:4px;margin-bottom:24px;}
.auth-tab{flex:1;padding:9px;border:none;background:transparent;color:var(--text2);font-family:'Sora',sans-serif;font-size:13px;font-weight:600;cursor:pointer;border-radius:7px;transition:all .15s;}
.auth-tab.active{background:var(--surface3);color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3);}
.auth-field{margin-bottom:14px;}
.auth-field label{display:block;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);margin-bottom:6px;}
.auth-field input{width:100%;padding:13px 16px;background:var(--bg);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-family:'Sora',sans-serif;font-size:14px;outline:none;transition:border-color .15s;}
.auth-field input:focus{border-color:var(--accent2);box-shadow:0 0 0 3px var(--accent-glow);}
.auth-error{background:var(--red-glow);border:1px solid var(--red);border-radius:9px;padding:10px 14px;font-size:12px;color:var(--red);margin-bottom:14px;}
.auth-success{background:var(--teal-glow);border:1px solid var(--teal);border-radius:9px;padding:10px 14px;font-size:12px;color:var(--teal);margin-bottom:14px;}
.auth-footer{margin-top:16px;font-size:12px;color:var(--text2);text-align:center;}

/* ── TOPBAR ── */
.topbar{display:flex;align-items:center;gap:10px;padding:13px 24px;border-bottom:1px solid var(--border);background:rgba(14,11,26,.92);backdrop-filter:blur(14px);position:sticky;top:0;z-index:100;}
.topbar-back{display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text2);font-family:'Sora',sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;}
.topbar-back:hover{border-color:var(--border2);color:var(--text);}
.topbar-set-info{display:flex;align-items:center;gap:8px;flex:1;min-width:0;}
.topbar-set-emoji{font-size:18px;flex-shrink:0;}
.topbar-set-name{font-size:15px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.logo{font-size:20px;font-weight:800;color:#fff;letter-spacing:-.5px;}
.logo em{font-style:normal;background:linear-gradient(90deg,var(--accent2),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.topbar-right{display:flex;gap:8px;align-items:center;flex-shrink:0;}
.sound-btn{display:flex;align-items:center;gap:5px;padding:6px 12px;border:1px solid var(--border);border-radius:99px;background:transparent;color:var(--text2);font-family:'Sora',sans-serif;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;}
.sound-btn:hover{border-color:var(--accent2);color:var(--accent2);}
.sound-btn.on{border-color:var(--accent);color:var(--violet);}
.avatar-btn{width:34px;height:34px;border-radius:99px;border:1.5px solid var(--border2);background:var(--surface2);color:var(--violet);font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;font-family:'Sora',sans-serif;}
.avatar-btn:hover{border-color:var(--accent2);}

/* ── USER MENU ── */
.user-menu-wrap{position:relative;}
.user-menu{position:absolute;right:0;top:calc(100% + 8px);background:var(--surface2);border:1px solid var(--border2);border-radius:12px;padding:8px;min-width:200px;box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:200;}
.user-menu-email{padding:8px 12px;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border);margin-bottom:6px;word-break:break-all;}
.user-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;background:transparent;border:none;color:var(--text);font-family:'Sora',sans-serif;font-size:13px;cursor:pointer;border-radius:8px;transition:background .12s;}
.user-menu button:hover{background:var(--surface3);}
.user-menu button.danger{color:var(--red);}

/* ── LIBRARY ── */
.library{max-width:960px;margin:0 auto;padding:32px 24px 80px;}
.library-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;gap:12px;flex-wrap:wrap;}
.library-title{font-size:26px;font-weight:800;color:#fff;}
.library-title span{background:linear-gradient(90deg,var(--accent2),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.sets-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;}

/* ── SET CARD ── */
.set-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:22px;cursor:pointer;transition:all .2s;position:relative;overflow:hidden;}
.set-card::before{content:'';position:absolute;inset:0;opacity:0;transition:opacity .2s;background:linear-gradient(135deg,rgba(124,58,237,.08),transparent);}
.set-card:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:0 8px 32px rgba(0,0,0,.3);}
.set-card:hover::before{opacity:1;}
.set-card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.set-emoji-wrap{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}
.set-menu-btn{background:transparent;border:none;color:var(--text3);cursor:pointer;font-size:18px;padding:4px 8px;border-radius:6px;transition:all .15s;line-height:1;}
.set-menu-btn:hover{background:var(--surface2);color:var(--text2);}
.set-dropdown{position:absolute;right:0;top:100%;margin-top:4px;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:6px;z-index:50;min-width:150px;box-shadow:0 8px 24px rgba(0,0,0,.4);}
.set-dropdown button{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;background:transparent;border:none;color:var(--text);font-family:'Sora',sans-serif;font-size:13px;cursor:pointer;border-radius:7px;transition:background .12s;text-align:left;}
.set-dropdown button:hover{background:var(--surface3);}
.set-dropdown button.danger{color:var(--red);}
.set-dropdown .sep{height:1px;background:var(--border);margin:4px 0;}
.set-card-name{font-size:15px;font-weight:700;color:#fff;margin-bottom:4px;line-height:1.3;}
.set-card-meta{font-size:11px;color:var(--text2);}
.set-mini-bar{height:4px;background:var(--surface3);border-radius:99px;overflow:hidden;margin-top:12px;}
.set-mini-fill{height:100%;border-radius:99px;transition:width .3s;}
.set-mini-labels{display:flex;justify-content:space-between;margin-top:5px;font-size:10px;color:var(--text3);}
.set-card-new{border-style:dashed;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:160px;color:var(--text2);}
.set-card-new:hover{border-color:var(--accent2);color:var(--accent2);}
.set-card-new .plus{font-size:32px;line-height:1;}

/* ── SYNC STATUS ── */
.sync-dot{width:7px;height:7px;border-radius:99px;flex-shrink:0;}
.sync-dot.ok{background:var(--teal);}
.sync-dot.syncing{background:var(--yellow);animation:pulse .8s ease-in-out infinite alternate;}
.sync-dot.err{background:var(--red);}
@keyframes pulse{from{opacity:.4;}to{opacity:1;}}

/* ── MODAL ── */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;}
.modal{background:var(--surface);border:1px solid var(--border2);border-radius:20px;padding:28px;width:100%;max-width:520px;box-shadow:0 24px 64px rgba(0,0,0,.5);}
.modal-title{font-size:18px;font-weight:800;color:#fff;margin-bottom:20px;}
.modal input[type=text]{width:100%;padding:12px 16px;background:var(--bg);border:1.5px solid var(--border);border-radius:9px;color:var(--text);font-family:'Sora',sans-serif;font-size:14px;outline:none;transition:border-color .15s;margin-bottom:14px;}
.modal input[type=text]:focus{border-color:var(--accent2);}
.modal-label{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);margin-bottom:8px;display:block;}
.emoji-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;}
.emoji-opt{width:38px;height:38px;border-radius:9px;border:1.5px solid var(--border);background:var(--surface2);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;}
.emoji-opt:hover,.emoji-opt.sel{border-color:var(--accent2);background:var(--surface3);}
.emoji-opt.sel{box-shadow:0 0 0 2px var(--accent2);}
.color-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;}
.color-opt{width:32px;height:32px;border-radius:99px;cursor:pointer;transition:all .15s;border:2px solid transparent;}
.color-opt.sel{border-color:#fff;transform:scale(1.15);}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;}

/* ── BUTTONS ── */
.btn{padding:10px 22px;border-radius:9px;font-family:'Sora',sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all .18s;border:1.5px solid transparent;display:inline-flex;align-items:center;gap:6px;}
.btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:var(--accent);box-shadow:0 2px 16px rgba(124,58,237,.35);}
.btn-primary:hover{filter:brightness(1.12);}
.btn-ghost{background:transparent;color:var(--text2);border-color:var(--border);}
.btn-ghost:hover{color:var(--text);border-color:var(--border2);}
.btn-teal{background:var(--teal);color:#0e0b1a;border-color:var(--teal);font-weight:700;}
.btn-teal:hover{filter:brightness(1.08);}
.btn-danger{color:var(--red);border-color:var(--red);background:transparent;}
.btn-danger:hover{background:var(--red-glow);}
.btn-violet{color:var(--violet);border-color:var(--violet);background:transparent;}
.btn-sm{padding:7px 14px;font-size:11px;}
.btn:disabled{opacity:.35;cursor:default;}
.btn-full{width:100%;justify-content:center;}

/* ── STATS ── */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:28px;}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;}
.stat-val{font-size:28px;font-weight:800;line-height:1;margin-bottom:4px;}
.stat-lbl{font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);}

/* ── PROGRESS BAR ── */
.prog-wrap{margin-bottom:24px;}
.prog-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.prog-label{font-size:12px;color:var(--text2);font-weight:500;}
.prog-count{font-size:13px;font-weight:700;color:var(--violet);}
.prog-track{height:8px;background:var(--surface3);border-radius:99px;overflow:visible;position:relative;}
.prog-bar{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2),var(--pink));border-radius:99px;transition:width .4s cubic-bezier(.4,0,.2,1);box-shadow:0 0 12px rgba(124,58,237,.45);}
.prog-thumb{position:absolute;top:50%;transform:translate(-50%,-50%);width:24px;height:24px;background:var(--surface);border:2px solid var(--accent2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--violet);transition:left .4s;pointer-events:none;}

/* ── SECTION DOTS ── */
.section-dots{display:flex;gap:6px;justify-content:center;margin-bottom:20px;}
.sdot{width:28px;height:6px;border-radius:99px;background:var(--surface3);transition:all .3s;}
.sdot.done{background:var(--teal);}
.sdot.active{background:var(--accent2);box-shadow:0 0 8px var(--accent-glow);}

/* ── SECTION BANNER ── */
.section-banner{background:linear-gradient(135deg,rgba(124,58,237,.18),rgba(159,103,255,.1));border:1px solid var(--border2);border-radius:14px;padding:18px 22px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
.section-banner-left h3{font-size:15px;font-weight:700;color:#fff;margin-bottom:2px;}
.section-banner-left p{font-size:12px;color:var(--text2);}
.section-tag{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent2);background:var(--accent-light);padding:4px 12px;border-radius:99px;border:1px solid rgba(159,103,255,.3);white-space:nowrap;}

/* ── SECTION END ── */
.section-end{text-align:center;padding:40px 24px;background:linear-gradient(135deg,var(--surface),var(--surface2));border:1px solid var(--border);border-radius:20px;}
.section-end-score{font-size:56px;font-weight:800;line-height:1;margin-bottom:6px;}
.section-end-label{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--text2);margin-bottom:16px;}
.section-end-breakdown{display:flex;gap:20px;justify-content:center;margin-bottom:24px;flex-wrap:wrap;}
.seb-val{font-size:24px;font-weight:800;}
.seb-lbl{font-size:10px;color:var(--text2);letter-spacing:1px;text-transform:uppercase;margin-top:2px;}
.weak-review{margin-top:20px;text-align:left;}
.weak-review-title{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--red);margin-bottom:10px;}
.weak-row{background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.25);border-radius:9px;padding:12px 16px;margin-bottom:6px;}
.weak-row-term{font-weight:700;color:#fff;font-size:13px;margin-bottom:3px;}
.weak-row-def{font-size:12px;color:var(--text2);line-height:1.6;}

/* ── SR CHIPS ── */
.sr-insight{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;}
.sr-chip{font-size:11px;font-weight:600;padding:5px 11px;border-radius:99px;border:1px solid;}
.sr-chip.new{color:var(--accent2);border-color:var(--accent2);background:var(--accent-light);}
.sr-chip.review{color:var(--yellow);border-color:var(--yellow);background:rgba(251,191,36,.1);}
.sr-chip.struggling{color:var(--red);border-color:var(--red);background:var(--red-glow);}
.sr-chip.mastered{color:var(--teal);border-color:var(--teal);background:var(--teal-glow);}

/* ── FLASHCARD ── */
.card-area{perspective:1400px;margin-bottom:20px;}
.card-wrap{width:100%;height:var(--card-h);position:relative;transform-style:preserve-3d;transition:transform .55s cubic-bezier(.4,0,.2,1);cursor:pointer;}
.card-wrap.flipped{transform:rotateY(180deg);}
.card-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:18px;border:1px solid var(--border);background:linear-gradient(135deg,var(--surface),var(--surface2));display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.5);}
.card-back{transform:rotateY(180deg);background:linear-gradient(135deg,var(--surface2),var(--surface3));border-color:var(--border2);}
.card-chip{position:absolute;top:20px;left:20px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text3);padding:4px 10px;border:1px solid var(--border);border-radius:99px;}
.card-term{font-size:clamp(22px,4vw,38px);font-weight:700;color:#fff;line-height:1.25;}
.card-def{font-size:clamp(13px,2vw,16px);color:var(--text);line-height:1.8;max-width:580px;}
.card-hint{position:absolute;bottom:20px;font-size:11px;color:var(--text3);letter-spacing:.5px;}
.card-nav{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:8px;flex-wrap:wrap;}
.mastered-pill{display:inline-flex;align-items:center;gap:6px;background:var(--teal-glow);border:1px solid var(--teal);color:var(--teal);border-radius:99px;padding:5px 14px;font-size:11px;font-weight:700;margin-bottom:12px;}

/* ── LEARN ── */
.learn-wrap{max-width:680px;margin:0 auto;}
.learn-q-card{background:linear-gradient(135deg,var(--surface),var(--surface2));border:1px solid var(--border);border-radius:18px;padding:36px 32px;text-align:center;margin-bottom:20px;box-shadow:0 4px 40px rgba(0,0,0,.4);}
.learn-q-label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--text3);margin-bottom:10px;}
.learn-q-type-chip{display:inline-block;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 12px;border-radius:99px;margin-bottom:16px;background:var(--accent-light);color:var(--accent2);border:1px solid rgba(124,58,237,.4);}
.learn-q-type-chip.reverse{background:rgba(244,114,182,.12);color:var(--pink);border-color:rgba(244,114,182,.4);}
.learn-q-type-chip.tf{background:rgba(251,191,36,.1);color:var(--yellow);border-color:rgba(251,191,36,.35);}
.learn-q-text{font-size:clamp(17px,3vw,25px);font-weight:700;color:#fff;line-height:1.35;}
.learn-q-def-text{font-size:clamp(13px,2vw,15px);color:var(--text);line-height:1.8;max-width:560px;margin:0 auto;}
.learn-q-subtext{font-size:13px;color:var(--text2);margin-top:10px;line-height:1.6;}
.mc-grid{display:flex;flex-direction:column;gap:8px;}
.mc-opt{padding:14px 20px;border-radius:11px;border:1.5px solid var(--border);background:var(--surface2);color:var(--text);font-family:'Sora',sans-serif;font-size:13px;cursor:pointer;text-align:left;transition:all .15s;display:flex;align-items:flex-start;gap:12px;}
.mc-opt:hover:not(:disabled){border-color:var(--accent2);background:var(--surface3);}
.mc-opt.cor{border-color:var(--teal)!important;background:var(--teal-glow)!important;color:var(--teal)!important;}
.mc-opt.wrg{border-color:var(--red)!important;background:var(--red-glow)!important;color:var(--red)!important;}
.mc-opt:disabled{cursor:default;}
.opt-letter{width:26px;height:26px;border-radius:7px;border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text2);flex-shrink:0;margin-top:1px;}
.mc-opt.cor .opt-letter{border-color:var(--teal);color:var(--teal);background:rgba(52,211,153,.15);}
.mc-opt.wrg .opt-letter{border-color:var(--red);color:var(--red);background:rgba(248,113,113,.15);}
.tf-grid{display:flex;gap:12px;justify-content:center;}
.tf-opt{flex:1;max-width:200px;padding:22px;border-radius:12px;border:1.5px solid var(--border);background:var(--surface2);font-family:'Sora',sans-serif;font-size:15px;font-weight:700;cursor:pointer;transition:all .15s;text-align:center;}
.tf-opt:hover:not(:disabled){border-color:var(--accent2);background:var(--surface3);}
.tf-opt.cor{border-color:var(--teal)!important;background:var(--teal-glow)!important;color:var(--teal)!important;}
.tf-opt.wrg{border-color:var(--red)!important;background:var(--red-glow)!important;color:var(--red)!important;}
.tf-opt:disabled{cursor:default;}
.written-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;}
.written-input{width:100%;max-width:500px;padding:14px 18px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg);color:var(--text);font-family:'Sora',sans-serif;font-size:14px;outline:none;transition:border-color .15s;text-align:center;}
.written-input:focus{border-color:var(--accent2);box-shadow:0 0 0 3px var(--accent-glow);}
.written-input.cor{border-color:var(--teal);color:var(--teal);}
.written-input.wrg{border-color:var(--red);color:var(--red);}
.feedback-bar{display:flex;align-items:flex-start;gap:10px;padding:14px 18px;border-radius:11px;border:1px solid;font-size:13px;font-weight:500;max-width:540px;width:100%;line-height:1.6;}
.feedback-bar.cor{background:rgba(52,211,153,.07);border-color:var(--teal);color:var(--teal);}
.feedback-bar.wrg{background:var(--red-glow);border-color:var(--red);color:var(--red);}
.round-end{text-align:center;padding:52px 24px;background:linear-gradient(135deg,var(--surface),var(--surface2));border:1px solid var(--border);border-radius:20px;}
.round-score{font-size:72px;font-weight:800;line-height:1;margin-bottom:6px;}
.round-label{font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--text2);margin-bottom:24px;}
.round-breakdown{display:flex;gap:24px;justify-content:center;margin-bottom:32px;flex-wrap:wrap;}
.breakdown-val{font-size:28px;font-weight:800;}
.breakdown-lbl{font-size:10px;color:var(--text2);letter-spacing:1px;text-transform:uppercase;margin-top:2px;}

/* ── TERMS LIST ── */
.terms-title{font-size:13px;font-weight:700;color:var(--text2);letter-spacing:.5px;text-transform:uppercase;margin-bottom:12px;}
.terms-list{display:flex;flex-direction:column;gap:5px;}
.term-row{display:flex;align-items:stretch;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;transition:border-color .15s;}
.term-row:hover{border-color:var(--border2);}
.term-col{padding:13px 16px;flex:0 0 190px;font-weight:600;color:#fff;font-size:13px;border-right:1px solid var(--border);}
.def-col{padding:13px 16px;flex:1;color:var(--text2);font-size:13px;line-height:1.6;}
.term-badge{padding:2px 8px;border-radius:99px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid;align-self:center;margin-right:10px;white-space:nowrap;flex-shrink:0;}
.term-badge.mastered{color:var(--teal);border-color:var(--teal);background:var(--teal-glow);}
.term-badge.weak{color:var(--red);border-color:var(--red);background:var(--red-glow);}
.term-badge.learning{color:var(--accent2);border-color:var(--accent2);background:var(--accent-light);}

/* ── TEST ── */
.test-q{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:12px;}
.test-q-num{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text3);margin-bottom:8px;}
.test-q-term{font-size:19px;font-weight:700;color:#fff;margin-bottom:14px;line-height:1.3;}

/* ── MANAGE ── */
.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:14px;}
.panel-title{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--text2);margin-bottom:14px;}
textarea.import-ta{width:100%;height:200px;background:var(--bg);border:1.5px solid var(--border);border-radius:9px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:12px;padding:12px;resize:vertical;outline:none;transition:border-color .15s;line-height:1.7;}
textarea.import-ta:focus{border-color:var(--accent2);}
.fmt-hint{font-size:11px;color:var(--text2);margin-top:8px;}
.fmt-hint code{color:var(--violet);background:rgba(192,132,252,.1);padding:1px 6px;border-radius:4px;font-family:'JetBrains Mono',monospace;}
.btn-row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;}

/* ── EXAM ── */
.exam-ta{width:100%;max-width:560px;min-height:110px;background:var(--bg);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-family:'Sora',sans-serif;font-size:14px;padding:14px;resize:vertical;outline:none;transition:border-color .15s;line-height:1.7;}
.exam-ta:focus{border-color:var(--accent2);}
.model-ans{background:var(--surface2);border:1.5px solid var(--teal);border-radius:13px;padding:18px 20px;margin-top:14px;max-width:560px;width:100%;}
.model-ans-lbl{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--teal);margin-bottom:8px;}
.model-ans-text{font-size:14px;color:var(--text);line-height:1.8;}
.self-grade{display:flex;gap:10px;margin-top:14px;justify-content:center;flex-wrap:wrap;align-items:center;}

/* ── MISC ── */
.main{max-width:900px;margin:0 auto;padding:28px 20px 80px;}
.tabs{display:flex;padding:0 24px;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;}
.tab{padding:13px 20px;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;white-space:nowrap;transition:color .15s,border-color .15s;font-family:'Sora',sans-serif;}
.tab:hover{color:var(--text);}
.tab.active{color:#fff;border-bottom-color:var(--accent2);}
@keyframes confettiFall{0%{transform:translateY(-10px) rotate(0deg);opacity:1;}100%{transform:translateY(140px) rotate(720deg);opacity:0;}}
.confetti{position:fixed;animation:confettiFall .9s ease-out forwards;pointer-events:none;z-index:9999;}
.empty-state{text-align:center;padding:60px 20px;color:var(--text2);}
.empty-icon{font-size:52px;margin-bottom:16px;opacity:.4;}
.empty-title{font-size:22px;font-weight:700;color:var(--text);margin-bottom:8px;}
.divider{height:1px;background:var(--border);margin:22px 0;}
.loading{display:flex;align-items:center;justify-content:center;height:100vh;color:var(--text2);font-size:14px;gap:10px;}
.spinner{width:20px;height:20px;border:2px solid var(--border2);border-top-color:var(--accent2);border-radius:50%;animation:spin .7s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
.fade-up{animation:fadeUp .28s ease both;}
@keyframes popIn{0%{transform:scale(.94);opacity:0;}100%{transform:scale(1);opacity:1;}}
.pop-in{animation:popIn .22s ease both;}
@keyframes slideIn{from{opacity:0;transform:translateX(24px);}to{opacity:1;transform:translateX(0);}}
.slide-in{animation:slideIn .3s ease both;}
/* ── QUARTER SYSTEM ── */
.quarter-overview{margin-bottom:28px;}
.quarter-overview-title{font-size:13px;font-weight:700;color:var(--text2);letter-spacing:.5px;text-transform:uppercase;margin-bottom:12px;}
.quarters-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px;}
.quarter-card{background:var(--surface);border:1.5px solid var(--border);border-radius:13px;padding:16px 12px;text-align:center;cursor:pointer;transition:all .2s;position:relative;}
.quarter-card:hover{border-color:var(--border2);transform:translateY(-2px);}
.quarter-card.active{border-color:var(--accent2);background:var(--accent-light);}
.quarter-card.unlocked{cursor:pointer;}
.quarter-card.locked{opacity:.45;cursor:default;}
.quarter-card.completed{border-color:var(--teal);background:var(--teal-glow);}
.quarter-num{font-size:22px;font-weight:800;color:#fff;margin-bottom:4px;}
.quarter-range{font-size:10px;color:var(--text2);margin-bottom:8px;}
.quarter-status{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;border-radius:99px;border:1px solid;display:inline-block;}
.quarter-status.done{color:var(--teal);border-color:var(--teal);}
.quarter-status.ready{color:var(--accent2);border-color:var(--accent2);}
.quarter-status.locked{color:var(--text3);border-color:var(--text3);}
.quarter-status.current{color:var(--yellow);border-color:var(--yellow);}
.flash-mode-bar{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:20px;flex-wrap:wrap;}
.flash-mode-label{font-size:12px;color:var(--text2);font-weight:600;flex:1;}
.flash-phase-chip{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:4px 12px;border-radius:99px;border:1px solid;}
.flash-phase-chip.browse{color:var(--violet);border-color:var(--violet);background:rgba(192,132,252,.1);}
.flash-phase-chip.test{color:var(--yellow);border-color:var(--yellow);background:rgba(251,191,36,.1);}
.quarter-test-wrap{max-width:660px;margin:0 auto;}
.qt-card{background:linear-gradient(135deg,var(--surface),var(--surface2));border:1px solid var(--border);border-radius:18px;padding:32px;margin-bottom:20px;text-align:center;}
.qt-term{font-size:clamp(18px,3vw,26px);font-weight:700;color:#fff;margin-bottom:8px;line-height:1.3;}
.qt-instruction{font-size:12px;color:var(--text2);margin-bottom:20px;}
.qt-input{width:100%;padding:14px 18px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg);color:var(--text);font-family:'Sora',sans-serif;font-size:14px;outline:none;transition:border-color .15s;line-height:1.7;resize:vertical;min-height:90px;}
.qt-input:focus{border-color:var(--accent2);box-shadow:0 0 0 3px var(--accent-glow);}
.qt-input.correct{border-color:var(--teal);color:var(--teal);}
.qt-input.wrong{border-color:var(--red);}
.qt-model{background:var(--surface2);border:1.5px solid var(--border2);border-radius:11px;padding:16px 18px;margin-top:12px;text-align:left;}
.qt-model-lbl{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--teal);margin-bottom:6px;}
.qt-model-text{font-size:13px;color:var(--text);line-height:1.7;}
.qt-ai-note{font-size:11px;color:var(--text2);margin-top:8px;font-style:italic;}
.qt-actions{display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap;}
.qt-result-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:10px;border:1px solid;font-size:13px;font-weight:500;margin-top:12px;}
.qt-result-bar.correct{background:rgba(52,211,153,.07);border-color:var(--teal);color:var(--teal);}
.qt-result-bar.wrong{background:var(--red-glow);border-color:var(--red);color:var(--red);}
.qt-result-bar.similar{background:rgba(251,191,36,.08);border-color:var(--yellow);color:var(--yellow);}
.qt-summary{text-align:center;padding:44px 24px;background:linear-gradient(135deg,var(--surface),var(--surface2));border:1px solid var(--border);border-radius:20px;}
.qt-summary-score{font-size:64px;font-weight:800;line-height:1;margin-bottom:6px;}
.qt-summary-label{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--text2);margin-bottom:20px;}
.qt-summary-breakdown{display:flex;gap:20px;justify-content:center;margin-bottom:24px;flex-wrap:wrap;}
.ai-checking{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2);padding:10px 0;}
@media(max-width:600px){
  .stats{grid-template-columns:repeat(2,1fr);}
  .sets-grid{grid-template-columns:1fr;}
  .topbar{padding:10px 14px;}
  .main,.library{padding:18px 14px 60px;}
  .tabs{padding:0 12px;}
  .tab{padding:11px 13px;font-size:11px;}
  :root{--card-h:260px;}
  .card-face{padding:22px 16px;}
  .term-col{flex:0 0 100px;font-size:12px;}
  .tf-grid{flex-direction:column;align-items:center;}
  .tf-opt{max-width:100%;}
  .section-banner{flex-direction:column;gap:8px;}
  .auth-card{padding:28px 20px;}
  .anki-ratings{grid-template-columns:repeat(2,1fr);}
  .quarters-grid{grid-template-columns:repeat(2,1fr);}
}

/* ── ANKI TAB ── */
.anki-wrap{max-width:760px;margin:0 auto;}
.anki-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px;}
.anki-stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;transition:border-color .2s;}
.anki-stat:hover{border-color:var(--border2);}
.anki-stat-val{font-size:28px;font-weight:800;line-height:1;margin-bottom:4px;}
.anki-stat-lbl{font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);}
.anki-card-area{perspective:1400px;margin-bottom:20px;cursor:pointer;}
.anki-card-wrap{width:100%;height:var(--card-h);position:relative;transform-style:preserve-3d;transition:transform .55s cubic-bezier(.4,0,.2,1);}
.anki-card-wrap.flipped{transform:rotateY(180deg);}
.anki-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:18px;border:1px solid var(--border);background:linear-gradient(135deg,var(--surface),var(--surface2));display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.5);}
.anki-face-back{transform:rotateY(180deg);background:linear-gradient(135deg,var(--surface2),var(--surface3));border-color:var(--border2);}
.anki-chip{position:absolute;top:20px;left:20px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text3);padding:4px 10px;border:1px solid var(--border);border-radius:99px;}
.anki-state-chip{position:absolute;top:20px;right:20px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:4px 10px;border-radius:99px;border:1px solid;}
.anki-state-chip.new{color:var(--accent2);border-color:var(--accent2);background:var(--accent-light);}
.anki-state-chip.learning{color:var(--yellow);border-color:var(--yellow);background:rgba(251,191,36,.1);}
.anki-state-chip.review{color:var(--teal);border-color:var(--teal);background:var(--teal-glow);}
.anki-term{font-size:clamp(22px,4vw,38px);font-weight:700;color:#fff;line-height:1.25;}
.anki-def{font-size:clamp(13px,2vw,16px);color:var(--text);line-height:1.8;max-width:580px;}
.anki-hint{position:absolute;bottom:20px;font-size:11px;color:var(--text3);letter-spacing:.5px;}
.anki-nav{display:flex;justify-content:center;margin-bottom:16px;}
.anki-ratings{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;}
.anki-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:14px 10px;border-radius:13px;border:1.5px solid;font-family:'Sora',sans-serif;cursor:pointer;transition:all .18s;background:transparent;}
.anki-btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.3);}
.anki-btn-interval{font-size:12px;font-weight:800;letter-spacing:.5px;}
.anki-btn-label{font-size:11px;font-weight:600;opacity:.85;}
.anki-btn.again{border-color:var(--red);color:var(--red);}
.anki-btn.again:hover{background:var(--red-glow);}
.anki-btn.hard{border-color:var(--yellow);color:var(--yellow);}
.anki-btn.hard:hover{background:rgba(251,191,36,.1);}
.anki-btn.good{border-color:var(--accent2);color:var(--accent2);}
.anki-btn.good:hover{background:var(--accent-light);}
.anki-btn.easy{border-color:var(--teal);color:var(--teal);}
.anki-btn.easy:hover{background:var(--teal-glow);}
.anki-meta{text-align:center;font-size:11px;color:var(--text3);margin-top:4px;}
.anki-done{text-align:center;padding:52px 24px;background:linear-gradient(135deg,var(--surface),var(--surface2));border:1px solid var(--border);border-radius:20px;}
.anki-done-icon{font-size:64px;margin-bottom:12px;}
.anki-done-title{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px;}
.anki-done-sub{font-size:13px;color:var(--text2);line-height:1.8;margin-bottom:24px;}
.anki-session-row{display:flex;gap:20px;justify-content:center;margin-bottom:28px;flex-wrap:wrap;}
.anki-session-val{font-size:26px;font-weight:800;}
.anki-session-lbl{font-size:10px;color:var(--text2);letter-spacing:1px;text-transform:uppercase;margin-top:2px;}
.anki-count-val{font-size:22px;font-weight:800;line-height:1;}
}
`;

// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [mode,     setMode]     = useState("login"); // "login" | "signup"
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [success,  setSuccess]  = useState("");

  const submit = async () => {
    setError(""); setSuccess(""); setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setSuccess("Account created! Check your email to confirm, then log in.");
        setMode("login");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onAuth(data.user);
      }
    } catch (e) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card fade-up">
        <div className="auth-logo">flash<em>deck</em></div>
        <div className="auth-tagline">Study smarter. Your sets, everywhere.</div>
        <div className="auth-tabs">
          <button className={`auth-tab${mode==="login"?" active":""}`} onClick={()=>{setMode("login");setError("");setSuccess("");}}>Log In</button>
          <button className={`auth-tab${mode==="signup"?" active":""}`} onClick={()=>{setMode("signup");setError("");setSuccess("");}}>Sign Up</button>
        </div>
        {error   && <div className="auth-error">⚠ {error}</div>}
        {success && <div className="auth-success">✓ {success}</div>}
        <div className="auth-field">
          <label>Email</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"
            onKeyDown={e=>e.key==="Enter"&&submit()} autoFocus />
        </div>
        <div className="auth-field">
          <label>Password</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••"
            onKeyDown={e=>e.key==="Enter"&&submit()} />
        </div>
        <button className="btn btn-primary btn-full" disabled={loading||!email||!password} onClick={submit}>
          {loading ? "Please wait…" : mode==="login" ? "Log In →" : "Create Account →"}
        </button>
        {mode==="signup" && <div className="auth-footer">Your friend can sign up too — everyone gets their own sets and progress.</div>}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [session,      setSession]      = useState(undefined); // undefined = loading
  const [sets,         setSets]         = useState([]);
  const [activeSetId,  setActiveSetId]  = useState(null);
  const [progress,     setProgress]     = useState({});
  const [streak,       setStreak]       = useState(0);
  const [soundOn,      setSoundOn]      = useState(true);
  const [syncStatus,   setSyncStatus]   = useState("ok"); // "ok"|"syncing"|"err"
  const [showNewModal, setShowNewModal] = useState(false);
  const [editingSet,   setEditingSet]   = useState(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  const playSound = useCallback((t) => { if (soundOn) sound.play(t); }, [soundOn]);

  // ── Auth listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // ── Close user menu on outside click ──────────────────────────────────────
  useEffect(() => {
    if (!userMenuOpen) return;
    const h = (e) => { if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [userMenuOpen]);

  // ── Load sets when logged in ───────────────────────────────────────────────
  useEffect(() => {
    if (!session?.user) return;
    loadSets();
  }, [session?.user?.id]);

  const loadSets = async () => {
    const { data, error } = await supabase.from("sets").select("*").order("created_at");
    if (!error) setSets(data || []);
  };

  // ── Load progress for active set ──────────────────────────────────────────
  useEffect(() => {
    if (!session?.user || !activeSetId) return;
    loadProgress(activeSetId);
  }, [activeSetId, session?.user?.id]);

  const loadProgress = async (setId) => {
    const { data } = await supabase.from("progress").select("*").eq("set_id", setId).eq("user_id", session.user.id);
    if (data) {
      const map = {};
      data.forEach(r => { map[r.card_id] = { correctStreak: r.correct_streak, totalCorrect: r.total_correct, totalIncorrect: r.total_incorrect, mastered: r.mastered, lastSeen: r.last_seen }; });
      setProgress(map);
    }
    const { data: sd } = await supabase.from("streaks").select("value").eq("set_id", setId).eq("user_id", session.user.id).maybeSingle();
    setStreak(sd?.value || 0);
  };

  // ── Save progress (upsert per card) ───────────────────────────────────────
  const saveProgress = useCallback(async (p, newStreak) => {
    setProgress(p);
    setSyncStatus("syncing");
    try {
      const rows = Object.entries(p).map(([cardId, v]) => ({
        user_id: session.user.id, set_id: activeSetId, card_id: parseInt(cardId),
        correct_streak: v.correctStreak||0, total_correct: v.totalCorrect||0,
        total_incorrect: v.totalIncorrect||0, mastered: v.mastered||false,
        last_seen: v.lastSeen ? new Date(v.lastSeen).toISOString() : null,
      }));
      const { error } = await supabase.from("progress").upsert(rows, { onConflict: "user_id,set_id,card_id" });
      if (error) throw error;
      if (newStreak !== undefined) {
        setStreak(newStreak);
        await supabase.from("streaks").upsert({ user_id: session.user.id, set_id: activeSetId, value: newStreak }, { onConflict: "user_id,set_id" });
      }
      setSyncStatus("ok");
    } catch { setSyncStatus("err"); }
  }, [session?.user?.id, activeSetId]);

  // ── Set CRUD ───────────────────────────────────────────────────────────────
  const createSet = async ({ name, emoji, color }) => {
    const ns = { id: uid(), user_id: session.user.id, name, emoji, color, raw: SAMPLE_RAW, created_at: new Date().toISOString() };
    const { error } = await supabase.from("sets").insert(ns);
    if (!error) { setSets(s => [...s, ns]); setShowNewModal(false); setActiveSetId(ns.id); }
  };

  const updateSet = async (id, changes) => {
    await supabase.from("sets").update(changes).eq("id", id);
    setSets(s => s.map(x => x.id===id ? {...x,...changes} : x));
    setEditingSet(null);
  };

  const deleteSet = async (id) => {
    if (!confirm("Delete this set and all its progress?")) return;
    await supabase.from("sets").delete().eq("id", id);
    setSets(s => s.filter(x => x.id!==id));
    if (activeSetId===id) setActiveSetId(null);
  };

  const updateSetRaw = async (id, raw) => {
    await supabase.from("sets").update({ raw }).eq("id", id);
    setSets(s => s.map(x => x.id===id ? {...x, raw} : x));
  };

  const resetSetProgress = async (id) => {
    await supabase.from("progress").delete().eq("set_id", id).eq("user_id", session.user.id);
    await supabase.from("streaks").delete().eq("set_id", id).eq("user_id", session.user.id);
    if (activeSetId===id) { setProgress({}); setStreak(0); }
  };

  const signOut = () => supabase.auth.signOut();

  // ── Loading / auth gates ───────────────────────────────────────────────────
  if (session === undefined) return <><style>{css}</style><div className="loading"><div className="spinner"/><span>Loading…</span></div></>;
  if (!session) return <><style>{css}</style><AuthScreen onAuth={() => {}} /></>;

  const user = session.user;
  const activeSet = sets.find(s => s.id === activeSetId) || null;
  const cards  = activeSet ? parseCards(activeSet.raw) : [];
  const mastered = cards.filter(c => progress[c.id]?.mastered).length;
  const weak     = cards.filter(c => (progress[c.id]?.totalIncorrect||0) > (progress[c.id]?.correctStreak||0)).length;
  const initials = user.email?.[0]?.toUpperCase() || "?";

  // ── Topbar (shared) ───────────────────────────────────────────────────────
  const Topbar = ({ children }) => (
    <div className="topbar">
      {children}
      <div className="topbar-right">
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <div className={`sync-dot ${syncStatus}`} title={syncStatus==="ok"?"Saved":"Saving…"}/>
          <span style={{fontSize:10,color:"var(--text3)"}}>{syncStatus==="syncing"?"Saving…":syncStatus==="err"?"Error":"Saved"}</span>
        </div>
        <button className={`sound-btn${soundOn?" on":""}`} onClick={()=>setSoundOn(s=>!s)}>{soundOn?"🔊":"🔇"}</button>
        <div className="user-menu-wrap" ref={userMenuRef}>
          <button className="avatar-btn" onClick={()=>setUserMenuOpen(o=>!o)}>{initials}</button>
          {userMenuOpen && (
            <div className="user-menu">
              <div className="user-menu-email">{user.email}</div>
              <button onClick={()=>{setUserMenuOpen(false);setActiveSetId(null);}}>📚 My Sets</button>
              <button className="danger" onClick={signOut}>Sign Out</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ── Library view ──────────────────────────────────────────────────────────
  if (!activeSetId) return (
    <>
      <style>{css}</style>
      <div className="app">
        <Topbar>
          <div className="logo">flash<em>deck</em></div>
          <div style={{flex:1}}/>
        </Topbar>
        <div className="library fade-up">
          <div className="library-header">
            <div>
              <div className="library-title">Your <span>Sets</span></div>
              <div style={{color:"var(--text2)",fontSize:13,marginTop:4}}>{sets.length} set{sets.length!==1?"s":""} · synced across all your devices</div>
            </div>
            <button className="btn btn-primary" onClick={()=>setShowNewModal(true)}>+ New Set</button>
          </div>
          <div className="sets-grid">
            {sets.map(s => (
              <SetCard key={s.id} set={s} userId={user.id}
                onOpen={()=>{ setActiveSetId(s.id); playSound("nav"); }}
                onEdit={()=>setEditingSet(s)} onDelete={()=>deleteSet(s.id)} />
            ))}
            <div className="set-card set-card-new" onClick={()=>setShowNewModal(true)}>
              <div className="plus">＋</div>
              <div style={{fontSize:13,fontWeight:600}}>Create new set</div>
            </div>
          </div>
        </div>
        {showNewModal && <SetModal title="Create New Set" onSave={createSet} onClose={()=>setShowNewModal(false)} />}
        {editingSet   && <SetModal title="Edit Set" initial={editingSet} onSave={c=>updateSet(editingSet.id,c)} onClose={()=>setEditingSet(null)} />}
      </div>
    </>
  );

  // ── Study view ────────────────────────────────────────────────────────────
  return (
    <>
      <style>{css}</style>
      <div className="app">
        <Topbar>
          <button className="topbar-back" onClick={()=>setActiveSetId(null)}>← Sets</button>
          <div className="topbar-set-info">
            <span className="topbar-set-emoji">{activeSet.emoji}</span>
            <span className="topbar-set-name">{activeSet.name}</span>
          </div>
        </Topbar>
        <StudyView
          set={activeSet} cards={cards} progress={progress} streak={streak}
          playSound={playSound} mastered={mastered} weak={weak}
          saveProgress={saveProgress} session={session}
          onUpdateRaw={r=>updateSetRaw(activeSetId,r)}
          onResetProgress={()=>resetSetProgress(activeSetId)}
          onRenameSet={()=>setEditingSet(activeSet)}
        />
        {editingSet && <SetModal title="Edit Set" initial={editingSet} onSave={c=>updateSet(editingSet.id,c)} onClose={()=>setEditingSet(null)} />}
      </div>
    </>
  );
}

// ─── Set Card ─────────────────────────────────────────────────────────────────
function SetCard({ set, userId, onOpen, onEdit, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [progData, setProgData] = useState({ mastered:0, total:0 });
  const menuRef = useRef(null);

  useEffect(() => {
    supabase.from("progress").select("mastered", { count:"exact" }).eq("set_id",set.id).eq("user_id",userId).then(({ data }) => {
      const cards = parseCards(set.raw||"");
      const m = (data||[]).filter(r=>r.mastered).length;
      setProgData({ mastered:m, total:cards.length });
    });
  }, [set.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const pct = progData.total ? Math.round((progData.mastered/progData.total)*100) : 0;

  return (
    <div className="set-card" onClick={onOpen}>
      <div className="set-card-top">
        <div className="set-emoji-wrap" style={{background:`${set.color}22`}}>{set.emoji||"📚"}</div>
        <div style={{position:"relative"}} ref={menuRef} onClick={e=>e.stopPropagation()}>
          <button className="set-menu-btn" onClick={e=>{e.stopPropagation();setMenuOpen(o=>!o);}}>⋯</button>
          {menuOpen && (
            <div className="set-dropdown">
              <button onClick={()=>{onEdit();setMenuOpen(false);}}>✏️ Rename / Edit</button>
              <div className="sep"/>
              <button className="danger" onClick={()=>{onDelete();setMenuOpen(false);}}>🗑️ Delete set</button>
            </div>
          )}
        </div>
      </div>
      <div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:4}}>{set.name}</div>
      <div style={{fontSize:11,color:"var(--text2)"}}>{progData.total} cards · {progData.mastered} mastered</div>
      {progData.total>0 && <>
        <div className="set-mini-bar" style={{marginTop:12}}><div className="set-mini-fill" style={{width:`${pct}%`,background:set.color||"var(--accent)"}}/></div>
        <div className="set-mini-labels"><span>{pct}% mastered</span><span>{progData.total-progData.mastered} left</span></div>
      </>}
    </div>
  );
}

// ─── Set Modal ────────────────────────────────────────────────────────────────
function SetModal({ title, initial, onSave, onClose }) {
  const [name,  setName]  = useState(initial?.name  || "");
  const [emoji, setEmoji] = useState(initial?.emoji || SET_EMOJIS[0]);
  const [color, setColor] = useState(initial?.color || SET_COLORS[0]);
  const save = () => { if (!name.trim()) return; onSave({ name:name.trim(), emoji, color }); };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal fade-up" onClick={e=>e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <label className="modal-label">Set name</label>
        <input type="text" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Biology Chapter 3" onKeyDown={e=>e.key==="Enter"&&save()} autoFocus />
        <label className="modal-label">Icon</label>
        <div className="emoji-grid">{SET_EMOJIS.map(em=><button key={em} className={`emoji-opt${emoji===em?" sel":""}`} onClick={()=>setEmoji(em)}>{em}</button>)}</div>
        <label className="modal-label">Colour</label>
        <div className="color-grid">{SET_COLORS.map(c=><div key={c} className={`color-opt${color===c?" sel":""}`} style={{background:c}} onClick={()=>setColor(c)}/>)}</div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={save}>{initial?"Save Changes":"Create Set"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Study View ───────────────────────────────────────────────────────────────
const STUDY_TABS = ["Flashcards","Learn","Anki","Exam","Test","Manage"];
function StudyView({ set, cards, progress, streak, playSound, mastered, weak, saveProgress, onUpdateRaw, onResetProgress, onRenameSet, session }) {
  const [tab, setTab] = useState("Learn");
  return (
    <>
      <div className="tabs">{STUDY_TABS.map(t=><button key={t} className={`tab${tab===t?" active":""}`} onClick={()=>{setTab(t);playSound("nav");}}>{t}</button>)}</div>
      <div className="main">
        <div className="stats">
          <div className="stat-card"><div className="stat-val" style={{color:"#fff"}}>{cards.length}</div><div className="stat-lbl">Total</div></div>
          <div className="stat-card"><div className="stat-val" style={{color:"var(--teal)"}}>{mastered}</div><div className="stat-lbl">Mastered</div></div>
          <div className="stat-card"><div className="stat-val" style={{color:"var(--red)"}}>{weak}</div><div className="stat-lbl">Weak</div></div>
          <div className="stat-card"><div className="stat-val" style={{color:"var(--yellow)"}}>{streak}</div><div className="stat-lbl">Streak</div></div>
        </div>
        {tab==="Flashcards" && <FlashTab cards={cards} progress={progress} playSound={playSound} />}
        {tab==="Learn"      && <LearnTab cards={cards} progress={progress} saveProgress={saveProgress} streak={streak} playSound={playSound} />}
        {tab==="Anki"       && <AnkiTab  cards={cards} userId={session?.user?.id} setId={set?.id} playSound={playSound} />}
        {tab==="Exam"       && <ExamTab  cards={cards} progress={progress} saveProgress={saveProgress} streak={streak} playSound={playSound} />}
        {tab==="Test"       && <TestTab  cards={cards} playSound={playSound} />}
        {tab==="Manage"     && <ManageTab set={set} cards={cards} progress={progress} onUpdateRaw={onUpdateRaw} onResetProgress={onResetProgress} onRenameSet={onRenameSet} />}
      </div>
    </>
  );
}

// ─── Flash Tab — Quarter System ───────────────────────────────────────────────
// Splits cards into 4 equal quarters. Browse quarter → write test → unlock next.
// Cumulative tests: Q2 test includes Q1+Q2 cards, Q3 includes Q1+Q2+Q3, etc.
// AI semantic checking: Claude judges meaning-equivalence when answer isn't exact match.

const PASS_THRESHOLD = 0.7; // 70% to pass a quarter test

function getQuarters(cards) {
  const total = cards.length;
  const base  = Math.floor(total / 4);
  const rem   = total % 4;
  const quarters = [];
  let start = 0;
  for (let i = 0; i < 4; i++) {
    const size = base + (i < rem ? 1 : 0);
    quarters.push(cards.slice(start, start + size));
    start += size;
  }
  return quarters.filter(q => q.length > 0);
}

async function checkWithAI(term, definition, userAnswer) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 120,
        system: "You are a strict but fair revision assistant. Judge if a student's answer conveys the same core meaning as the model answer. Reply with ONLY valid JSON: {\"verdict\": \"correct\" | \"similar\" | \"wrong\", \"reason\": \"one short sentence\"}. 'correct' = essentially the same meaning. 'similar' = captures main idea but missing key detail. 'wrong' = incorrect or too vague.",
        messages: [{ role: "user", content: `Term: ${term}\nModel answer: ${definition}\nStudent answer: ${userAnswer}` }],
      }),
    });
    const data = await res.json();
    const text = data.content?.map(b => b.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { verdict: "similar", reason: "Could not check automatically — you decide." };
  }
}

function FlashTab({ cards, progress, playSound }) {
  // mode: "overview" | "browse" | "test"
  const [mode,          setMode]          = useState("overview");
  const [activeQuarter, setActiveQuarter] = useState(0);
  // Per-quarter pass state stored in component (resets on tab change, persists in session)
  const [quartersPassed, setQuartersPassed] = useState({}); // {0: true, 1: true, ...}

  // Browse state
  const [browseIdx,  setBrowseIdx]  = useState(0);
  const [flipped,    setFlipped]    = useState(false);

  // Test state
  const [testCards,   setTestCards]   = useState([]);
  const [testIdx,     setTestIdx]     = useState(0);
  const [answer,      setAnswer]      = useState("");
  const [revealed,    setRevealed]    = useState(false);
  const [aiResult,    setAiResult]    = useState(null); // {verdict, reason}
  const [aiChecking,  setAiChecking]  = useState(false);
  const [testResults, setTestResults] = useState([]); // array of {card, correct}
  const [testDone,    setTestDone]    = useState(false);
  const taRef = useRef(null);

  useEffect(() => { setMode("overview"); }, [cards]);

  if (!cards.length) return <Empty msg="Add cards in the Manage tab." />;

  const quarters = getQuarters(cards);

  // ── Overview ──────────────────────────────────────────────────────────────
  if (mode === "overview") {
    const totalPassed = Object.keys(quartersPassed).length;
    return (
      <div>
        <div className="quarter-overview">
          <div className="quarter-overview-title">
            {totalPassed === quarters.length ? "🎉 All quarters complete!" : `Study Plan — ${cards.length} cards in ${quarters.length} quarters`}
          </div>
          <div className="quarters-grid">
            {quarters.map((q, i) => {
              const passed   = quartersPassed[i];
              const unlocked = i === 0 || quartersPassed[i - 1];
              const isCurrent = !passed && unlocked;
              return (
                <div
                  key={i}
                  className={`quarter-card ${passed?"completed":isCurrent?"active":"locked"}`}
                  onClick={() => {
                    if (!unlocked && !passed) return;
                    setActiveQuarter(i);
                    setBrowseIdx(0); setFlipped(false);
                    setMode("browse");
                    playSound("nav");
                  }}
                >
                  <div className="quarter-num">Q{i + 1}</div>
                  <div className="quarter-range">Cards {cards.indexOf(q[0])+1}–{cards.indexOf(q[q.length-1])+1}</div>
                  <div className="quarter-range" style={{marginBottom:8}}>{q.length} cards</div>
                  <div className={`quarter-status ${passed?"done":isCurrent?"current":"locked"}`}>
                    {passed ? "✓ Passed" : isCurrent ? "Current" : "🔒 Locked"}
                  </div>
                </div>
              );
            })}
          </div>
          {totalPassed === quarters.length && (
            <div style={{textAlign:"center",padding:"20px 0"}}>
              <p style={{color:"var(--text2)",fontSize:13,marginBottom:16}}>You've been through all quarters! You can revisit any quarter or do a full set test.</p>
              <button className="btn btn-primary" onClick={() => {
                setTestCards(shuffle([...cards]));
                setTestIdx(0); setAnswer(""); setRevealed(false);
                setAiResult(null); setTestResults([]); setTestDone(false);
                setActiveQuarter(quarters.length - 1);
                setMode("test"); playSound("nav");
              }}>Test All {cards.length} Cards →</button>
            </div>
          )}
        </div>
        <div className="divider"/>
        <div className="terms-title">All terms in this set</div>
        <TermsList cards={cards} progress={progress} />
      </div>
    );
  }

  // ── Browse mode ───────────────────────────────────────────────────────────
  if (mode === "browse") {
    const qCards = quarters[activeQuarter];
    const card   = qCards[browseIdx];
    const pct    = Math.round(((browseIdx + 1) / qCards.length) * 100);
    const isLast = browseIdx === qCards.length - 1;

    const go = (d) => {
      playSound("nav"); setFlipped(false);
      setTimeout(() => setBrowseIdx(i => Math.max(0, Math.min(qCards.length - 1, i + d))), flipped ? 120 : 0);
    };

    const startTest = () => {
      // Cumulative: test all cards up to and including this quarter
      const cumulativeCards = quarters.slice(0, activeQuarter + 1).flat();
      setTestCards(shuffle([...cumulativeCards]));
      setTestIdx(0); setAnswer(""); setRevealed(false);
      setAiResult(null); setTestResults([]); setTestDone(false);
      setMode("test"); playSound("nav");
    };

    return (
      <div>
        <div className="flash-mode-bar">
          <button className="btn btn-ghost btn-sm" onClick={() => setMode("overview")}>← Overview</button>
          <span className="flash-mode-label">Quarter {activeQuarter + 1} of {quarters.length} — Browsing</span>
          <span className="flash-phase-chip browse">Browse</span>
        </div>

        {progress[card?.id]?.mastered && <div className="mastered-pill">✦ Mastered</div>}
        <div className="prog-wrap">
          <div className="prog-header">
            <span className="prog-label">Card {browseIdx + 1} of {qCards.length}</span>
            <span className="prog-count">{pct}%</span>
          </div>
          <div className="prog-track">
            <div className="prog-bar" style={{width:`${pct}%`}}/>
            <div className="prog-thumb" style={{left:`${Math.max(Math.min(pct,96),2)}%`}}>{browseIdx + 1}</div>
          </div>
        </div>

        <div className="card-area fade-up">
          <div className={`card-wrap${flipped?" flipped":""}`} onClick={() => { playSound("flip"); setFlipped(f=>!f); }}>
            <div className="card-face"><div className="card-chip">Term</div><div className="card-term">{card?.term}</div><div className="card-hint">click to flip</div></div>
            <div className="card-face card-back"><div className="card-chip">Definition</div><div className="card-def">{card?.def}</div></div>
          </div>
        </div>

        <div className="card-nav">
          <button className="btn btn-ghost" onClick={() => go(-1)} disabled={browseIdx === 0}>← Prev</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { playSound("flip"); setFlipped(f=>!f); }}>{flipped?"Show Term":"Show Answer"}</button>
          <button className="btn btn-ghost" onClick={() => go(1)} disabled={isLast}>Next →</button>
        </div>

        {isLast && (
          <div style={{marginTop:24,background:"linear-gradient(135deg,rgba(124,58,237,.18),rgba(159,103,255,.1))",border:"1px solid var(--border2)",borderRadius:16,padding:"24px",textAlign:"center"}}>
            <div style={{fontSize:20,marginBottom:8}}>✅ Quarter {activeQuarter + 1} browsed!</div>
            <p style={{color:"var(--text2)",fontSize:13,marginBottom:16,lineHeight:1.7}}>
              You've seen all {qCards.length} cards in this quarter.<br/>
              Time to test yourself — you'll be tested on{" "}
              <strong style={{color:"#fff"}}>
                {quarters.slice(0, activeQuarter + 1).flat().length} cards
              </strong>{activeQuarter > 0 ? " (cumulative)" : ""}.
            </p>
            <button className="btn btn-primary" onClick={startTest}>Test Myself Now →</button>
            <button className="btn btn-ghost" style={{marginLeft:8}} onClick={() => { setBrowseIdx(0); setFlipped(false); }}>Review Again</button>
          </div>
        )}
      </div>
    );
  }

  // ── Test mode ─────────────────────────────────────────────────────────────
  if (mode === "test") {
    const cumulativeCards = quarters.slice(0, activeQuarter + 1).flat();

    if (testDone) {
      const correct = testResults.filter(r => r.correct).length;
      const total   = testResults.length;
      const pct     = Math.round((correct / total) * 100);
      const passed  = pct >= PASS_THRESHOLD * 100;

      return (
        <div className="quarter-test-wrap fade-up">
          <div className="flash-mode-bar">
            <button className="btn btn-ghost btn-sm" onClick={() => setMode("overview")}>← Overview</button>
            <span className="flash-mode-label">Quarter {activeQuarter + 1} Test — Results</span>
          </div>
          <div className="qt-summary">
            <div className="qt-summary-score" style={{color:passed?"var(--teal)":pct>=50?"var(--yellow)":"var(--red)"}}>{pct}%</div>
            <div className="qt-summary-label">Quarter {activeQuarter + 1} Test Complete</div>
            <div className="qt-summary-breakdown">
              <div><div style={{fontSize:28,fontWeight:800,color:"var(--teal)"}}>{correct}</div><div style={{fontSize:10,color:"var(--text2)",letterSpacing:1,textTransform:"uppercase"}}>Correct</div></div>
              <div><div style={{fontSize:28,fontWeight:800,color:"var(--red)"}}>{total - correct}</div><div style={{fontSize:10,color:"var(--text2)",letterSpacing:1,textTransform:"uppercase"}}>Wrong</div></div>
              <div><div style={{fontSize:28,fontWeight:800,color:"var(--violet)"}}>{total}</div><div style={{fontSize:10,color:"var(--text2)",letterSpacing:1,textTransform:"uppercase"}}>Total</div></div>
            </div>
            {passed ? (
              <>
                <div style={{color:"var(--teal)",fontWeight:700,fontSize:15,marginBottom:12}}>✓ Passed! Quarter {activeQuarter + 1} complete.</div>
                {activeQuarter < quarters.length - 1 ? (
                  <button className="btn btn-primary" onClick={() => {
                    setQuartersPassed(p => ({...p, [activeQuarter]: true}));
                    setActiveQuarter(activeQuarter + 1);
                    setBrowseIdx(0); setFlipped(false);
                    setMode("browse"); playSound("mastered");
                    spawnConfetti(20);
                  }}>Continue to Quarter {activeQuarter + 2} →</button>
                ) : (
                  <button className="btn btn-primary" onClick={() => {
                    setQuartersPassed(p => ({...p, [activeQuarter]: true}));
                    setMode("overview"); playSound("mastered"); spawnConfetti(28);
                  }}>🎉 Complete! Back to Overview</button>
                )}
                <button className="btn btn-ghost" style={{marginLeft:8}} onClick={() => {
                  setTestCards(shuffle([...cumulativeCards]));
                  setTestIdx(0); setAnswer(""); setRevealed(false);
                  setAiResult(null); setTestResults([]); setTestDone(false);
                }}>Retry Test</button>
              </>
            ) : (
              <>
                <div style={{color:"var(--yellow)",fontWeight:600,fontSize:13,marginBottom:16}}>Need {Math.ceil(PASS_THRESHOLD*100)}% to pass. Review and try again!</div>
                <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
                  <button className="btn btn-primary" onClick={() => {
                    setTestCards(shuffle([...cumulativeCards]));
                    setTestIdx(0); setAnswer(""); setRevealed(false);
                    setAiResult(null); setTestResults([]); setTestDone(false);
                  }}>Retry Test</button>
                  <button className="btn btn-ghost" onClick={() => { setBrowseIdx(0); setFlipped(false); setMode("browse"); }}>Review Cards First</button>
                </div>
              </>
            )}
          </div>

          {/* Missed cards review */}
          {testResults.filter(r => !r.correct).length > 0 && (
            <div style={{marginTop:20}}>
              <div className="weak-review-title" style={{marginBottom:10}}>✗ Cards to review</div>
              {testResults.filter(r => !r.correct).map((r, i) => (
                <div key={i} className="weak-row">
                  <div className="weak-row-term">{r.card.term}</div>
                  <div className="weak-row-def">{r.card.def}</div>
                  {r.yourAnswer && <div style={{fontSize:11,color:"var(--red)",marginTop:4}}>Your answer: {r.yourAnswer}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    const card = testCards[testIdx];
    const tpct = Math.round((testIdx / testCards.length) * 100);

    const submit = async () => {
      if (!answer.trim() || revealed) return;
      setRevealed(true);
      const norm = s => s.toLowerCase().replace(/[^\w\s]/g,"").trim();
      const exact = norm(answer) === norm(card.def);
      if (exact) {
        setAiResult({ verdict:"correct", reason:"Exact match!" });
        playSound("correct");
      } else {
        // AI check
        setAiChecking(true);
        const result = await checkWithAI(card.term, card.def, answer);
        setAiResult(result);
        setAiChecking(false);
        if (result.verdict === "correct") playSound("correct");
        else if (result.verdict === "wrong") playSound("wrong");
      }
    };

    const commitResult = (correct) => {
      setTestResults(r => [...r, { card, correct, yourAnswer: correct ? null : answer }]);
      if (testIdx + 1 >= testCards.length) {
        setTestDone(true);
        playSound("sectionEnd");
      } else {
        setTestIdx(i => i + 1);
        setAnswer(""); setRevealed(false); setAiResult(null);
        setTimeout(() => taRef.current?.focus(), 80);
      }
    };

    return (
      <div className="quarter-test-wrap">
        <div className="flash-mode-bar">
          <button className="btn btn-ghost btn-sm" onClick={() => setMode("browse")}>← Back to Browse</button>
          <span className="flash-mode-label">Q{activeQuarter + 1} Test — {cumulativeCards.length} cards{activeQuarter > 0 ? " (cumulative)" : ""}</span>
          <span className="flash-phase-chip test">Test</span>
        </div>

        <div className="prog-wrap">
          <div className="prog-header">
            <span className="prog-label">Question {testIdx + 1} of {testCards.length}</span>
            <span className="prog-count">{testResults.filter(r=>r.correct).length} correct so far</span>
          </div>
          <div className="prog-track"><div className="prog-bar" style={{width:`${tpct}%`}}/></div>
        </div>

        <div className="qt-card pop-in">
          <div className="qt-term">{card?.term}</div>
          <div className="qt-instruction">Write the full definition from memory</div>
          <textarea
            ref={taRef}
            className={`qt-input${revealed ? (aiResult?.verdict==="correct"?" correct":aiResult?.verdict==="wrong"?" wrong":"") : ""}`}
            value={answer}
            onChange={e => setAnswer(e.target.value)}
            onKeyDown={e => { if (e.key==="Enter" && e.ctrlKey) submit(); }}
            disabled={revealed}
            placeholder="Type your definition here… (Ctrl+Enter to submit)"
            autoFocus
          />

          {!revealed && (
            <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:14}}>
              <button className="btn btn-primary" disabled={!answer.trim()} onClick={submit}>Check Answer →</button>
              <button className="btn btn-ghost btn-sm" onClick={() => commitResult(false)}>Skip</button>
            </div>
          )}

          {aiChecking && (
            <div className="ai-checking"><div className="spinner"/>Checking with AI…</div>
          )}

          {revealed && aiResult && (
            <>
              <div className={`qt-result-bar ${aiResult.verdict==="correct"?"correct":aiResult.verdict==="similar"?"similar":"wrong"}`}>
                <span>{aiResult.verdict==="correct"?"✓":aiResult.verdict==="similar"?"≈":"✗"}</span>
                <span>{aiResult.reason}</span>
              </div>

              <div className="qt-model">
                <div className="qt-model-lbl">Model Answer</div>
                <div className="qt-model-text">{card?.def}</div>
              </div>

              <div className="qt-actions">
                {aiResult.verdict === "correct" && (
                  <button className="btn btn-teal" onClick={() => { spawnConfetti(8); commitResult(true); }}>✓ Got it right →</button>
                )}
                {aiResult.verdict === "similar" && (
                  <>
                    <button className="btn btn-ghost" onClick={() => { playSound("wrong"); commitResult(false); }}>✗ Mark Wrong</button>
                    <button className="btn btn-teal" onClick={() => { playSound("correct"); spawnConfetti(6); commitResult(true); }}>✓ Close Enough</button>
                  </>
                )}
                {aiResult.verdict === "wrong" && (
                  <button className="btn btn-danger" onClick={() => commitResult(false)}>✗ Got it wrong →</button>
                )}
              </div>
              {aiResult.verdict === "similar" && (
                <div className="qt-ai-note">AI detected a similar meaning — you decide if it's close enough.</div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ─── Learn ────────────────────────────────────────────────────────────────────
function LearnTab({ cards, progress, saveProgress, streak, playSound }) {
  const [phase,setPhase]=useState("intro");
  const [sectionIdx,setSectionIdx]=useState(0);
  const [sections,setSections]=useState([]);
  const [queue,setQueue]=useState([]);
  const [qIdx,setQIdx]=useState(0);
  const [qData,setQData]=useState(null);
  const [answered,setAnswered]=useState(false);
  const [result,setResult]=useState(null);
  const [chosen,setChosen]=useState(null);
  const [written,setWritten]=useState("");
  const [sectionStats,setSectionStats]=useState({correct:0,wrong:0,wrongCards:[]});
  const inputRef=useRef(null);
  const buildSections=useCallback(()=>{
    if(!cards.length) return [];
    const active=cards.filter(c=>!progress[c.id]?.mastered);
    const sorted=[...active].sort((a,b)=>srPriority(progress[a.id])-srPriority(progress[b.id]));
    const all=sorted.length?sorted:[...cards];
    const rounds=[];
    for(let i=0;i<all.length;i+=ROUND_SIZE) rounds.push(all.slice(i,i+ROUND_SIZE));
    return rounds;
  },[cards,progress]);
  const startSection=(secs,si,prog)=>{
    const q=buildSRQueue(secs[si]||[],prog,(secs[si]||[]).length);
    setQueue([...q]);setQIdx(0);setSectionStats({correct:0,wrong:0,wrongCards:[]});
  };
  const startSession=()=>{const secs=buildSections();setSections(secs);setSectionIdx(0);startSection(secs,0,progress);setPhase("question");};
  useEffect(()=>{
    const current=queue[qIdx];
    if(!current||phase!=="question") return;
    const r=Math.random();
    let qtype=r<0.55?"mc":r<0.80?"tf":"written";
    if(cards.length<4) qtype="written";
    const dir=(qtype==="mc"&&Math.random()<0.4)?"defToTerm":"termToDef";
    let built;
    if(qtype==="mc") built={qtype,dir,...buildMCQ(current,cards,dir)};
    else if(qtype==="tf") built={qtype,dir:"mixed",...buildTF(current,cards)};
    else built={qtype:"written",dir:"termToDef",questionText:current.term,questionLabel:"Type the definition",correctAnswer:current.def,isReverse:false};
    setQData(built);setAnswered(false);setResult(null);setChosen(null);setWritten("");
    setTimeout(()=>inputRef.current?.focus(),80);
  },[qIdx,queue,phase]);
  const current=queue[qIdx];
  const commit=(correct)=>{
    if(answered||!current) return;
    setAnswered(true);setResult(correct?"correct":"wrong");
    const np={...progress};
    const p={...(np[current.id]||{correctStreak:0,totalIncorrect:0,totalCorrect:0,mastered:false})};
    if(correct){p.correctStreak=(p.correctStreak||0)+1;p.totalCorrect=(p.totalCorrect||0)+1;if(p.correctStreak>=MASTERY_THRESHOLD){p.mastered=true;playSound("mastered");spawnConfetti(18);}else playSound("correct");}
    else{p.totalIncorrect=(p.totalIncorrect||0)+1;p.correctStreak=0;playSound("wrong");}
    p.lastSeen=Date.now();np[current.id]=p;
    saveProgress(np, correct ? streak + 1 : 0);
    setSectionStats(s=>({correct:s.correct+(correct?1:0),wrong:s.wrong+(correct?0:1),wrongCards:correct?s.wrongCards:[...s.wrongCards,current]}));
  };
  const next=()=>{
    if(result==="wrong"){const nq=[...queue];nq.splice(Math.min(qIdx+2+~~(Math.random()*3),nq.length),0,current);setQueue(nq);}
    const ni=qIdx+1;
    if(ni>=queue.length){playSound("sectionEnd");setPhase("sectionEnd");}else setQIdx(ni);
  };
  const goNextSection=()=>{const ni=sectionIdx+1;if(ni>=sections.length){setPhase("allDone");}else{setSectionIdx(ni);startSection(sections,ni,progress);setPhase("question");}};
  if(!cards.length) return <Empty msg="Add cards in the Manage tab to start learning." />;
  if(phase==="intro"){
    const active=cards.filter(c=>!progress[c.id]?.mastered).length;
    const newC=cards.filter(c=>!progress[c.id]).length;
    const rev=cards.filter(c=>progress[c.id]&&!progress[c.id].mastered&&(progress[c.id].totalIncorrect||0)>0).length;
    const str=cards.filter(c=>(progress[c.id]?.totalIncorrect||0)>2).length;
    const tot=Math.ceil(active/ROUND_SIZE)||1;
    return(<div className="learn-wrap fade-up"><div className="round-end" style={{padding:"36px 28px"}}><div style={{fontSize:40,marginBottom:12}}>🧠</div><h2 style={{fontSize:22,fontWeight:800,color:"#fff",marginBottom:6}}>Ready to study?</h2><p style={{color:"var(--text2)",fontSize:13,marginBottom:20,lineHeight:1.7}}>{active} cards need work · <strong style={{color:"var(--violet)"}}>{tot} section{tot!==1?"s":""}</strong> of ~{ROUND_SIZE} questions each</p><div className="sr-insight">{newC>0&&<div className="sr-chip new">✦ {newC} new</div>}{rev>0&&<div className="sr-chip review">↺ {rev} review</div>}{str>0&&<div className="sr-chip struggling">⚠ {str} struggling</div>}{(cards.length-active)>0&&<div className="sr-chip mastered">✓ {cards.length-active} mastered</div>}</div><button className="btn btn-primary" style={{marginTop:8}} onClick={startSession}>Start Session →</button></div></div>);
  }
  if(phase==="sectionEnd"){
    const tot=sectionStats.correct+sectionStats.wrong;
    const pct=tot?Math.round((sectionStats.correct/tot)*100):0;
    const isLast=sectionIdx>=sections.length-1;
    return(<div className="learn-wrap slide-in"><div className="section-end"><div className="section-end-score" style={{color:pct>=80?"var(--teal)":pct>=50?"var(--yellow)":"var(--red)"}}>{pct}%</div><div className="section-end-label">Section {sectionIdx+1} complete</div><div className="section-end-breakdown"><div><div className="seb-val" style={{color:"var(--teal)"}}>{sectionStats.correct}</div><div className="seb-lbl">Correct</div></div><div><div className="seb-val" style={{color:"var(--red)"}}>{sectionStats.wrong}</div><div className="seb-lbl">Wrong</div></div><div><div className="seb-val" style={{color:"var(--violet)"}}>{sections.length-sectionIdx-1}</div><div className="seb-lbl">Remaining</div></div></div>{sectionStats.wrongCards.length>0&&(<div className="weak-review"><div className="weak-review-title">⚠ Review these before continuing</div>{sectionStats.wrongCards.map((c,i)=><div key={i} className="weak-row"><div className="weak-row-term">{c.term}</div><div className="weak-row-def">{c.def}</div></div>)}</div>)}<div style={{display:"flex",gap:8,justifyContent:"center",marginTop:24,flexWrap:"wrap"}}>{isLast?<button className="btn btn-primary" onClick={()=>setPhase("allDone")}>Finish Session ✓</button>:<button className="btn btn-primary" onClick={goNextSection}>Next Section →</button>}<button className="btn btn-ghost" onClick={()=>setPhase("intro")}>Back to Overview</button></div></div><div className="section-dots" style={{marginTop:20}}>{sections.map((_,i)=><div key={i} className={`sdot${i<=sectionIdx?" done":""}`}/>)}</div></div>);
  }
  if(phase==="allDone"){
    const mn=cards.filter(c=>progress[c.id]?.mastered).length;
    return(<div className="learn-wrap fade-up"><div className="round-end"><div className="round-score">🎉</div><div className="round-label">Session Complete!</div><div className="round-breakdown"><div><div className="breakdown-val" style={{color:"var(--teal)"}}>{mn}</div><div className="breakdown-lbl">Mastered</div></div><div><div className="breakdown-val" style={{color:"var(--yellow)"}}>{streak}</div><div className="breakdown-lbl">Streak</div></div><div><div className="breakdown-val" style={{color:"var(--red)"}}>{cards.filter(c=>(progress[c.id]?.totalIncorrect||0)>0&&!progress[c.id]?.mastered).length}</div><div className="breakdown-lbl">Still Weak</div></div></div><button className="btn btn-primary" onClick={()=>setPhase("intro")}>Study Again →</button></div></div>);
  }
  if(!current||!qData) return null;
  const pct=Math.round((qIdx/(queue.length||1))*100);
  const cp=progress[current.id]||{};
  const norm=s=>s.toLowerCase().replace(/[^\w\s]/g,"").trim();
  const chipLabel=qData.qtype==="mc"?(qData.isReverse?"Definition → Term":"Term → Definition"):qData.qtype==="tf"?"True / False":"Written Answer";
  const chipCls=qData.qtype==="tf"?" tf":qData.isReverse?" reverse":"";
  const tfP=qData.qtype==="tf"&&(qData.mode==="defFirst"?<><div className="learn-q-def-text">"{qData.shownDef}"</div><div className="learn-q-subtext">Is <strong style={{color:"#fff"}}>{qData.shownTerm}</strong> the correct term?</div></>:<><div className="learn-q-text">{qData.shownTerm}</div><div className="learn-q-subtext">Is this the right definition? <em style={{color:"var(--text2)",fontStyle:"normal"}}>"{qData.shownDef.slice(0,80)}{qData.shownDef.length>80?"…":""}"</em></div></>);
  return(
    <div className="learn-wrap">
      <div className="section-banner"><div className="section-banner-left"><h3>Section {sectionIdx+1} of {sections.length}</h3><p>{qIdx+1} of {queue.length} · streak {cp.correctStreak||0}/{MASTERY_THRESHOLD}</p></div><div className="section-tag">{(progress[current.id]?.totalIncorrect||0)>1?"Needs work":"Looking good"}</div></div>
      <div className="section-dots">{sections.map((_,i)=><div key={i} className={`sdot${i<sectionIdx?" done":i===sectionIdx?" active":""}`}/>)}</div>
      <div className="prog-wrap"><div className="prog-header"><span className="prog-label">Progress in section</span><span className="prog-count">{pct}%</span></div><div className="prog-track"><div className="prog-bar" style={{width:`${pct}%`}}/><div className="prog-thumb" style={{left:`${Math.max(Math.min(pct,96),2)}%`}}>{qIdx}</div></div></div>
      <div className="learn-q-card pop-in"><div className="learn-q-label">{qData.questionLabel}</div><div className={`learn-q-type-chip${chipCls}`}>{chipLabel}</div>{qData.qtype==="tf"?tfP:qData.isReverse?<div className="learn-q-def-text">{qData.questionText}</div>:<div className="learn-q-text">{qData.questionText}</div>}</div>
      {qData.qtype==="mc"&&<div className="mc-grid">{qData.options.map((opt,i)=>{const ic=opt===qData.correctAnswer;const cls=answered?(ic?" cor":chosen===opt?" wrg":""):"";return<button key={i} className={`mc-opt${cls}`} disabled={answered} onClick={()=>{setChosen(opt);commit(opt===qData.correctAnswer);}}><span className="opt-letter">{String.fromCharCode(65+i)}</span><span>{opt}</span></button>;})}</div>}
      {qData.qtype==="tf"&&<div className="tf-grid">{["True","False"].map(lbl=>{const ut=lbl==="True";const cls=answered?((qData.isTrue===ut)?" cor":" wrg"):"";return<button key={lbl} className={`tf-opt${cls}`} disabled={answered} onClick={()=>commit(qData.isTrue===ut)}>{lbl==="True"?"✓ True":"✗ False"}</button>;})}</div>}
      {qData.qtype==="written"&&<div className="written-wrap"><input ref={inputRef} className={`written-input${answered?` ${result==="correct"?"cor":"wrg"}`:""}`} value={written} onChange={e=>setWritten(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!answered&&commit(norm(written)===norm(qData.correctAnswer))} disabled={answered} placeholder={qData.isReverse?"Type the term…":"Type the definition…"}/>{!answered&&<button className="btn btn-primary" onClick={()=>commit(norm(written)===norm(qData.correctAnswer))}>Check →</button>}</div>}
      {answered&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,marginTop:16}}><div className={`feedback-bar ${result==="correct"?"cor":"wrg"}`}><span>{result==="correct"?"✓":"✗"}</span><span>{result==="correct"?cp.mastered?"Card mastered! 🎉":`Correct! ${cp.correctStreak||0}/${MASTERY_THRESHOLD} streak`:`Correct answer: ${qData.correctAnswer}`}</span></div><button className="btn btn-primary" onClick={next}>Continue →</button></div>}
    </div>
  );
}

// ─── Exam ─────────────────────────────────────────────────────────────────────
function ExamTab({ cards, progress, saveProgress, streak, playSound }) {
  const [deck]=useState(()=>shuffle([...cards]));
  const [idx,setIdx]=useState(0);
  const [answer,setAnswer]=useState("");
  const [revealed,setRevealed]=useState(false);
  const [score,setScore]=useState({c:0,t:0});
  const taRef=useRef(null);
  useEffect(()=>{setAnswer("");setRevealed(false);setTimeout(()=>taRef.current?.focus(),80);},[idx]);
  if(!cards.length) return <Empty msg="Add cards in the Manage tab." />;
  const card=deck[idx%deck.length];
  const pct=Math.round((score.t/deck.length)*100);
  const grade=(correct)=>{
    playSound(correct?"correct":"wrong");
    const np={...progress};
    const p={...(np[card.id]||{correctStreak:0,totalIncorrect:0,totalCorrect:0,mastered:false})};
    if(correct){p.correctStreak=(p.correctStreak||0)+1;p.totalCorrect=(p.totalCorrect||0)+1;if(p.correctStreak>=MASTERY_THRESHOLD){p.mastered=true;spawnConfetti(16);playSound("mastered");}}
    else{p.totalIncorrect=(p.totalIncorrect||0)+1;p.correctStreak=0;}
    np[card.id]=p;saveProgress(np,correct?streak+1:0);
    setScore(s=>({c:s.c+(correct?1:0),t:s.t+1}));setIdx(i=>i+1);
  };
  return(
    <div style={{maxWidth:680,margin:"0 auto"}} className="fade-up">
      <div className="prog-wrap"><div className="prog-header"><span className="prog-label">Q{(idx%deck.length)+1} of {deck.length}</span><span className="prog-count">{score.c}/{score.t} correct</span></div><div className="prog-track"><div className="prog-bar" style={{width:`${pct}%`}}/></div></div>
      <div className="learn-q-card" style={{marginBottom:16}}><div className="learn-q-label">Exam Question</div><div className="learn-q-type-chip">Open Answer</div><div className="learn-q-text">{card.term}</div><div className="learn-q-subtext">Write your answer, then reveal the model answer.</div></div>
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
        <textarea ref={taRef} className="exam-ta" value={answer} onChange={e=>setAnswer(e.target.value)} disabled={revealed} placeholder="Write your full answer here…"/>
        {!revealed&&<button className="btn btn-primary" disabled={!answer.trim()} onClick={()=>setRevealed(true)}>Reveal Model Answer</button>}
      </div>
      {revealed&&<div style={{display:"flex",flexDirection:"column",alignItems:"center"}}><div className="model-ans"><div className="model-ans-lbl">Model Answer</div><div className="model-ans-text">{card.def}</div></div><div className="self-grade"><span style={{fontSize:11,color:"var(--text2)"}}>How did you do?</span><button className="btn btn-danger" onClick={()=>grade(false)}>✗ Got it wrong</button><button className="btn btn-teal" onClick={()=>grade(true)}>✓ Got it right</button></div></div>}
    </div>
  );
}

// ─── Test ─────────────────────────────────────────────────────────────────────
function TestTab({ cards, playSound }) {
  const [tc,setTc]=useState(null);const[ans,setAns]=useState({});const[done,setDone]=useState(false);const[mcqs,setMcqs]=useState([]);
  const start=()=>{if(cards.length<2)return;const sel=shuffle(cards).slice(0,Math.min(cards.length,10));setTc(sel);setMcqs(sel.map(c=>buildMCQ(c,cards,"termToDef")));setAns({});setDone(false);};
  if(!cards.length) return <Empty msg="Add cards in the Manage tab." />;
  if(!tc) return(<div className="round-end fade-up"><div className="round-score">📝</div><div className="round-label">Ready for a test?</div><div style={{color:"var(--text2)",marginBottom:24,fontSize:13}}>Up to 10 questions from your {cards.length} cards.</div><button className="btn btn-primary" onClick={start}>Start Test</button></div>);
  const submit=()=>{const s=tc.filter(c=>ans[c.id]===c.def).length;const p=Math.round((s/tc.length)*100);setDone(true);if(p>=80){playSound("mastered");spawnConfetti(25);}else if(p>=50)playSound("correct");else playSound("wrong");};
  if(done){
    const score=tc.filter(c=>ans[c.id]===c.def).length;const pct=Math.round((score/tc.length)*100);
    return(<div className="round-end fade-up"><div className="round-score" style={{color:pct>=80?"var(--teal)":pct>=60?"var(--yellow)":"var(--red)"}}>{pct}%</div><div className="round-label">{score}/{tc.length} correct</div><div className="round-breakdown"><div><div className="breakdown-val" style={{color:"var(--teal)"}}>{score}</div><div className="breakdown-lbl">Correct</div></div><div><div className="breakdown-val" style={{color:"var(--red)"}}>{tc.length-score}</div><div className="breakdown-lbl">Wrong</div></div></div><div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap",marginBottom:28}}><button className="btn btn-primary" onClick={start}>Retry</button><button className="btn btn-ghost" onClick={()=>setTc(null)}>Back</button></div><div style={{textAlign:"left"}}>{tc.map((c,i)=>{const ok=ans[c.id]===c.def;return(<div key={c.id} className="test-q" style={{borderColor:ok?"var(--teal)":"var(--red)"}}><div className="test-q-num">Q{i+1} · {ok?"✓ Correct":"✗ Wrong"}</div><div className="test-q-term">{c.term}</div><div style={{fontSize:12,color:"var(--teal)"}}>✓ {c.def}</div>{!ok&&<div style={{fontSize:12,color:"var(--red)",marginTop:4}}>Your answer: {ans[c.id]||"(skipped)"}</div>}</div>);})}</div></div>);
  }
  return(<div className="fade-up"><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}><div style={{fontSize:13,fontWeight:600,color:"var(--text2)"}}>{tc.length} Questions</div><button className="btn btn-ghost btn-sm" onClick={()=>setTc(null)}>✕ Cancel</button></div>{tc.map((c,i)=>(<div key={c.id} className="test-q"><div className="test-q-num">Question {i+1} of {tc.length}</div><div className="test-q-term">{c.term}</div><div className="mc-grid">{mcqs[i]?.options.map((opt,j)=>(<button key={j} className={`mc-opt${ans[c.id]===opt?" cor":""}`} onClick={()=>{setAns(a=>({...a,[c.id]:opt}));playSound("flip");}}><span className="opt-letter">{String.fromCharCode(65+j)}</span><span>{opt}</span></button>))}</div></div>))}<div style={{display:"flex",justifyContent:"center",marginTop:16}}><button className="btn btn-primary" onClick={submit} disabled={Object.keys(ans).length<tc.length}>Submit ({Object.keys(ans).length}/{tc.length} answered)</button></div></div>);
}

// ─── Manage ───────────────────────────────────────────────────────────────────
function ManageTab({ set, cards, progress, onUpdateRaw, onResetProgress, onRenameSet }) {
  const [raw,setRaw]=useState(set.raw||"");
  const [saved,setSaved]=useState(false);
  useEffect(()=>setRaw(set.raw||""),[set.id]);
  const doSave=()=>{onUpdateRaw(raw);setSaved(true);setTimeout(()=>setSaved(false),1800);};
  return(
    <div>
      <div className="panel">
        <div className="panel-title">Cards — {set.name}</div>
        <textarea className="import-ta" value={raw} onChange={e=>setRaw(e.target.value)} spellCheck={false} placeholder={"Term\tDefinition\nAnother term\tAnother definition"}/>
        <div className="fmt-hint">Format: <code>term [TAB] definition</code> — one per line.</div>
        <div className="btn-row">
          <button className={`btn ${saved?"btn-teal":"btn-primary"}`} onClick={doSave}>{saved?"✓ Saved!":`Save ${raw.split("\n").filter(l=>l.includes("\t")).length} Cards`}</button>
          <button className="btn btn-ghost" onClick={onRenameSet}>✏️ Rename Set</button>
          <button className="btn btn-danger" onClick={()=>{if(confirm("Reset all progress for this set?"))onResetProgress();}}>Reset Progress</button>
        </div>
      </div>
      {cards.length>0&&<div className="panel"><div className="panel-title">{cards.length} Cards in Set</div><TermsList cards={cards} progress={progress}/></div>}
    </div>
  );
}

// ─── Terms List ───────────────────────────────────────────────────────────────
function TermsList({ cards, progress }) {
  return(
    <div className="terms-list">
      {cards.map(c=>{
        const p=progress[c.id];
        const status=p?.mastered?"mastered":(p?.totalIncorrect||0)>(p?.correctStreak||0)?"weak":p?"learning":null;
        return(<div key={c.id} className="term-row"><div className="term-col">{c.term}</div><div className="def-col">{c.def}</div>{status&&<div className={`term-badge ${status}`}>{status}</div>}</div>);
      })}
    </div>
  );
}

function Empty({ msg="Go to Manage to add your flashcards." }) {
  return(<div className="empty-state"><div className="empty-icon">🃏</div><div className="empty-title">No cards yet</div><div>{msg}</div></div>);
}

// ─── SM-2 Anki Engine ─────────────────────────────────────────────────────────
// Card states: "new" | "learning" | "review"
// Learning steps (minutes): [1, 6, 10] — matches Anki defaults
// On graduation (completing all learning steps with Good/Easy): enters review with 1-day interval
// Review ratings:
//   Again → back to learning step 0 (due in 1 min)
//   Hard  → interval × 1.2,  ease - 0.15 (min ease 1.3)
//   Good  → interval × ease, ease unchanged
//   Easy  → interval × ease × 1.3, ease + 0.15
// Ease factor starts at 2.5, never goes below 1.3
// Due times are calculated from real timestamps — not cosmetic

const LEARNING_STEPS_MINS = [1, 6, 10]; // minutes
const GRADUATING_INTERVAL_DAYS = 1;
const EASY_INTERVAL_DAYS = 4;
const EASY_BONUS = 1.3;
const STARTING_EASE = 2.5;
const MIN_EASE = 1.3;

function formatInterval(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `<${mins}m`;
  const hrs = Math.round(ms / 3600000);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(ms / 86400000);
  return `${days}d`;
}

function computeNextIntervals(card) {
  const now = Date.now();
  const state = card.anki_state || "new";
  const step  = card.anki_step  || 0;
  const ivl   = card.anki_interval_days || 0; // days
  const ease  = card.anki_ease || STARTING_EASE;

  // Learning / new card — show step-based intervals
  if (state === "new" || state === "learning") {
    const againMs  = LEARNING_STEPS_MINS[0] * 60000;
    const hardMs   = LEARNING_STEPS_MINS[Math.max(0, step - 1)] * 60000;
    const goodMs   = step < LEARNING_STEPS_MINS.length - 1
      ? LEARNING_STEPS_MINS[step + 1] * 60000
      : GRADUATING_INTERVAL_DAYS * 86400000;
    const easyMs   = EASY_INTERVAL_DAYS * 86400000;
    return { again: againMs, hard: hardMs, good: goodMs, easy: easyMs };
  }

  // Review card — interval-based
  const ivlMs = ivl * 86400000;
  const againMs  = LEARNING_STEPS_MINS[0] * 60000;
  const hardMs   = Math.max(ivlMs * 1.2, ivlMs + 86400000);
  const goodMs   = Math.max(ivlMs * ease, hardMs + 86400000);
  const easyMs   = Math.max(ivlMs * ease * EASY_BONUS, goodMs + 86400000);
  return { again: againMs, hard: hardMs, good: goodMs, easy: easyMs };
}

function applyRating(card, rating) {
  const now = Date.now();
  const state = card.anki_state || "new";
  const step  = card.anki_step  || 0;
  const ivl   = card.anki_interval_days || 0;
  const ease  = card.anki_ease || STARTING_EASE;
  let newState = state, newStep = step, newIvl = ivl, newEase = ease, dueAt;

  if (state === "new" || state === "learning") {
    if (rating === "again") {
      newState = "learning"; newStep = 0;
      dueAt = now + LEARNING_STEPS_MINS[0] * 60000;
    } else if (rating === "hard") {
      newState = "learning";
      newStep = Math.max(0, step - 1);
      dueAt = now + LEARNING_STEPS_MINS[newStep] * 60000;
    } else if (rating === "good") {
      if (step >= LEARNING_STEPS_MINS.length - 1) {
        // Graduate to review
        newState = "review"; newStep = 0; newIvl = GRADUATING_INTERVAL_DAYS;
        dueAt = now + newIvl * 86400000;
      } else {
        newState = "learning"; newStep = step + 1;
        dueAt = now + LEARNING_STEPS_MINS[newStep] * 60000;
      }
    } else { // easy — immediate graduation
      newState = "review"; newStep = 0; newIvl = EASY_INTERVAL_DAYS;
      dueAt = now + newIvl * 86400000;
    }
  } else {
    // Review card
    if (rating === "again") {
      newState = "learning"; newStep = 0;
      newEase = Math.max(MIN_EASE, ease - 0.20);
      newIvl = 0;
      dueAt = now + LEARNING_STEPS_MINS[0] * 60000;
    } else if (rating === "hard") {
      newEase = Math.max(MIN_EASE, ease - 0.15);
      newIvl = Math.max(ivl + 1, Math.ceil(ivl * 1.2));
      dueAt = now + newIvl * 86400000;
    } else if (rating === "good") {
      newIvl = Math.max(ivl + 1, Math.ceil(ivl * ease));
      dueAt = now + newIvl * 86400000;
    } else { // easy
      newEase = Math.min(ease + 0.15, 5.0);
      newIvl = Math.max(ivl + 1, Math.ceil(ivl * ease * EASY_BONUS));
      dueAt = now + newIvl * 86400000;
    }
  }

  return {
    anki_state: newState,
    anki_step: newStep,
    anki_interval_days: newIvl,
    anki_ease: Math.max(MIN_EASE, newEase),
    anki_due_at: new Date(dueAt).toISOString(),
    anki_last_reviewed: new Date(now).toISOString(),
  };
}

// ─── Anki Tab ─────────────────────────────────────────────────────────────────
function AnkiTab({ cards, userId, setId, playSound }) {
  const [ankiData,     setAnkiData]     = useState({});
  const [queue,        setQueue]        = useState([]);
  const [qIdx,         setQIdx]         = useState(0);
  const [flipped,      setFlipped]      = useState(false);
  const [loading,      setLoading]      = useState(true);
  const [sessionStats, setSessionStats] = useState({ again:0, hard:0, good:0, easy:0 });
  const [done,         setDone]         = useState(false);

  useEffect(() => {
    if (!userId || !setId || !cards.length) { setLoading(false); return; }
    supabase.from("anki_progress").select("*").eq("user_id", userId).eq("set_id", setId)
      .then(({ data }) => {
        const map = {};
        (data||[]).forEach(r => { map[r.card_id] = r; });
        setAnkiData(map);
        buildQueue(cards, map);
        setLoading(false);
      });
  }, [userId, setId, cards.length]);

  const buildQueue = (allCards, data) => {
    const now = Date.now();
    const due = allCards.filter(c => {
      const d = data[c.id];
      return d && d.anki_state !== "new" && new Date(d.anki_due_at).getTime() <= now;
    });
    const newCards = allCards.filter(c => !data[c.id]);
    const learning = due.filter(c => data[c.id]?.anki_state === "learning");
    const review   = due.filter(c => data[c.id]?.anki_state === "review");
    const q = [...learning, ...shuffle(review), ...shuffle(newCards)];
    setQueue(q); setQIdx(0); setFlipped(false); setDone(q.length === 0);
  };

  const currentCard = queue[qIdx];
  const currentData = currentCard
    ? (ankiData[currentCard.id] || { anki_state:"new", anki_step:0, anki_interval_days:0, anki_ease:STARTING_EASE })
    : null;
  const intervals = currentData ? computeNextIntervals(currentData) : null;

  const rate = async (rating) => {
    if (!currentCard || !flipped) return;
    playSound(rating==="again"?"wrong":rating==="easy"?"mastered":"correct");
    if (rating==="easy") spawnConfetti(16);
    else if (rating==="good") spawnConfetti(6);

    const updated = applyRating(currentData, rating);
    const row = { user_id:userId, set_id:setId, card_id:currentCard.id, ...updated };
    await supabase.from("anki_progress").upsert(row, { onConflict:"user_id,set_id,card_id" });

    const newData = { ...ankiData, [currentCard.id]: row };
    setAnkiData(newData);
    setSessionStats(s => ({ ...s, [rating]: s[rating]+1 }));
    setFlipped(false);

    if (rating === "again") {
      const nq = [...queue];
      nq.splice(Math.min(qIdx+2, nq.length), 0, currentCard);
      setQueue(nq);
      setTimeout(() => setQIdx(i => i+1), 320);
    } else {
      const ni = qIdx + 1;
      if (ni >= queue.length) setDone(true);
      else setTimeout(() => setQIdx(ni), 320);
    }
  };

  if (!cards.length) return <Empty msg="Add cards in the Manage tab to use Anki mode." />;
  if (loading) return <div className="loading"><div className="spinner"/><span>Loading Anki progress…</span></div>;

  const now = Date.now();
  const newCount      = cards.filter(c => !ankiData[c.id]).length;
  const learningCount = cards.filter(c => ankiData[c.id]?.anki_state === "learning").length;
  const dueCount      = cards.filter(c => {
    const d = ankiData[c.id];
    return d && d.anki_state !== "new" && new Date(d.anki_due_at).getTime() <= now;
  }).length;
  const reviewedCount = cards.filter(c => ankiData[c.id]?.anki_state === "review").length;
  const totalDone     = Object.values(sessionStats).reduce((a,b)=>a+b,0);

  // ── Done screen ──
  if (done) return (
    <div className="anki-wrap fade-up">
      <div className="anki-stats">
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--accent2)"}}>{newCount}</div><div className="anki-stat-lbl">New</div></div>
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--yellow)"}}>{learningCount}</div><div className="anki-stat-lbl">Learning</div></div>
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--teal)"}}>{dueCount}</div><div className="anki-stat-lbl">Due</div></div>
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--violet)"}}>{reviewedCount}</div><div className="anki-stat-lbl">Review</div></div>
      </div>
      <div className="anki-done">
        <div className="anki-done-icon">🎉</div>
        <div className="anki-done-title">All done for now!</div>
        <div className="anki-done-sub">
          You reviewed <strong style={{color:"#fff"}}>{totalDone}</strong> cards this session.
        </div>
        <div className="anki-session-row">
          <div><div className="anki-session-val" style={{color:"var(--red)"}}>{sessionStats.again}</div><div className="anki-stat-lbl">Again</div></div>
          <div><div className="anki-session-val" style={{color:"var(--yellow)"}}>{sessionStats.hard}</div><div className="anki-stat-lbl">Hard</div></div>
          <div><div className="anki-session-val" style={{color:"var(--accent2)"}}>{sessionStats.good}</div><div className="anki-stat-lbl">Good</div></div>
          <div><div className="anki-session-val" style={{color:"var(--teal)"}}>{sessionStats.easy}</div><div className="anki-stat-lbl">Easy</div></div>
        </div>
        <div style={{fontSize:12,color:"var(--text2)",marginBottom:20}}>Your next cards are scheduled — come back later when they're due.</div>
        <button className="btn btn-primary" onClick={() => buildQueue(cards, ankiData)}>Check for More</button>
      </div>
    </div>
  );

  const state = currentData?.anki_state || "new";

  return (
    <div className="anki-wrap">
      {/* Stats row — same style as other tabs but with Anki-specific counts */}
      <div className="anki-stats">
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--accent2)"}}>{newCount}</div><div className="anki-stat-lbl">New</div></div>
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--yellow)"}}>{learningCount}</div><div className="anki-stat-lbl">Learning</div></div>
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--teal)"}}>{dueCount}</div><div className="anki-stat-lbl">Due</div></div>
        <div className="anki-stat"><div className="anki-stat-val" style={{color:"var(--violet)"}}>{queue.length - qIdx}</div><div className="anki-stat-lbl">Remaining</div></div>
      </div>

      {/* Card — identical flip mechanic to Flashcards tab */}
      <div className="anki-card-area" onClick={!flipped ? ()=>{setFlipped(true);playSound("flip");} : undefined}>
        <div className={`anki-card-wrap${flipped?" flipped":""}`}>
          {/* Front */}
          <div className="anki-face">
            <div className="anki-chip">Term</div>
            <div className={`anki-state-chip ${state}`}>{state}</div>
            <div className="anki-term">{currentCard?.term}</div>
            <div className="anki-hint">click to reveal answer</div>
          </div>
          {/* Back */}
          <div className="anki-face anki-face-back">
            <div className="anki-chip">Definition</div>
            <div className={`anki-state-chip ${state}`}>{state}</div>
            <div className="anki-def">{currentCard?.def}</div>
          </div>
        </div>
      </div>

      {/* Controls */}
      {!flipped ? (
        <div className="anki-nav">
          <button className="btn btn-primary" onClick={()=>{setFlipped(true);playSound("flip");}}>
            Show Answer
          </button>
        </div>
      ) : (
        <>
          <div className="anki-ratings">
            {[
              { key:"again", label:"Again", cls:"again" },
              { key:"hard",  label:"Hard",  cls:"hard"  },
              { key:"good",  label:"Good",  cls:"good"  },
              { key:"easy",  label:"Easy",  cls:"easy"  },
            ].map(({ key, label, cls }) => (
              <button key={key} className={`anki-btn ${cls}`} onClick={() => rate(key)}>
                <span className="anki-btn-interval">{formatInterval(intervals[key])}</span>
                <span className="anki-btn-label">{label}</span>
              </button>
            ))}
          </div>
          {currentData?.anki_state === "review" && (
            <div className="anki-meta">
              Interval: {currentData.anki_interval_days}d · Ease: {((currentData.anki_ease||STARTING_EASE)*100).toFixed(0)}%
            </div>
          )}
        </>
      )}
    </div>
  );
}

