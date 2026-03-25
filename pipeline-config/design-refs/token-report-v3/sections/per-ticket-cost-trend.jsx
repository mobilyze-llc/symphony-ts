{/*
  STRUCTURAL CONTRACT v1 — 2 direct children
  Labels: "Per-Ticket Cost Trend", "30-day rolling median total tokens per ticket"
  PRESERVE: all children, all labels, all repeating groups
*/}
(
    <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', fontSize: '12px', fontSynthesis: 'none', gap: '16px', lineHeight: '16px', MozOsxFontSmoothing: 'grayscale', paddingBlock: '32px', paddingInline: '64px', WebkitFontSmoothing: 'antialiased', width: '1440px' }}>
      <div style={{ alignItems: 'baseline', boxSizing: 'border-box', display: 'flex', gap: '12px' }}>
        <div style={{ boxSizing: 'border-box', color: '#FFFFFF59', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', lineHeight: '14px', textTransform: 'uppercase' }}>
          Per-Ticket Cost Trend
        </div>
        <div style={{ boxSizing: 'border-box', color: '#FFFFFF33', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '11px', lineHeight: '14px' }}>
          30-day rolling median total tokens per ticket
        </div>
      </div>
      <div style={{ backgroundColor: '#FFFFFF05', borderColor: '#FFFFFF0F', borderRadius: '12px', borderStyle: 'solid', borderWidth: '1px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '8px', paddingBlock: '20px', paddingInline: '24px', width: '1312px' }}>
        <div style={{ boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF33', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
            60K
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF33', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
            tokens/ticket
          </div>
        </div>
        <svg width="1260" height="140" viewBox="0 0 1260 140">
          <line x1="0" y1="35" x2="1260" y2="35" stroke="#FFFFFF0A" />
          <line x1="0" y1="70" x2="1260" y2="70" stroke="#FFFFFF0A" />
          <line x1="0" y1="105" x2="1260" y2="105" stroke="#FFFFFF0A" />
          <polygon points="0,52 42,54 84,50 126,48 168,52 210,56 252,58 294,55 336,50 378,48 420,52 462,58 504,62 546,65 588,70 630,75 672,78 714,82 756,80 798,76 840,72 882,68 924,65 966,70 1008,75 1050,78 1092,82 1134,85 1176,88 1218,90 1260,92 1260,140 0,140" fill="#60A5FA0F" />
          <polyline points="0,52 42,54 84,50 126,48 168,52 210,56 252,58 294,55 336,50 378,48 420,52 462,58 504,62 546,65 588,70 630,75 672,78 714,82 756,80 798,76 840,72 882,68 924,65 966,70 1008,75 1050,78 1092,82 1134,85 1176,88 1218,90 1260,92" fill="none" stroke="#60A5FA" strokeWidth="2" strokeLinecap="round" />
          <circle cx="1260" cy="92" r="4" fill="#60A5FA" />
        </svg>
        <div style={{ boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF33', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
            Feb 23
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF33', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
            Mar 9
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF33', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
            Mar 24
          </div>
        </div>
        <div style={{ boxSizing: 'border-box', display: 'flex', gap: '24px', paddingTop: '4px' }}>
          <div style={{ boxSizing: 'border-box', color: '#60A5FA', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '11px', lineHeight: '14px' }}>
            Median: 38.9K/ticket
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF40', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '11px', lineHeight: '14px' }}>
            Mean: 42.8K
          </div>
          <div style={{ boxSizing: 'border-box', color: '#34D399', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '11px', lineHeight: '14px' }}>
            -12.1% WoW
          </div>
        </div>
      </div>
    </div>
  )