/* ================================================================
   Mandelbrot — 5 design treatments
   All artboards: 1440 × 900
   ================================================================ */

const PLACES = [
  { id: 'whole',    name: 'home',              re: -0.500000, im:  0.000000, z: '1×',     thumb: 'renders/whole.png' },
  { id: 'seahorse', name: 'seahorse valley',   re: -0.745000, im:  0.113000, z: '110×',   thumb: 'renders/seahorse.png' },
  { id: 'spiral',   name: 'triple spiral',     re: -0.088000, im:  0.654000, z: '800×',   thumb: 'renders/spiral.png' },
  { id: 'elephant', name: 'elephant valley',   re:  0.282000, im:  0.011500, z: '90×',    thumb: 'renders/elephant.png' },
  { id: 'island',   name: 'julia island',      re: -0.160000, im:  1.040500, z: '30×',    thumb: 'renders/island.png' },
  { id: 'tendril',  name: 'lightning tendril', re: -1.250660, im:  0.020120, z: '250×',   thumb: 'renders/tendril.png' },
];

/* ---------- shared SVG icons ---------- */
const Icon = {
  plus:   (p) => <svg {...p} viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  minus:  (p) => <svg {...p} viewBox="0 0 16 16" fill="none"><path d="M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  rec:    (p) => <svg {...p} viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="5"/></svg>,
  film:   (p) => <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6h12M2 10h12M5 3v10M11 3v10"/></svg>,
  target: (p) => <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1"><circle cx="8" cy="8" r="5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></svg>,
  reset:  (p) => <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 8a5 5 0 1 0 1.46-3.54L3 6m0-3v3h3"/></svg>,
  copy:   (p) => <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="3" y="3" width="8" height="8" rx="1"/><path d="M5 3V2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1"/></svg>,
  shot:   (p) => <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 5a1 1 0 0 1 1-1h2l1-1.5h4L11 4h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z"/><circle cx="8" cy="9" r="2.5"/></svg>,
};

/* helper for the soft fractal-image fill */
const fractal = (src) => ({
  position: 'absolute', inset: 0,
  backgroundImage: `url(${src})`,
  backgroundSize: 'cover',
  backgroundPosition: 'center',
});

const vignette = {
  position: 'absolute', inset: 0,
  background: 'radial-gradient(120% 80% at 50% 50%, transparent 40%, rgba(0,0,0,0.45) 100%)',
  pointerEvents: 'none',
};

const scanlines = {
  position: 'absolute', inset: 0,
  background: 'repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0 1px, rgba(0,0,0,0.18) 1px 2px)',
  mixBlendMode: 'multiply',
  opacity: 0.35,
  pointerEvents: 'none',
};

/* ================================================================
   1 · CLASSIC — minimal HUD, matches the original mock
   ================================================================ */
function DesignClassic() {
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>
      <div style={fractal('renders/whole.png')} />
      <div style={vignette} />
      <div style={scanlines} />

      {/* center crosshair */}
      <svg style={{ position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)', overflow:'visible' }} width="48" height="48" viewBox="-24 -24 48 48">
        <circle cx="0" cy="0" r="11" fill="none" stroke="rgba(242,240,234,0.85)" strokeWidth="1"/>
        <line x1="-22" y1="0" x2="-14" y2="0" stroke="rgba(242,240,234,0.7)" strokeWidth="1"/>
        <line x1="14"  y1="0" x2="22"  y2="0" stroke="rgba(242,240,234,0.7)" strokeWidth="1"/>
        <line x1="0" y1="-22" x2="0" y2="-14" stroke="rgba(242,240,234,0.7)" strokeWidth="1"/>
        <line x1="0" y1="14"  x2="0" y2="22"  stroke="rgba(242,240,234,0.7)" strokeWidth="1"/>
        <circle cx="0" cy="0" r="1.2" fill="rgba(242,240,234,0.95)"/>
      </svg>

      {/* TOP LEFT — coords */}
      <div style={cls.hud}>
        <div style={{ display:'flex', alignItems:'center', gap:12, fontSize:12 }}>
          <span style={{ color:'var(--accent)', fontWeight:700 }}>calje</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <span style={{ color:'var(--fg-subtle)' }}>mandelbrot</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <span>z := z² + c</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12, fontSize:12, marginTop:8 }}>
          <span style={{ color:'var(--fg-subtle)' }}>re</span>
          <span style={{ fontVariantNumeric:'tabular-nums' }}>−0.5000000</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <span style={{ color:'var(--fg-subtle)' }}>im</span>
          <span style={{ fontVariantNumeric:'tabular-nums' }}>+0.0000000</span>
        </div>
      </div>

      {/* TOP RIGHT — zoom panel */}
      <div style={{ ...cls.hud, top: 24, right: 24, left: 'auto' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, fontSize:12 }}>
          <span style={{ color:'var(--fg-subtle)' }}>zoom</span>
          <span style={cls.pill}>1.00</span>
          <span style={{ color:'var(--fg-faint)' }}>· 10^</span>
          <span style={cls.pill}>0</span>
          <span style={cls.badge}>origin</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, fontSize:12, marginTop:8, color:'var(--fg-subtle)' }}>
          <span>iter</span><span style={{ color:'var(--fg)' }}>0</span><span style={{ color:'var(--fg-faint)' }}>/</span><span>512</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <span>—ms</span>
        </div>
      </div>

      {/* BOTTOM — compact dock with places dropdown */}
      <div style={{ position:'absolute', left:'50%', bottom: 28, transform:'translateX(-50%)',
                    display:'flex', flexDirection:'column', alignItems:'stretch', gap:0,
                    background:'rgba(10,10,10,0.74)', border:'1px solid var(--border)',
                    borderRadius: 14, backdropFilter:'blur(8px)',
                    boxShadow:'var(--shadow-card)', overflow:'visible' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', position:'relative' }}>
          <span style={cls.label}>place</span>
          {/* dropdown trigger */}
          <button style={{ ...cls.pillBtn, height: 28, paddingRight: 8, gap: 10, minWidth: 200 }}>
            <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--accent)', boxShadow:'0 0 6px var(--accent-glow)' }} />
              <span>seahorse valley</span>
            </span>
            <span style={{ marginLeft:'auto', color:'var(--fg-subtle)', fontSize:10 }}>▾</span>
          </button>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <span style={cls.label}>zoom</span>
          <button style={{ ...cls.pillBtn, width:28, padding:0, justifyContent:'center' }}><Icon.minus width={12} height={12} /></button>
          <button style={{ ...cls.pillBtn, width:28, padding:0, justifyContent:'center' }}><Icon.plus  width={12} height={12} /></button>
          <span style={{ width:1, height:18, background:'var(--border)', margin:'0 2px' }} />
          <button style={{ ...cls.pillBtn, color:'var(--glitch-red)', borderColor:'rgba(255,61,90,0.4)' }}>
            <Icon.rec width={10} height={10} /> record
          </button>

          {/* open dropdown popover — shown to demonstrate the affordance */}
          <div style={{
            position:'absolute', left: 56, bottom: '100%', marginBottom: 8,
            width: 300, padding: 6,
            background:'rgba(14,14,14,0.96)', border:'1px solid var(--border)',
            borderRadius: 8, boxShadow:'var(--shadow-card)',
            display:'flex', flexDirection:'column', gap: 2,
          }}>
            <div style={{ padding:'4px 8px', fontSize:10, color:'var(--fg-subtle)',
                           letterSpacing:'0.12em', textTransform:'uppercase' }}>
              predefined places
            </div>
            {PLACES.map((p, i) => (
              <div key={p.id} style={{
                display:'grid', gridTemplateColumns:'24px 1fr auto auto',
                alignItems:'center', gap: 8,
                padding:'6px 8px', borderRadius: 4,
                background: i===1 ? 'var(--ink-2)' : 'transparent',
                color: i===1 ? 'var(--accent)' : 'var(--fg)',
                fontSize: 12,
              }}>
                <kbd style={cls.key}>{i+1}</kbd>
                <span>{p.name}</span>
                <span style={{ color:'var(--fg-subtle)', fontSize: 10, fontVariantNumeric:'tabular-nums' }}>{p.z}</span>
                {i===1 && <span style={{ color:'var(--accent)', fontSize: 11 }}>✓</span>}
              </div>
            ))}

            <div style={{ height:1, background:'var(--border)', margin:'4px 0' }} />
            <div style={{ padding:'4px 8px', fontSize:10, color:'var(--fg-subtle)',
                           letterSpacing:'0.12em', textTransform:'uppercase',
                           display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span>palette</span>
              <span style={{ color:'var(--fg-faint)' }}><kbd style={cls.key}>p</kbd> cycle</span>
            </div>
            <div style={{ display:'flex', gap:6, padding:'4px 8px 6px' }}>
              {[
                ['warm',     'linear-gradient(135deg,#04132C,#69D1FF 45%,#FF8A1C 80%,#320700)'],
                ['phosphor', 'linear-gradient(135deg,#000,#7CFF6B 60%,#000)'],
                ['ivory',    'linear-gradient(135deg,#000,#F2F0EA 50%,#000)'],
                ['electric', 'linear-gradient(135deg,#050010,#00E5FF 40%,#F2F0EA 60%,#FF3D5A 90%)'],
                ['abyss',    'linear-gradient(135deg,#030518,#193C8C 50%,#78B4FF 90%)'],
                ['ember',    'linear-gradient(135deg,#080200,#FF3D14 60%,#F5C518)'],
              ].map(([name, grad], i) => (
                <button key={name} title={name} style={{
                  width: 28, height: 28, borderRadius:'50%',
                  background: grad,
                  border: i===0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                  boxShadow: i===0 ? '0 0 0 1px var(--accent), 0 0 0 3px rgba(124,255,107,0.18)' : 'none',
                  cursor:'pointer', padding: 0,
                }} />
              ))}
            </div>
          </div>
        </div>
        <div style={{ height:1, background:'var(--border)' }} />
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:10,
                       padding:'8px 14px', fontSize:11, color:'var(--fg-subtle)', flexWrap:'wrap' }}>
          <kbd style={cls.key}>click</kbd><span>in</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <kbd style={cls.key}>⇧ click</kbd><span>out</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <kbd style={cls.key}>space</kbd><span>zoom</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <kbd style={cls.key}>1-6</kbd><span>places</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <kbd style={cls.key}>⌃ c</kbd><span>copy</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <kbd style={cls.key}>⌃ ⇧ c</kbd><span>save png</span>
        </div>
      </div>
    </div>
  );
}

const cls = {
  hud: {
    position:'absolute', top: 24, left: 24,
    padding: '12px 16px',
    background:'rgba(10,10,10,0.72)',
    border:'1px solid var(--border)',
    borderRadius:'var(--r-2)',
    backdropFilter:'blur(6px)',
    boxShadow:'var(--shadow-card)',
    color:'var(--fg)',
  },
  pill: {
    display:'inline-flex', alignItems:'center', justifyContent:'center',
    background:'var(--ink-1)', border:'1px solid var(--border)',
    borderRadius:'var(--r-pill)', padding:'4px 10px', minWidth: 42,
    fontVariantNumeric:'tabular-nums',
  },
  badge: {
    display:'inline-flex', alignItems:'center', height:20, padding:'0 8px',
    border:'1px solid var(--border)', borderRadius:'var(--r-pill)',
    color:'var(--fg-subtle)', fontSize:11,
  },
  pillBtn: {
    display:'inline-flex', alignItems:'center', gap:6,
    height: 26, padding:'0 10px',
    background:'var(--ink-1)', color:'var(--fg)',
    border:'1px solid var(--border)', borderRadius:'var(--r-pill)',
    font: 'inherit', fontSize:12, cursor:'pointer',
  },
  pillBtnActive: {
    background:'var(--accent)', color:'var(--ink-0)', borderColor:'var(--accent)',
  },
  label: { color:'var(--fg-subtle)', fontSize:12 },
  key: {
    display:'inline-flex', alignItems:'center', justifyContent:'center',
    minWidth:18, height: 18, padding:'0 5px',
    background:'var(--ink-2)', border:'1px solid var(--border)',
    borderBottomWidth: 2, borderRadius: 3,
    fontSize: 10, color:'var(--fg)', fontFamily:'inherit',
  },
};

/* ================================================================
   2 · ATLAS — cartography-style left sidebar
   ================================================================ */
function DesignAtlas() {
  const active = 1; // seahorse
  return (
    <div style={{ position:'absolute', inset:0, fontFamily:'var(--font-mono)', color:'var(--fg)' }}>
      <div style={fractal('renders/seahorse.png')} />
      <div style={vignette} />

      {/* LEFT SIDEBAR */}
      <div style={atl.sidebar}>
        <div style={{ padding: '24px 24px 16px' }}>
          <div style={{ fontFamily:'var(--font-sans)', fontWeight:700, fontSize:22, letterSpacing:'-0.02em' }}>Atlas</div>
          <div style={{ fontSize: 11, color:'var(--fg-subtle)', marginTop:4, letterSpacing:'0.12em', textTransform:'uppercase' }}>Mandelbrot · 6 places</div>
        </div>
        <div style={{ height:1, background:'var(--border)' }} />
        <div style={{ padding: '8px 12px', display:'flex', flexDirection:'column', gap:4 }}>
          {PLACES.map((p, i) => (
            <div key={p.id} style={{
              display:'flex', alignItems:'center', gap:10,
              padding: 8, borderRadius: 4,
              background: i===active ? 'var(--ink-2)' : 'transparent',
              borderLeft: i===active ? '2px solid var(--accent)' : '2px solid transparent',
            }}>
              <img src={p.thumb} style={{ width:56, height:36, objectFit:'cover', borderRadius:2, border:'1px solid var(--border)' }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:11, color:'var(--fg-subtle)' }}>0{i+1}</span>
                  <span style={{ fontSize:13, color: i===active ? 'var(--accent)' : 'var(--fg)' }}>{p.name}</span>
                </div>
                <div style={{ fontSize:10, color:'var(--fg-subtle)', marginTop:2, fontVariantNumeric:'tabular-nums' }}>
                  {p.re.toFixed(4)}, {p.im.toFixed(4)} · {p.z}
                </div>
              </div>
              <kbd style={cls.key}>{i+1}</kbd>
            </div>
          ))}
        </div>
        <div style={{ height:1, background:'var(--border)' }} />
        <div style={{ padding: 16, display:'flex', flexDirection:'column', gap:8 }}>
          <button style={atl.bigBtn}>
            <Icon.film width={14} height={14} />
            <span>record fly-through</span>
            <span style={{ marginLeft:'auto', color:'var(--fg-faint)', fontSize:10 }}>⌘R</span>
          </button>
          <button style={{ ...atl.bigBtn, color:'var(--fg-subtle)' }}>
            <Icon.shot width={14} height={14} />
            <span>screenshot</span>
            <span style={{ marginLeft:'auto', color:'var(--fg-faint)', fontSize:10 }}>⌘S</span>
          </button>
        </div>
      </div>

      {/* TOP — breadcrumb */}
      <div style={{ position:'absolute', top:24, left: 320, display:'flex', alignItems:'center', gap:8,
                    padding:'8px 14px', background:'rgba(10,10,10,0.72)', border:'1px solid var(--border)',
                    borderRadius:'var(--r-pill)', backdropFilter:'blur(6px)', fontSize:12 }}>
        <span style={{ color:'var(--fg-subtle)' }}>now viewing</span>
        <span style={{ color:'var(--fg-faint)' }}>/</span>
        <span style={{ color:'var(--accent)' }}>seahorse valley</span>
        <span style={{ color:'var(--fg-faint)' }}>·</span>
        <span style={{ color:'var(--fg-subtle)' }}>−0.7453, 0.1127</span>
        <span style={{ color:'var(--fg-faint)' }}>·</span>
        <span>110× zoom</span>
      </div>

      {/* MINIMAP — top right */}
      <div style={{ position:'absolute', top:24, right:24, width:160, padding:8,
                    background:'rgba(10,10,10,0.72)', border:'1px solid var(--border)', borderRadius:4 }}>
        <div style={{ fontSize:10, color:'var(--fg-subtle)', letterSpacing:'0.12em', textTransform:'uppercase', marginBottom:6 }}>minimap</div>
        <div style={{ position:'relative', width:'100%', aspectRatio:'1.6 / 1', borderRadius:2, overflow:'hidden', border:'1px solid var(--border)' }}>
          <img src="renders/whole.png" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
          {/* viewport rect approximating current position */}
          <div style={{ position:'absolute', left:'30%', top:'45%', width:6, height:6,
                        border:'1.5px solid var(--accent)', boxShadow:'0 0 8px var(--accent-glow)' }} />
        </div>
      </div>

      {/* BOTTOM RIGHT — zoom stack + record */}
      <div style={{ position:'absolute', right:24, bottom:24, display:'flex', flexDirection:'column', gap:6, alignItems:'flex-end' }}>
        <div style={atl.zoomStack}>
          <button style={atl.zoomBtn}><Icon.plus width={14} height={14} /></button>
          <div style={{ height:1, background:'var(--border)' }} />
          <div style={{ padding:'10px 0', textAlign:'center', fontSize:11, color:'var(--fg-subtle)', fontVariantNumeric:'tabular-nums' }}>110×</div>
          <div style={{ height:1, background:'var(--border)' }} />
          <button style={atl.zoomBtn}><Icon.minus width={14} height={14} /></button>
        </div>
        <button style={{ ...atl.zoomBtn, width:'auto', height:38, padding:'0 14px', display:'flex', alignItems:'center', gap:8,
                          background:'rgba(10,10,10,0.84)', color:'var(--glitch-red)', borderColor:'rgba(255,61,90,0.35)' }}>
          <Icon.rec width={10} height={10} /> rec
        </button>
      </div>
    </div>
  );
}

const atl = {
  sidebar: {
    position:'absolute', left:0, top:0, bottom:0, width: 296,
    background:'rgba(10,10,10,0.86)', backdropFilter:'blur(10px)',
    borderRight:'1px solid var(--border)',
    display:'flex', flexDirection:'column',
  },
  zoomStack: {
    width: 38, background:'rgba(10,10,10,0.84)', backdropFilter:'blur(6px)',
    border:'1px solid var(--border)', borderRadius: 6,
    overflow:'hidden',
  },
  zoomBtn: {
    width: '100%', height: 38, background:'transparent', color:'var(--fg)',
    border:'none', cursor:'pointer',
    display:'flex', alignItems:'center', justifyContent:'center',
  },
  bigBtn: {
    display:'flex', alignItems:'center', gap:8,
    width:'100%', padding:'10px 12px',
    background:'var(--ink-1)', border:'1px solid var(--border)', borderRadius: 4,
    color:'var(--fg)', font:'inherit', fontSize:12, cursor:'pointer',
  },
};

/* ================================================================
   3 · CONSOLE — terminal aesthetic, single floating card
   ================================================================ */
function DesignConsole() {
  return (
    <div style={{ position:'absolute', inset:0, fontFamily:'var(--font-mono)', color:'var(--fg)', background:'#000' }}>
      <div style={fractal('renders/spiral.png')} />
      <div style={scanlines} />

      {/* big crosshair / target */}
      <svg style={{ position:'absolute', left:'52%', top:'62%', transform:'translate(-50%,-50%)', overflow:'visible' }} width="120" height="120" viewBox="-60 -60 120 120">
        <circle cx="0" cy="0" r="28" fill="none" stroke="var(--accent)" strokeWidth="1" strokeDasharray="2 4" opacity="0.7"/>
        <circle cx="0" cy="0" r="3" fill="var(--accent)"/>
        <line x1="-56" y1="0" x2="-32" y2="0" stroke="var(--accent)" strokeWidth="1" opacity="0.7"/>
        <line x1="32"  y1="0" x2="56"  y2="0" stroke="var(--accent)" strokeWidth="1" opacity="0.7"/>
        <line x1="0" y1="-56" x2="0" y2="-32" stroke="var(--accent)" strokeWidth="1" opacity="0.7"/>
        <line x1="0" y1="32"  x2="0" y2="56"  stroke="var(--accent)" strokeWidth="1" opacity="0.7"/>
      </svg>

      {/* Console card — top-right */}
      <div style={{
        position:'absolute', top: 32, right: 32, width: 460,
        background:'rgba(8,12,8,0.88)', backdropFilter:'blur(8px)',
        border:'1px solid var(--accent-dim)',
        boxShadow:'0 0 0 1px rgba(124,255,107,0.18), 0 0 32px rgba(124,255,107,0.18)',
        color:'var(--accent)', fontSize:12, lineHeight: 1.6,
      }}>
        {/* title bar */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                       padding:'8px 14px', borderBottom:'1px solid rgba(124,255,107,0.22)' }}>
          <span style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--accent)', boxShadow:'0 0 6px var(--accent)' }} />
            mandelbrot.exe
          </span>
          <span style={{ color:'var(--fg-subtle)', fontSize:10 }}>session 0x4a · cpus 8</span>
        </div>

        <div style={{ padding:'12px 14px' }}>
          <div style={{ color:'var(--fg-subtle)' }}># view</div>
          <div>re = <span style={{ color:'var(--fg)' }}>−0.0880000</span></div>
          <div>im = <span style={{ color:'var(--fg)' }}>+0.6540000</span></div>
          <div>z  = <span style={{ color:'var(--fg)' }}>8.00e+02</span> <span style={{ color:'var(--fg-subtle)' }}>(deep)</span></div>
          <div>i  = <span style={{ color:'var(--fg)' }}>1280</span><span style={{ color:'var(--fg-subtle)' }}>/2048 · 84ms</span></div>

          <div style={{ height: 10 }} />
          <div style={{ color:'var(--fg-subtle)' }}># places</div>
          {PLACES.map((p, i) => (
            <div key={p.id} style={{
              display:'grid', gridTemplateColumns:'18px 1fr auto',
              color: i===2 ? 'var(--accent)' : 'var(--fg)', opacity: i===2 ? 1 : 0.85,
              padding:'1px 0',
            }}>
              <span style={{ color:'var(--fg-subtle)' }}>[{i+1}]</span>
              <span>{p.name}</span>
              <span style={{ color:'var(--fg-subtle)' }}>{p.z}</span>
            </div>
          ))}

          <div style={{ height: 10 }} />
          <div style={{ color:'var(--fg-subtle)' }}># commands</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', columnGap: 16, color:'var(--fg)' }}>
            <span><span style={{ color:'var(--fg-subtle)' }}>[space]</span> zoom in</span>
            <span><span style={{ color:'var(--fg-subtle)' }}>[⇧space]</span> zoom out</span>
            <span><span style={{ color:'var(--fg-subtle)' }}>[click]</span> recenter+in</span>
            <span><span style={{ color:'var(--fg-subtle)' }}>[h]</span> high quality</span>
            <span><span style={{ color:'var(--fg-subtle)' }}>[p]</span> cycle palette</span>
            <span><span style={{ color:'var(--fg-subtle)' }}>[r]</span> reset</span>
          </div>

          <div style={{ height: 12 }} />
          {/* prompt with blinking cursor */}
          <div>
            <span style={{ color:'var(--accent)' }}>$ </span>
            <span style={{ color:'var(--fg)' }}>rec --out=zoom.webm </span>
            <span style={{ display:'inline-block', width:7, height:14, background:'var(--accent)', verticalAlign:'-2px', animation:'cblink 1s steps(1) infinite' }} />
          </div>
          <div style={{ marginTop: 6, color:'var(--glitch-red)', display:'flex', alignItems:'center', gap:8 }}>
            <Icon.rec width={10} height={10} />
            REC 00:07 · 30fps · 1080p
          </div>
        </div>
      </div>

      {/* TOP LEFT wordmark */}
      <div style={{ position:'absolute', top: 32, left: 32, fontSize:11, color:'var(--accent)', letterSpacing:'0.12em', textTransform:'uppercase' }}>
        <span style={{ opacity:0.5 }}>calje //</span> mandelbrot console
      </div>

      <style>{`@keyframes cblink { 50% { opacity: 0; } }`}</style>
    </div>
  );
}

/* ================================================================
   4 · FILMSTRIP — image-forward, bottom strip of named places
   ================================================================ */
function DesignFilmstrip() {
  return (
    <div style={{ position:'absolute', inset:0, fontFamily:'var(--font-sans)', color:'var(--fg)' }}>
      <div style={fractal('renders/island.png')} />
      <div style={{ ...vignette, background:'linear-gradient(to top, rgba(0,0,0,0.5), transparent 40%)' }} />

      {/* TOP LEFT — location title */}
      <div style={{ position:'absolute', top: 36, left: 40 }}>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--fg-subtle)',
                       letterSpacing:'0.16em', textTransform:'uppercase', marginBottom:6 }}>
          place 05 / 06
        </div>
        <div style={{ fontFamily:'var(--font-sans)', fontWeight:700, fontSize:42, letterSpacing:'-0.02em', lineHeight: 1 }}>
          Julia Island
        </div>
        <div style={{ marginTop:8, fontFamily:'var(--font-mono)', fontSize:12, color:'var(--fg-muted)', fontVariantNumeric:'tabular-nums' }}>
          c = −0.1600 + 1.0405 i&nbsp; · &nbsp;30× zoom
        </div>
      </div>

      {/* TOP RIGHT — controls */}
      <div style={{ position:'absolute', top: 36, right: 40, display:'flex', alignItems:'center', gap: 10 }}>
        <button style={fs.roundBtn}><Icon.minus width={18} height={18} /></button>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--fg-subtle)', minWidth: 56, textAlign:'center' }}>30×</div>
        <button style={fs.roundBtn}><Icon.plus width={18} height={18} /></button>
        <div style={{ width:1, height:32, background:'var(--border)', margin:'0 4px' }} />
        <button style={fs.cta}>
          <Icon.rec width={11} height={11} />
          <span>Record Movie</span>
        </button>
      </div>

      {/* CENTER focus square */}
      <div style={{ position:'absolute', left:'50%', top:'48%', transform:'translate(-50%,-50%)',
                     width: 220, height: 140, border:'1px solid rgba(242,240,234,0.55)' }}>
        <div style={{ position:'absolute', top:-1, left:-1, width:12, height:12, borderTop:'2px solid white', borderLeft:'2px solid white' }} />
        <div style={{ position:'absolute', top:-1, right:-1, width:12, height:12, borderTop:'2px solid white', borderRight:'2px solid white' }} />
        <div style={{ position:'absolute', bottom:-1, left:-1, width:12, height:12, borderBottom:'2px solid white', borderLeft:'2px solid white' }} />
        <div style={{ position:'absolute', bottom:-1, right:-1, width:12, height:12, borderBottom:'2px solid white', borderRight:'2px solid white' }} />
      </div>

      {/* BOTTOM — filmstrip */}
      <div style={{ position:'absolute', left:0, right:0, bottom:0, padding:'20px 40px',
                     background:'linear-gradient(to top, rgba(0,0,0,0.7), transparent)' }}>
        <div style={{ display:'flex', alignItems:'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:11, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--fg-subtle)' }}>
            predefined views
          </span>
          <span style={{ flex:1, height:1, background:'rgba(242,240,234,0.18)' }} />
          <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--fg-subtle)' }}>← →</span>
        </div>
        <div style={{ display:'flex', gap: 12, overflow:'hidden' }}>
          {PLACES.map((p, i) => (
            <div key={p.id} style={{
              flex:'0 0 200px', cursor:'pointer',
              transform: i===4 ? 'translateY(-4px)' : 'none',
            }}>
              <div style={{
                position:'relative', width:'100%', height: 120,
                borderRadius: 4, overflow:'hidden',
                outline: i===4 ? '2px solid var(--accent)' : '1px solid rgba(242,240,234,0.18)',
                outlineOffset: i===4 ? 2 : 0,
              }}>
                <img src={p.thumb} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                {i===4 && <div style={{ position:'absolute', inset:0, background:'linear-gradient(to top, rgba(124,255,107,0.25), transparent 60%)' }} />}
              </div>
              <div style={{ marginTop: 8, display:'flex', alignItems:'baseline', gap:6 }}>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--fg-subtle)' }}>0{i+1}</span>
                <span style={{ fontFamily:'var(--font-sans)', fontWeight:600, fontSize:13, color: i===4 ? 'var(--accent)' : 'var(--fg)' }}>{p.name}</span>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--fg-subtle)', marginLeft:'auto' }}>{p.z}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const fs = {
  roundBtn: {
    width: 40, height: 40, borderRadius:'50%',
    background:'rgba(10,10,10,0.7)', backdropFilter:'blur(6px)',
    border:'1px solid rgba(242,240,234,0.35)',
    color:'var(--fg)', cursor:'pointer',
    display:'flex', alignItems:'center', justifyContent:'center',
  },
  cta: {
    display:'inline-flex', alignItems:'center', gap:8,
    height: 40, padding:'0 18px',
    background:'var(--glitch-red)', color:'white',
    border:'none', borderRadius:'var(--r-pill)',
    fontFamily:'var(--font-sans)', fontWeight:600, fontSize:13,
    cursor:'pointer',
    boxShadow:'0 6px 16px -6px rgba(255,61,90,0.55)',
  },
};

/* ================================================================
   5 · EDITORIAL — brutalist, typography-forward
   ================================================================ */
function DesignEditorial() {
  return (
    <div style={{ position:'absolute', inset:0, color:'var(--fg)' }}>
      <div style={fractal('renders/tendril.png')} />
      <div style={{ ...vignette, background:'linear-gradient(135deg, rgba(0,0,0,0.55), transparent 55%, rgba(0,0,0,0.35))' }} />

      {/* huge vertical wordmark */}
      <div style={{ position:'absolute', left: 56, top: 56, bottom: 56,
                     display:'flex', flexDirection:'column', justifyContent:'space-between' }}>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:11, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--fg-subtle)' }}>
          calje · field notes · 026
        </div>

        <div>
          <div style={{ fontFamily:'var(--font-sans)', fontWeight:700, fontSize: 124, lineHeight: 0.88,
                         letterSpacing:'-0.045em', color:'var(--paper-0)' }}>
            Mandel<br/>brot.
          </div>
          <div style={{ marginTop: 22, fontFamily:'var(--font-mono)', fontSize:13, color:'var(--fg-muted)', maxWidth: 460 }}>
            An interactive descent into the boundary of the set.
            Click to dive · shift-click to surface · six saved places.
          </div>
          <div style={{ marginTop: 22, display:'flex', alignItems:'center', gap: 14 }}>
            <button style={ed.recBtn}>
              <Icon.rec width={12} height={12} />
              <span>record zoom</span>
            </button>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--fg-subtle)' }}>
              <kbd style={cls.key}>⌘R</kbd> &nbsp; or hold space to fly
            </div>
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap: 14, fontFamily:'var(--font-mono)', fontSize:12 }}>
          <span style={{ color:'var(--fg-subtle)' }}>c =</span>
          <span style={{ color:'var(--paper-0)', fontVariantNumeric:'tabular-nums' }}>−1.250660 + 0.020120i</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <span style={{ color:'var(--fg-subtle)' }}>z</span>
          <span style={{ color:'var(--paper-0)' }}>250×</span>
          <span style={{ color:'var(--fg-faint)' }}>·</span>
          <span style={{ color:'var(--fg-subtle)' }}>iter</span>
          <span style={{ color:'var(--paper-0)' }}>1200</span>
        </div>
      </div>

      {/* right edge — places index */}
      <div style={{ position:'absolute', top: 56, right: 56, width: 340 }}>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom: 16 }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:11, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--fg-subtle)' }}>
            index
          </span>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--fg-subtle)' }}>06 places</span>
        </div>
        <div style={{ borderTop:'1px solid rgba(242,240,234,0.35)' }} />
        {PLACES.map((p, i) => (
          <div key={p.id} style={{
            display:'grid', gridTemplateColumns:'34px 1fr auto',
            alignItems:'center', gap: 10,
            padding: '14px 0',
            borderBottom:'1px solid rgba(242,240,234,0.16)',
            color: i===5 ? 'var(--paper-0)' : 'rgba(242,240,234,0.78)',
          }}>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--fg-subtle)' }}>0{i+1}</span>
            <span style={{ fontFamily:'var(--font-sans)', fontWeight: i===5 ? 700 : 500, fontSize: 18, letterSpacing:'-0.01em' }}>
              {p.name}
            </span>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--fg-subtle)' }}>{p.z}</span>
          </div>
        ))}

        {/* zoom controls bottom right */}
        <div style={{ marginTop: 32, display:'flex', alignItems:'center', gap: 8, justifyContent:'flex-end' }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--fg-subtle)', marginRight: 8 }}>zoom</span>
          <button style={ed.iconBtn}><Icon.minus width={16} height={16} /></button>
          <button style={ed.iconBtn}><Icon.plus  width={16} height={16} /></button>
          <button style={ed.iconBtn}><Icon.reset width={16} height={16} /></button>
        </div>
      </div>
    </div>
  );
}

const ed = {
  recBtn: {
    display:'inline-flex', alignItems:'center', gap:10,
    height: 44, padding:'0 22px',
    background:'var(--paper-0)', color:'var(--ink-0)',
    border:'none', borderRadius: 0,
    fontFamily:'var(--font-sans)', fontWeight:700, fontSize:14,
    letterSpacing:'-0.01em', cursor:'pointer',
  },
  iconBtn: {
    width: 36, height: 36, borderRadius: 0,
    background:'transparent', color:'var(--paper-0)',
    border:'1px solid rgba(242,240,234,0.45)',
    cursor:'pointer',
    display:'inline-flex', alignItems:'center', justifyContent:'center',
  },
};

/* ================================================================
   RECORD DIALOG — 3 variations
   Artboard 960 × 720 each. Dialog centered over dimmed fractal.
   ================================================================ */

const dialogBg = (src) => (
  <>
    <div style={{ ...fractal(src), filter:'blur(3px) brightness(0.65)' }} />
    <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.45)' }} />
  </>
);

/* ---- shared dialog primitives ---- */
const dlg = {
  card: {
    position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
    width: 520,
    background:'rgba(18,18,18,0.96)', backdropFilter:'blur(8px)',
    border:'1px solid var(--ink-3)', borderRadius: 12,
    boxShadow:'0 24px 64px -20px rgba(0,0,0,0.65), 0 0 0 1px rgba(0,0,0,0.5)',
    color:'var(--fg)', fontFamily:'var(--font-mono)', fontSize: 13,
    padding: '22px 26px 20px',
  },
  title: { fontSize: 15, fontWeight: 700, marginBottom: 18, letterSpacing:'-0.01em' },
  row: { display:'grid', gridTemplateColumns:'130px 1fr', alignItems:'center', columnGap:18, marginBottom: 10 },
  label: { color:'var(--fg-subtle)', fontSize: 13 },
  input: {
    width:'100%', height: 34,
    background:'var(--ink-1)', color:'var(--fg)',
    border:'1px solid var(--border)', borderRadius: 4,
    padding:'0 12px', font:'inherit', fontSize: 13,
    fontVariantNumeric:'tabular-nums', boxSizing:'border-box',
  },
  hr: { height: 1, background:'var(--border)', margin:'14px 0' },
  btn: {
    height: 36, padding:'0 18px',
    background:'var(--ink-1)', color:'var(--fg)',
    border:'1px solid var(--border)', borderRadius: 4,
    font:'inherit', fontSize: 13, cursor:'pointer',
  },
  btnPrimary: {
    height: 36, padding:'0 22px',
    background:'var(--accent)', color:'var(--ink-0)',
    border:'1px solid var(--accent)', borderRadius: 4,
    font:'inherit', fontSize: 13, fontWeight: 700, cursor:'pointer',
  },
  radio: (active) => ({
    width: 16, height: 16, borderRadius:'50%',
    border:`2px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}`,
    background: 'transparent',
    display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0,
  }),
  radioDot: { width: 8, height: 8, borderRadius:'50%', background:'var(--accent)' },
  check: (on) => ({
    width: 16, height: 16, borderRadius: 3,
    border:`1.5px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
    background: on ? 'var(--accent)' : 'transparent',
    display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0,
  }),
};

const Tick = (p) => (
  <svg {...p} viewBox="0 0 12 12" fill="none">
    <path d="M2.5 6.3 4.7 8.5 9.5 3.5" stroke="var(--ink-0)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

/* ---------- A · Canonical (matches user's reference) ---------- */
function RecordDialogCanonical() {
  return (
    <div style={{ position:'absolute', inset:0 }}>
      {dialogBg('renders/elephant.png')}
      <div style={dlg.card}>
        <div style={dlg.title}>Record</div>

        <div style={dlg.row}>
          <span style={dlg.label}>duration (s)</span>
          <input style={{ ...dlg.input, maxWidth: 180 }} defaultValue="15" />
        </div>
        <div style={dlg.row}>
          <span style={dlg.label}>fps</span>
          <input style={{ ...dlg.input, maxWidth: 180 }} defaultValue="60" />
        </div>
        <div style={dlg.row}>
          <span style={dlg.label}>zoom ×/s</span>
          <input style={{ ...dlg.input, maxWidth: 180 }} defaultValue="6" />
        </div>

        <div style={dlg.hr} />

        <div style={{ display:'flex', alignItems:'center', gap: 14, marginBottom: 14 }}>
          <span style={dlg.label}>renderer</span>
          <label style={{ display:'inline-flex', alignItems:'center', gap:6, cursor:'pointer' }}>
            <span style={dlg.radio(true)}><span style={dlg.radioDot} /></span>
            <span style={{ color:'var(--accent)' }}>auto</span>
          </label>
          <label style={{ display:'inline-flex', alignItems:'center', gap:6, cursor:'pointer' }}>
            <span style={dlg.radio(false)} />
            <span style={{ color:'var(--fg-muted)' }}>GPU</span>
          </label>
          <label style={{ display:'inline-flex', alignItems:'center', gap:6, cursor:'pointer' }}>
            <span style={dlg.radio(false)} />
            <span style={{ color:'var(--fg-muted)' }}>CPU</span>
          </label>
          <span style={{ marginLeft:'auto', color:'var(--fg-subtle)', fontSize:11 }}>auto = CPU past 10²⁰ zoom</span>
        </div>

        <div style={dlg.hr} />

        <label style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 0', cursor:'pointer' }}>
          <span style={dlg.check(true)}><Tick width={11} height={11} /></span>
          <span style={{ color:'var(--fg)' }}>browser</span>
          <span style={{ marginLeft:'auto', color:'var(--fg-subtle)', fontSize:11 }}>local · H.264 via WebCodecs</span>
        </label>

        <div style={{ display:'flex', justifyContent:'flex-end', gap: 10, marginTop: 22 }}>
          <button style={dlg.btn}>cancel</button>
          <button style={dlg.btnPrimary}>start</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- B · Sliders + summary ---------- */
function RecordDialogSliders() {
  const sliderRow = (label, val, unit, frac) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom: 6 }}>
        <span style={dlg.label}>{label}</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric:'tabular-nums' }}>
          {val}<span style={{ color:'var(--fg-subtle)', fontWeight:400, fontSize: 12, marginLeft: 4 }}>{unit}</span>
        </span>
      </div>
      <div style={{ position:'relative', height: 6, background:'var(--ink-1)', borderRadius: 3 }}>
        <div style={{ position:'absolute', left:0, top:0, bottom:0, width: `${frac*100}%`, background:'var(--accent)', borderRadius: 3 }} />
        <div style={{ position:'absolute', left:`${frac*100}%`, top:'50%', transform:'translate(-50%,-50%)',
                       width: 14, height: 14, background:'var(--paper-0)', borderRadius:'50%',
                       boxShadow:'0 0 0 1px var(--ink-0), 0 2px 4px rgba(0,0,0,0.4)' }} />
      </div>
    </div>
  );
  return (
    <div style={{ position:'absolute', inset:0 }}>
      {dialogBg('renders/seahorse.png')}
      <div style={{ ...dlg.card, width: 560 }}>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom: 18 }}>
          <div style={dlg.title}>Record</div>
          <div style={{ fontSize: 11, color:'var(--fg-subtle)', letterSpacing:'0.12em', textTransform:'uppercase' }}>seahorse valley · 110×</div>
        </div>

        {sliderRow('duration', '15', 's', 0.30)}
        {sliderRow('fps', '60', 'frames/sec', 0.66)}
        {sliderRow('zoom rate', '6', '×/sec', 0.40)}

        <div style={dlg.hr} />

        <div style={{ display:'flex', alignItems:'center', gap: 12, marginBottom: 12 }}>
          <span style={dlg.label}>renderer</span>
          <div style={{ display:'flex', background:'var(--ink-1)', border:'1px solid var(--border)', borderRadius:'var(--r-pill)', padding: 2 }}>
            <button style={{ ...dlg.btn, height: 26, padding:'0 14px', background:'var(--accent)', color:'var(--ink-0)', borderColor:'var(--accent)', borderRadius:'var(--r-pill)' }}>auto</button>
            <button style={{ ...dlg.btn, height: 26, padding:'0 14px', background:'transparent', borderColor:'transparent', borderRadius:'var(--r-pill)', color:'var(--fg-muted)' }}>GPU</button>
            <button style={{ ...dlg.btn, height: 26, padding:'0 14px', background:'transparent', borderColor:'transparent', borderRadius:'var(--r-pill)', color:'var(--fg-muted)' }}>CPU</button>
          </div>
          <span style={{ marginLeft:'auto', color:'var(--fg-subtle)', fontSize: 11 }}>↓ falls back at 10²⁰ zoom</span>
        </div>

        {/* summary chip */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap: 10, marginTop: 12 }}>
          <div style={dlg2.stat}>
            <div style={dlg2.statLabel}>frames</div>
            <div style={dlg2.statValue}>900</div>
          </div>
          <div style={dlg2.stat}>
            <div style={dlg2.statLabel}>final zoom</div>
            <div style={dlg2.statValue}>7.2 × 10¹¹</div>
          </div>
          <div style={dlg2.stat}>
            <div style={dlg2.statLabel}>~ size</div>
            <div style={dlg2.statValue}>34 MB</div>
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop: 18 }}>
          <span style={{ color:'var(--fg-subtle)', fontSize: 11 }}>output · mandelbrot_2026-05-24.webm</span>
          <div style={{ display:'flex', gap: 10 }}>
            <button style={dlg.btn}>cancel</button>
            <button style={{ ...dlg.btnPrimary, display:'inline-flex', alignItems:'center', gap: 8 }}>
              <Icon.rec width={10} height={10} /> start
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const dlg2 = {
  stat: {
    padding: '10px 12px',
    background:'var(--ink-1)',
    border:'1px solid var(--border)', borderRadius: 4,
  },
  statLabel: { fontSize: 10, color:'var(--fg-subtle)', letterSpacing:'0.12em', textTransform:'uppercase' },
  statValue: { fontSize: 16, fontWeight: 700, marginTop: 4, fontVariantNumeric:'tabular-nums' },
};

/* ---------- C · Editorial / paper card ---------- */
function RecordDialogEditorial() {
  return (
    <div style={{ position:'absolute', inset:0 }}>
      {dialogBg('renders/tendril.png')}
      <div style={{ position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
                     width: 540, background:'var(--paper-0)', color:'var(--ink-0)',
                     padding: '28px 32px',
                     boxShadow:'0 30px 70px -20px rgba(0,0,0,0.7)',
                     fontFamily:'var(--font-sans)' }}>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 28, letterSpacing:'-0.02em' }}>Record zoom.</div>
          <span style={{ fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--paper-3)', letterSpacing:'0.12em', textTransform:'uppercase' }}>step 1 of 1</span>
        </div>

        {[
          { label: 'duration', value: '15', unit: 'seconds' },
          { label: 'fps',      value: '60', unit: 'frames/sec' },
          { label: 'zoom rate',value: '6',  unit: '× per sec' },
        ].map((f) => (
          <div key={f.label} style={{
            display:'grid', gridTemplateColumns:'140px 1fr',
            alignItems:'baseline', gap: 12,
            padding:'14px 0', borderBottom:'1px solid var(--paper-1)',
          }}>
            <span style={{ fontFamily:'var(--font-mono)', fontSize: 12, color:'var(--paper-3)', letterSpacing:'0.04em' }}>{f.label}</span>
            <div style={{ display:'flex', alignItems:'baseline', gap: 8 }}>
              <span style={{ fontFamily:'var(--font-sans)', fontSize: 30, fontWeight: 700, letterSpacing:'-0.02em', fontVariantNumeric:'tabular-nums' }}>{f.value}</span>
              <span style={{ fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--paper-3)' }}>{f.unit}</span>
              <span style={{ marginLeft:'auto', fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--paper-2)' }}>−  +</span>
            </div>
          </div>
        ))}

        <div style={{
          display:'flex', alignItems:'center', gap: 12,
          padding:'14px 0', borderBottom:'1px solid var(--paper-1)',
        }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize: 12, color:'var(--paper-3)', width: 140 }}>renderer</span>
          <span style={{ fontFamily:'var(--font-mono)', fontSize: 12 }}>auto</span>
          <span style={{ fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--paper-2)' }}>· GPU · CPU</span>
          <span style={{ marginLeft:'auto', fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--paper-3)' }}>browser, H.264</span>
        </div>

        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop: 22 }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--paper-3)' }}>
            900 frames · ~34 MB · final z ≈ 7.2e11
          </span>
          <div style={{ display:'flex', gap: 0 }}>
            <button style={{ height: 44, padding:'0 22px', background:'transparent', color:'var(--ink-0)',
                              border:'1px solid var(--ink-0)', borderRight:'none',
                              fontFamily:'var(--font-sans)', fontWeight: 600, fontSize: 13, cursor:'pointer' }}>
              cancel
            </button>
            <button style={{ height: 44, padding:'0 26px',
                              background:'var(--ink-0)', color:'var(--paper-0)',
                              border:'1px solid var(--ink-0)',
                              fontFamily:'var(--font-sans)', fontWeight: 700, fontSize: 13, cursor:'pointer',
                              display:'inline-flex', alignItems:'center', gap: 10 }}>
              <span style={{ width: 10, height: 10, borderRadius:'50%', background:'var(--glitch-red)' }} />
              Start recording
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   CANVAS ASSEMBLY
   ================================================================ */
function App() {
  return (
    <DesignCanvas>
      <DCSection id="desktop" title="Desktop · 1440 × 900">
        <DCArtboard id="classic"   label="01 · Classic — minimal HUD"     width={1440} height={900}><DesignClassic /></DCArtboard>
        <DCArtboard id="atlas"     label="02 · Atlas — sidebar of places" width={1440} height={900}><DesignAtlas /></DCArtboard>
        <DCArtboard id="console"   label="03 · Console — terminal HUD"    width={1440} height={900}><DesignConsole /></DCArtboard>
        <DCArtboard id="filmstrip" label="04 · Filmstrip — image-forward" width={1440} height={900}><DesignFilmstrip /></DCArtboard>
        <DCArtboard id="editorial" label="05 · Editorial — typographic"   width={1440} height={900}><DesignEditorial /></DCArtboard>
      </DCSection>
      <DCSection id="record-dialog" title="Record dialog · variations">
        <DCArtboard id="rec-canonical" label="A · Canonical (matches reference)" width={960} height={720}><RecordDialogCanonical /></DCArtboard>
        <DCArtboard id="rec-sliders"   label="B · Sliders + output summary"     width={960} height={720}><RecordDialogSliders /></DCArtboard>
        <DCArtboard id="rec-editorial" label="C · Editorial — paper card"        width={960} height={720}><RecordDialogEditorial /></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
