{/*
  STRUCTURAL CONTRACT v1 — 3 direct children
  Labels: "Outlier Analysis", "SYMPH-145", "Refactor webhook handler", "HSUI-34", "Add settings page state machine"
  Pattern: 5 siblings × 2 children each at depth 3
  PRESERVE: all children, all labels, all repeating groups
*/}
(
    <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', fontSynthesis: 'none', gap: '16px', MozOsxFontSmoothing: 'grayscale', paddingBlock: '32px', paddingInline: '64px', WebkitFontSmoothing: 'antialiased', width: '1440px' }}>
      <div style={{ boxSizing: 'border-box', color: '#FFFFFF59', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', lineHeight: '14px', textTransform: 'uppercase' }}>
        Outlier Analysis
      </div>
      <div style={{ backgroundColor: '#FFFFFF08', borderColor: '#FFFFFF0F', borderRadius: '12px', borderStyle: 'solid', borderWidth: '1px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '16px', paddingBlock: '24px', paddingInline: '24px', width: '1312px' }}>
        <div style={{ alignItems: 'center', boxSizing: 'border-box', display: 'flex', gap: '12px' }}>
          <div style={{ boxSizing: 'border-box', color: '#60A5FA', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', fontWeight: 600, lineHeight: '16px' }}>
            SYMPH-145
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFFB3', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '14px', lineHeight: '18px' }}>
            Refactor webhook handler
          </div>
          <div style={{ backgroundColor: '#EF44441F', borderRadius: '4px', boxSizing: 'border-box', paddingBlock: '2px', paddingInline: '8px' }}>
            <div style={{ boxSizing: 'border-box', color: '#EF4444', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '10px', fontWeight: 600, lineHeight: '12px' }}>
              3.2x avg
            </div>
          </div>
        </div>
        <div style={{ boxSizing: 'border-box', display: 'flex', gap: '32px' }}>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Investigate
            </div>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF99', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              18,200
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Implement
            </div>
            <div style={{ boxSizing: 'border-box', color: '#F59E0B', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              89,400
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Review
            </div>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF99', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              15,200
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Merge
            </div>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF99', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              4,650
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Total
            </div>
            <div style={{ boxSizing: 'border-box', color: '#F0F0F2', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', fontWeight: 600, lineHeight: '16px' }}>
              127,450
            </div>
          </div>
        </div>
        <div style={{ backgroundColor: '#FFFFFF05', borderRadius: '8px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px', paddingBlock: '12px', paddingInline: '16px' }}>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em', lineHeight: '12px', textTransform: 'uppercase' }}>
            Hypothesis
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF8C', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '13px', lineHeight: 'round(up, 150%, 1px)' }}>
            Parent spec COMPLEX — 5 tasks, touches webhook handler + retry subsystem + API routes. Implement 3.2x avg driven by cross-subsystem scope requiring coordinated changes across 12 files.
          </div>
        </div>
      </div>
      <div style={{ backgroundColor: '#FFFFFF08', borderColor: '#FFFFFF0F', borderRadius: '12px', borderStyle: 'solid', borderWidth: '1px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '16px', paddingBlock: '24px', paddingInline: '24px', width: '1312px' }}>
        <div style={{ alignItems: 'center', boxSizing: 'border-box', display: 'flex', gap: '12px' }}>
          <div style={{ boxSizing: 'border-box', color: '#60A5FA', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', fontWeight: 600, lineHeight: '16px' }}>
            HSUI-34
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFFB3', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '14px', lineHeight: '18px' }}>
            Add settings page state machine
          </div>
          <div style={{ backgroundColor: '#F59E0B1F', borderRadius: '4px', boxSizing: 'border-box', paddingBlock: '2px', paddingInline: '8px' }}>
            <div style={{ boxSizing: 'border-box', color: '#F59E0B', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '10px', fontWeight: 600, lineHeight: '12px' }}>
              4.1x avg
            </div>
          </div>
        </div>
        <div style={{ boxSizing: 'border-box', display: 'flex', gap: '32px' }}>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Investigate
            </div>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF99', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              12,800
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Implement
            </div>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF99', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              22,400
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Review
            </div>
            <div style={{ boxSizing: 'border-box', color: '#A78BFA', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              28,300
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Merge
            </div>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF99', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', lineHeight: '16px' }}>
              3,700
            </div>
          </div>
          <div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', lineHeight: '12px' }}>
              Total
            </div>
            <div style={{ boxSizing: 'border-box', color: '#F0F0F2', fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '13px', fontWeight: 600, lineHeight: '16px' }}>
              67,200
            </div>
          </div>
        </div>
        <div style={{ backgroundColor: '#FFFFFF05', borderRadius: '8px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '4px', paddingBlock: '12px', paddingInline: '16px' }}>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF4D', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em', lineHeight: '12px', textTransform: 'uppercase' }}>
            Hypothesis
          </div>
          <div style={{ boxSizing: 'border-box', color: '#FFFFFF8C', fontFamily: '"DM Sans", system-ui, sans-serif', fontSize: '13px', lineHeight: 'round(up, 150%, 1px)' }}>
            Parent spec STANDARD — 6 Gherkin scenarios with UI state machines. Review 4.1x avg — adversarial review explored many edge cases in state transition logic.
          </div>
        </div>
      </div>
    </div>
  )